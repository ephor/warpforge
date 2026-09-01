//! The daemon actor: a single tokio task that owns all runtime state (projects,
//! dev servers, port-forwards, agent PTYs, tasks) and is the sole mutator of it.
//!
//! Clients (the TUI, the WebSocket server) never touch the managers directly —
//! they send [`Command`]s in and consume [`Event`]s out. This is the
//! daemon/client boundary the pivot is about: because every observer is on the
//! same event stream, there is no "primary" UI, and nothing assumes a single
//! consumer.
//!
//! The internal [`Event`] here is intentionally *not* the serializable wire type
//!(`warpforge_protocol::Event`): in-process it can carry rich handles like the
//! live vt100 parser. A thin translation to the wire type lives in the socket
//! server (`crate::daemon::server`).
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc};

use warpforge_protocol as wire;

use crate::agent::AgentManager;
use crate::portforward::PortForwardManager;
use crate::registry::ProjectEntry;
use crate::service::ServiceManager;

use crate::daemon::acp::AcpHandle;
use crate::daemon::acp::{AcpUpdate, PolicyCheck};
use crate::daemon::actor::config_observer::ConfigObserver;
use crate::daemon::actor::lifecycle::PendingPermissions;
use crate::daemon::actor::transcript::PendingResume;
use crate::daemon::actor::transcript::PendingSessionStart;
use crate::daemon::actor::transcript::ResumeReplayGuard;
use crate::daemon::store::Store;
use crate::daemon::task::Task;
use crate::daemon::workflow::WorkflowRun;
use crate::daemon::worktree::WorktreeManager;
use crate::policies::registry::PolicyRegistry;

mod accounts;
mod acp_update;
mod command;
mod config_observer;
mod event;
mod lifecycle;
mod output;
mod policy;
mod ports;
mod project;
mod prompt;
mod run;
mod session;
mod spawn;
mod transcript;
mod workflow;
mod workflow_control;
mod workflow_review;
mod workflow_stage;

pub(crate) mod commands;
mod handle;
mod handle_git;
mod handle_memory;
mod handle_task;
mod handle_tracker;

#[cfg(test)]
mod tests;

pub use command::Command;
pub use event::{ChildResult, Event, GitEffect, ProjectRemovalError};
pub use handle::DaemonHandle;

pub struct Daemon {
    projects: Vec<ProjectEntry>,
    /// Resolved port ranges per project name (ADR 0006). Rebuilt by
    /// `recompute_port_ranges`; consult via `port_range_for` /
    /// `port_conflict_for` rather than deriving ranges anywhere else.
    port_ranges: HashMap<String, crate::ports::ResolvedRange>,
    /// Where resolved sticky ranges are persisted. Test builds inject a
    /// memory sink so `cargo test` can never write `~/.warpforge/projects.json`.
    port_range_sink: ports::PortRangeSink,
    /// Registry entries that predate stored port ranges, captured once at
    /// daemon boot. Only these get the one-time positional migration in
    /// `recompute_port_ranges`; everything registered afterwards gets a fresh
    /// scan from 4000 (ADR 0006 invariant 2 — never an index-derived range).
    positional_migration: std::collections::HashSet<String>,
    config_observer: ConfigObserver,
    tasks: HashMap<String, Task>,
    agent_limits: Vec<warpforge_protocol::AgentAccountLimits>,
    /// Enabled ACP agent configurations (from SQLite, user-managed).
    configured_agents: Vec<wire::AgentConfig>,
    /// Live agent sessions keyed by task id. One per task in v1; the map (not a
    /// field on Task) is what keeps multi-session-per-task additive later.
    sessions: HashMap<String, AcpHandle>,
    /// Unresolved permission requests per task. Used for settle/snooze validation.
    pending_permissions: PendingPermissions,
    agents: AgentManager,
    services: ServiceManager,
    portforwards: PortForwardManager,
    /// Language-server proxy: spawns and tunnels LSP servers per workspace.
    lsp: crate::daemon::lsp::LspManager,
    event_tx: broadcast::Sender<Event>,
    acp_tx: mpsc::UnboundedSender<(String, AcpUpdate)>,
    /// Sender back to this actor's command channel — used so background tasks
    /// (e.g. the ACP probe) can deliver results without needing a borrow of the
    /// actor. Held alongside `store` etc. as a primary mutator handle.
    cmd_tx: mpsc::Sender<Command>,
    /// Queued writes, applied off the actor thread. Every mutation goes here —
    /// calling `store` directly from a handler puts a blocking disk write back
    /// on the hot path (ADR 0002).
    persist: crate::daemon::runtime::Persist,
    /// Shared with the persistence thread, for the reads that still run on the
    /// actor. Those move to an in-memory projection next; until then, use
    /// [`Daemon::with_store`] rather than locking at the call site.
    store: Option<Arc<Mutex<Store>>>,
    /// `session/load` may replay already persisted ACP updates. While the
    /// replay matches local history in order, drop it; the first mismatch is
    /// new live output and disables the guard.
    resume_replay: HashMap<String, ResumeReplayGuard>,
    /// Per-project git worktree managers, lazily created on first worktree use.
    worktrees: HashMap<String, WorktreeManager>,
    /// Sessions waiting on a worktree checkout, keyed by task id. Presence is
    /// the token that lets a finished checkout start its session: cancel and
    /// delete remove the entry, so a late checkout cannot resurrect the task.
    pending_session_starts: HashMap<String, PendingSessionStart>,
    /// Policy engine: gates agent actions through configurable policies.
    policies: PolicyRegistry,
    /// Channel for ACP reader tasks to request policy checks before file ops.
    policy_tx: mpsc::UnboundedSender<PolicyCheck>,
    /// Orchestrator: drives planner→worker→reviewer pipeline.
    orch_tx: Option<mpsc::Sender<crate::orchestration::OrchCommand>>,
    /// Receiver for orchestrator events (forwarded to broadcast).
    orch_event_rx: Option<broadcast::Receiver<crate::orchestration::OrchEvent>>,
    /// Orchestrator configuration (loaded from ~/.warpforge/orchestrator.yaml).
    orch_config: crate::orchestration::config::OrchestratorConfig,
    /// Per-orchestrator-task inbox of finished sub-agent results, keyed by the
    /// parent (orchestrator) task id. Drained by the `read_inbox` MCP tool.
    orchestrator_inbox: HashMap<String, Vec<ChildResult>>,
    /// Orchestrator tasks with results that arrived mid-turn: wake them once
    /// their current turn ends (deferred so a fan-out of N completions yields
    /// one wake, and an ignored wake never re-fires into a loop).
    pending_wake: std::collections::HashSet<String>,
    /// Stable first-seen timestamps for streamed frames of the same tool call.
    tool_call_starts: HashMap<(String, String), u64>,
    /// The last session update emitted per task — all `emit_session_unless_last_duplicate`
    /// needs to catch a reconnect retry or a repeated usage frame. O(1) per task,
    /// never the whole transcript.
    last_session_update: HashMap<String, wire::SessionUpdate>,
    /// Updates emitted since the task's last user message (its current turn).
    /// Reset on each new user message, so this is bounded by a turn, not by the
    /// session's length. Serves the workflow engine's stage-text reads, which
    /// used to fold the entire in-memory transcript.
    turn_updates: HashMap<String, Vec<wire::SessionUpdate>>,
    /// A session that cannot start until its resume replay guard has been read
    /// from the store (off the loop). Presence is the token that lets the loaded
    /// guard start the session: cancel and delete remove the entry, so a late
    /// load cannot resurrect the task (ADR 0002 invariant 5).
    pending_resume: HashMap<String, PendingResume>,
    /// Deterministic workflow pipelines keyed by parent task id. Finished runs
    /// stay in the map so their state remains visible on the board.
    workflow_runs: HashMap<String, WorkflowRun>,
    /// Registered agent accounts, mirroring the `agent_accounts` table.
    accounts: Vec<crate::daemon::store::StoredAccount>,
    /// Filing cabinet for the token rotations the agent CLIs perform. Shared
    /// because unattended captures run off the actor loop (file reads, and a
    /// keychain subprocess on macOS) while an account switch drives the same
    /// state from on it.
    credential_capture: Arc<Mutex<crate::daemon::credential_capture::CredentialCapture>>,
    /// When credentials were last looked at, so the per-turn trigger does not
    /// re-read the keychain for every task that finishes a turn.
    last_credential_capture: Option<std::time::Instant>,
    /// Shared memory store (separate `~/.warpforge/memory.db`), owned here so
    /// all memory ops run on the actor thread against one connection.
    memory: crate::daemon::memory::MemoryStore,
    last_memory_activity: Arc<Mutex<std::time::Instant>>,
    spend_cache: Option<(Vec<wire::AgentSpend>, std::time::Instant)>,
    /// Automations with a run in flight: automation id → run id. Presence is
    /// the overlap guard — a due automation whose previous run has not finished
    /// is skipped rather than stacked.
    /// Automations, loaded at spawn and kept in memory. The store write is a
    /// write-behind queue, so anything that reads an automation right after
    /// writing it (run-now, the tick, run bookkeeping) must read this mirror,
    /// not the store.
    automations: HashMap<String, wire::Automation>,
    automation_active: HashMap<String, String>,
    /// Which automation owns each live run, keyed by run id — needed when the
    /// run finishes to update the automation's last-status columns.
    automation_run_owner: HashMap<String, String>,
    /// Run rows this actor wrote but whose store write is still queued. Read
    /// before the store so an immediate dispatch never races the write-behind
    /// queue; final-status runs drop out (the store is authoritative then).
    automation_runs_live: HashMap<String, wire::AutomationRun>,
    /// Live run per dispatched automation task, so a finished turn's output can
    /// be attributed back to its run row.
    automation_run_tasks: HashMap<String, String>,
    /// Last used run number per automation, seeded from the store at spawn.
    /// In-memory so run numbers never collide with the write-behind queue and
    /// assigning one costs no blocking SQLite read on the actor loop.
    automation_run_counters: HashMap<String, u64>,
}

impl Daemon {
    async fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::LspStart {
                task_id,
                language,
                project,
                reply,
            } => {
                let root = self
                    .tasks
                    .get(&task_id)
                    .and_then(|task| {
                        task.worktree
                            .clone()
                            .or_else(|| self.project_path(&task.project))
                    })
                    .or_else(|| project.as_deref().and_then(|p| self.project_path(p)));
                let result = match root {
                    Some(root) => {
                        let (server_id, available) = self.lsp.start(root.clone(), language);
                        wire::LspStartResult {
                            server_id,
                            available,
                            root_path: if available { root } else { String::new() },
                        }
                    }
                    None => wire::LspStartResult {
                        server_id: String::new(),
                        available: false,
                        root_path: String::new(),
                    },
                };
                let _ = reply.send(result);
            }
            Command::LspSend { server_id, payload } => self.lsp.send(&server_id, payload),
            Command::LspStop { server_id } => self.lsp.stop(&server_id),
            Command::Shutdown { .. } => unreachable!(
                "Shutdown commands are intercepted by the actor loop before handle_command"
            ),
            Command::UpdateSafety { .. } => unreachable!(
                "UpdateSafety commands are intercepted by the actor loop before handle_command"
            ),
            Command::Projects(reply) => {
                let _ = reply.send(self.projects.clone());
            }
            Command::Tasks(reply) => {
                let mut tasks: Vec<Task> = self.tasks.values().cloned().collect();
                tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));
                let _ = reply.send(tasks);
            }
            Command::Snapshot(reply) => {
                // The snapshot carries tasks and metadata only — never session
                // transcripts. A client that opens a chat fetches that task's
                // full transcript via `session.history`, so a cold connect
                // never depends on reading every transcript in the database
                // (see `docs/adr/0005`).
                let _ = reply.send(self.build_snapshot_core());
            }
            Command::SessionHistory { task_id, reply } => {
                // Same off-loop shape the snapshot used to have: flush first so
                // the read sees everything the write-behind queue still holds,
                // then read + fold on a worker; only the reply crosses back.
                let persist = self.persist.clone();
                let store = self.store.clone();
                tokio::spawn(async move {
                    persist.flush().await;
                    let result = crate::daemon::runtime::store_read(store, move |store| {
                        store
                            .load_session_updates(&task_id)
                            .map(|updates| crate::daemon::store::fold_for_snapshot(&updates))
                            .map_err(|e| format!("{e:#}"))
                    })
                    .await
                    .unwrap_or_else(|| Err("daemon has no persistent store".into()));
                    let _ = reply.send(result);
                });
            }
            Command::HistoryGetSettings { reply } => {
                let config = crate::daemon::history_config::HistoryConfig::load();
                let _ = reply.send(wire::HistorySettings {
                    retention_days: config.retention_days,
                    settle_ignored_after_days: config.settle_ignored_after_days,
                    delete_closed_after_days: config.delete_closed_after_days,
                });
            }
            Command::HistorySetSettings {
                retention_days,
                settle_ignored_after_days,
                delete_closed_after_days,
                reply,
            } => {
                let config = crate::daemon::history_config::HistoryConfig {
                    retention_days,
                    settle_ignored_after_days,
                    delete_closed_after_days,
                };
                let result = crate::daemon::history_config::save(&config)
                    .map(|_| wire::HistorySettings {
                        retention_days,
                        settle_ignored_after_days,
                        delete_closed_after_days,
                    })
                    .map_err(|e| format!("{e:#}"));
                if result.is_ok() {
                    self.history_sweep();
                }
                let _ = reply.send(result);
            }
            Command::PruneHistory => self.history_sweep(),
            other => self.handle_project_command(other).await,
        }
    }
}
