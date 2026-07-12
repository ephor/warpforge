//! The daemon actor: a single tokio task that owns all runtime state (projects,
//! dev servers, port-forwards, agent PTYs, tasks) and is the sole mutator of it.
//!
//! Clients (the TUI now; a WebSocket server in Stage 2) never touch the managers
//! directly — they send [`Command`]s in and consume [`Event`]s out. This is the
//! daemon/client boundary the pivot is about: because every observer is on the
//! same event stream, there is no "primary" UI, and nothing assumes a single
//! consumer.
//!
//! The internal [`Event`] here is intentionally *not* the serializable wire type
//! (`warpforge_protocol::Event`): in-process it can carry rich handles like the
//! live vt100 parser. Stage 2 adds a thin translation from this to the wire
//! type for the socket.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::{broadcast, mpsc, oneshot};

use warpforge_protocol as wire;

use crate::agent::{AgentEvent, AgentManager, AgentStatus};
use crate::config::{load_workspace_config, sorted_services};
use crate::portforward::{PfEvent, PfStatus, PortForwardManager};
use crate::registry::ProjectEntry;
use crate::service::{kill_listeners_in_ranges, ServiceEvent, ServiceManager, ServiceStatus};

use super::acp::{spawn_acp_session, AcpHandle, AcpUpdate, PolicyCheck};
use super::store::Store;
use super::task::{Task, TaskStatus};
use super::wire as wireconv;
use super::worktree::WorktreeManager;
use crate::policies::builtins::{BlastRadiusPolicy, SpawnBoundsPolicy};
use crate::policies::registry::PolicyRegistry;
use crate::policies::{Phase, PolicyContext};

/// Split a `project/service` service key back into its parts (split on first
/// `/`, which is how `ServiceManager` composes the key).
fn split_key(key: &str) -> (String, String) {
    match key.split_once('/') {
        Some((p, s)) => (p.to_string(), s.to_string()),
        None => (String::new(), key.to_string()),
    }
}

fn is_acp_replay_update(update: &wire::SessionUpdate) -> bool {
    match update {
        wire::SessionUpdate::UserMessage { .. }
        | wire::SessionUpdate::PermissionResolved { .. } => false,
        wire::SessionUpdate::AgentText { text } => {
            text != "Reconnecting to the saved agent session…"
                && !text.starts_with("⚠ No live agent session")
        }
        wire::SessionUpdate::AgentThought { .. }
        | wire::SessionUpdate::ToolCall { .. }
        | wire::SessionUpdate::FileEdit { .. }
        | wire::SessionUpdate::PermissionRequest { .. }
        | wire::SessionUpdate::Plan { .. }
        | wire::SessionUpdate::AvailableCommands { .. }
        | wire::SessionUpdate::TurnEnded { .. } => true,
    }
}

/// Commands from clients to the daemon.
pub enum Command {
    Projects(oneshot::Sender<Vec<ProjectEntry>>),
    Tasks(oneshot::Sender<Vec<Task>>),
    /// Full serializable state snapshot (sent to a client on `state.subscribe`).
    Snapshot(oneshot::Sender<wire::Snapshot>),
    /// Start every declared service + port-forward for a project (what "opening"
    /// a project used to do implicitly in the TUI — now explicit).
    OpenProject {
        name: String,
    },
    StartService {
        project: String,
        service: String,
    },
    StopService {
        project: String,
        service: String,
    },
    RestartService {
        project: String,
        service: String,
    },
    /// Start every declared service for a project (services only, no port-forwards).
    StartAllServices {
        project: String,
    },
    StopProject {
        project: String,
    },
    /// Stop every service and port-forward while keeping the daemon and agent
    /// sessions alive. Used when the desktop UI closes.
    StopRuntime,
    /// A window of a service's retained log lines (events only carry the tail).
    ServiceLogs {
        project: String,
        service: String,
        after: u64,
        limit: Option<u32>,
        reply: oneshot::Sender<Vec<String>>,
    },
    /// Start every declared port-forward for a project (port-forwards only).
    StartAllPortForwards {
        project: String,
    },
    /// Start a single declared port-forward by its label.
    StartPortForward {
        project: String,
        name: String,
    },
    StopPortForward {
        project: String,
        name: String,
    },
    SpawnAgent {
        project: String,
        command: String,
        description: String,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<Result<String>>,
    },
    WriteAgent {
        id: String,
        data: Vec<u8>,
    },
    ResizeAgent {
        id: String,
        cols: u16,
        rows: u16,
    },
    KillAgent {
        id: String,
    },
    CreateTask {
        project: String,
        prompt: String,
        agent: String,
        tags: Vec<String>,
        include_runtime_context: bool,
        /// When true, create an isolated git worktree for this task.
        worktree: bool,
        reply: oneshot::Sender<String>,
    },
    CancelTask {
        id: String,
    },
    /// Delete a task and its session history permanently.
    DeleteTask {
        id: String,
    },
    /// Merge a task's worktree branch back into its base branch and clean up.
    MergeWorktree {
        task_id: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// List active worktrees for a project.
    ListWorktrees {
        project: String,
        reply: oneshot::Sender<Vec<wire::WorktreeInfo>>,
    },
    /// List resumable agent sessions found on disk for a project's cwd.
    ListSessions {
        project: String,
        reply: oneshot::Sender<Vec<wire::ExternalSession>>,
    },
    /// Resume an external agent session as a new task; replies with its task id.
    ResumeTask {
        project: String,
        agent: String,
        session_id: String,
        title: String,
        reply: oneshot::Sender<String>,
    },
    /// Compute the task's working-tree diff (git).
    GetDiff {
        task_id: String,
        reply: oneshot::Sender<wire::TaskDiff>,
    },
    /// Old (HEAD) + new (working-tree) text of one file.
    GetFileContents {
        task_id: String,
        path: String,
        reply: oneshot::Sender<Option<wire::FileDoc>>,
    },
    /// List files in a task's project working tree.
    ListFiles {
        task_id: String,
        reply: oneshot::Sender<Vec<wire::ProjectFile>>,
    },
    /// Write new contents to a file in the task's working tree.
    SaveFile {
        task_id: String,
        path: String,
        content: String,
    },
    /// Accept (keep) or reject (revert) a single hunk in the working tree.
    ResolveHunk {
        task_id: String,
        file: String,
        hunk_index: u32,
        resolution: wire::HunkResolution,
    },
    /// Stage (optionally a subset of) files and commit them in the task's repo.
    GitCommit {
        task_id: String,
        message: String,
        files: Option<Vec<String>>,
        amend: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Fetch + rebase the task's repo onto its upstream (autostash, rollback).
    GitUpdate {
        task_id: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// List local branches of the task's repo.
    GitBranches {
        task_id: String,
        reply: oneshot::Sender<wire::GitBranchList>,
    },
    /// Switch the task's repo to `branch` (smart checkout, rollback on conflict).
    GitSwitchBranch {
        task_id: String,
        branch: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Send a follow-up prompt into a task's running agent session.
    SessionPrompt {
        task_id: String,
        text: String,
    },
    /// Answer a permission request the agent raised.
    SessionPermission {
        task_id: String,
        request_id: String,
        outcome: String,
    },
    /// Change a session selector (model/mode/…) the agent exposes.
    SessionSetConfigOption {
        task_id: String,
        config_id: String,
        value: String,
    },
    /// Detect installed ACP-capable agents (runs which/where, returns list).
    DetectAgents {
        reply: oneshot::Sender<Vec<wire::DetectedAgent>>,
    },
    /// Save agent configuration from setup wizard or settings.
    UpdateAgents {
        agents: Vec<wire::AgentConfig>,
    },
    /// Start an orchestration plan (planner→worker→reviewer pipeline).
    StartOrchestration {
        project: String,
        goal: String,
        reply: oneshot::Sender<String>,
    },
    /// List active orchestration graphs.
    ListOrchestrations {
        reply: oneshot::Sender<Vec<crate::orchestration::GraphInfo>>,
    },
    /// Get the orchestrator configuration.
    GetOrchestratorConfig {
        reply: oneshot::Sender<wire::OrchestratorConfigDto>,
    },
    /// Save the orchestrator configuration.
    SaveOrchestratorConfig {
        config: wire::OrchestratorConfigDto,
        reply: oneshot::Sender<bool>,
    },
    Shutdown,
}

/// State deltas broadcast to every subscribed client.
#[derive(Clone)]
pub enum Event {
    ServiceStatus {
        project: String,
        service: String,
        status: ServiceStatus,
        allocated_port: u16,
    },
    ServiceLog {
        project: String,
        service: String,
        line: String,
    },
    PortForwardStatus {
        project: String,
        name: String,
        status: PfStatus,
    },
    PortForwardLog {
        project: String,
        name: String,
        line: String,
    },
    AgentsSetupNeeded {
        detected: Vec<wire::DetectedAgent>,
    },
    AgentsUpdated {
        agents: Vec<wire::AgentConfig>,
    },
    /// A PTY agent was created; carries the live vt100 parser so an in-process
    /// client can render it. (Stage 3 replaces this with serialized screens.)
    AgentSpawned {
        id: String,
        project: String,
        screen: Arc<Mutex<vt100::Parser>>,
    },
    AgentStatus {
        id: String,
        status: AgentStatus,
    },
    AgentExited {
        id: String,
    },
    TaskCreated(Task),
    TaskUpdated(Task),
    TaskRemoved {
        id: String,
    },
    /// Structured ACP session activity for a task (tool calls, agent text,
    /// file edits, permission requests) — already in wire shape.
    SessionUpdate {
        task_id: String,
        update: wire::SessionUpdate,
    },
    /// A PTY terminal's rendered screen changed (serialized, so clients need no
    /// terminal emulator — the daemon owns the one authoritative vt100 parser).
    TerminalScreen {
        terminal_id: String,
        screen: wire::TerminalScreen,
    },
    /// Orchestration pipeline event (plan created, node dispatched, etc.)
    OrchestrationEvent(crate::orchestration::OrchEvent),
}

/// Cloneable handle clients use to talk to the daemon.
#[derive(Clone)]
pub struct DaemonHandle {
    cmd_tx: mpsc::Sender<Command>,
    event_tx: broadcast::Sender<Event>,
}

impl DaemonHandle {
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.event_tx.subscribe()
    }

    pub async fn send(&self, cmd: Command) {
        let _ = self.cmd_tx.send(cmd).await;
    }

    pub async fn projects(&self) -> Vec<ProjectEntry> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Projects(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn tasks(&self) -> Vec<Task> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Tasks(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn snapshot(&self) -> wire::Snapshot {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Snapshot(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn create_task(
        &self,
        project: &str,
        prompt: &str,
        agent: &str,
        tags: Vec<String>,
        include_runtime_context: bool,
        worktree: bool,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CreateTask {
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            tags,
            include_runtime_context,
            worktree,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn diff(&self, task_id: &str) -> wire::TaskDiff {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GetDiff {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn file_contents(&self, task_id: &str, path: &str) -> Option<wire::FileDoc> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GetFileContents {
            task_id: task_id.to_string(),
            path: path.to_string(),
            reply: tx,
        })
        .await;
        rx.await.ok().flatten()
    }

    pub async fn list_files(&self, task_id: &str) -> Vec<wire::ProjectFile> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListFiles {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn git_commit(
        &self,
        task_id: &str,
        message: &str,
        files: Option<Vec<String>>,
        amend: bool,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitCommit {
            task_id: task_id.to_string(),
            message: message.to_string(),
            files,
            amend,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the commit request".into()))
    }

    pub async fn git_update(&self, task_id: &str) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitUpdate {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| wire::GitOpResult {
            status: wire::GitOpStatus::Error,
            message: "daemon dropped the update request".into(),
            conflicts: Vec::new(),
            branch: None,
        })
    }

    pub async fn git_branches(&self, task_id: &str) -> wire::GitBranchList {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitBranches {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn git_switch_branch(&self, task_id: &str, branch: &str) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitSwitchBranch {
            task_id: task_id.to_string(),
            branch: branch.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| wire::GitOpResult {
            status: wire::GitOpStatus::Error,
            message: "daemon dropped the switch request".into(),
            conflicts: Vec::new(),
            branch: None,
        })
    }

    /// A window of a service's retained log lines (for backfill; live tail
    /// arrives via `ServiceLog` events).
    pub async fn service_logs(
        &self,
        project: &str,
        service: &str,
        after: u64,
        limit: Option<u32>,
    ) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ServiceLogs {
            project: project.to_string(),
            service: service.to_string(),
            after,
            limit,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    /// Ask the daemon to tear down (stop services, port-forwards, agents) and
    /// end its actor loop. Used on SIGTERM so we don't leave orphans.
    pub async fn shutdown(&self) {
        self.send(Command::Shutdown).await;
    }

    pub async fn session_prompt(&self, task_id: &str, text: &str) {
        self.send(Command::SessionPrompt {
            task_id: task_id.into(),
            text: text.into(),
        })
        .await;
    }

    pub async fn list_sessions(&self, project: &str) -> Vec<wire::ExternalSession> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListSessions {
            project: project.into(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn resume_task(
        &self,
        project: &str,
        agent: &str,
        session_id: &str,
        title: &str,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ResumeTask {
            project: project.into(),
            agent: agent.into(),
            session_id: session_id.into(),
            title: title.into(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn detect_agents(&self) -> Vec<wire::DetectedAgent> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::DetectAgents { reply: tx }).await;
        rx.await.unwrap_or_default()
    }

    pub async fn update_agents(&self, agents: Vec<wire::AgentConfig>) {
        self.send(Command::UpdateAgents { agents }).await;
    }

    pub async fn session_set_config_option(&self, task_id: &str, config_id: &str, value: &str) {
        self.send(Command::SessionSetConfigOption {
            task_id: task_id.into(),
            config_id: config_id.into(),
            value: value.into(),
        })
        .await;
    }

    pub async fn session_permission(&self, task_id: &str, request_id: &str, outcome: &str) {
        self.send(Command::SessionPermission {
            task_id: task_id.into(),
            request_id: request_id.into(),
            outcome: outcome.into(),
        })
        .await;
    }

    pub async fn spawn_agent(
        &self,
        project: &str,
        command: &str,
        description: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SpawnAgent {
            project: project.to_string(),
            command: command.to_string(),
            description: description.to_string(),
            cols,
            rows,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("daemon closed")))
    }

    pub async fn merge_worktree(&self, task_id: &str) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MergeWorktree {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon closed".into()))
    }

    pub async fn list_worktrees(&self, project: &str) -> Vec<wire::WorktreeInfo> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListWorktrees {
            project: project.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }
}

pub struct Daemon {
    projects: Vec<ProjectEntry>,
    tasks: HashMap<String, Task>,
    /// Enabled ACP agent configurations (from SQLite, user-managed).
    configured_agents: Vec<wire::AgentConfig>,
    /// Live agent sessions keyed by task id. One per task in v1; the map (not a
    /// field on Task) is what keeps multi-session-per-task additive later.
    sessions: HashMap<String, AcpHandle>,
    agents: AgentManager,
    services: ServiceManager,
    portforwards: PortForwardManager,
    event_tx: broadcast::Sender<Event>,
    acp_tx: mpsc::UnboundedSender<(String, AcpUpdate)>,
    store: Option<Store>,
    /// `session/load` may replay already persisted ACP updates. While the
    /// replay matches local history in order, drop it; the first mismatch is
    /// new live output and disables the guard.
    resume_replay: HashMap<String, VecDeque<wire::SessionUpdate>>,
    /// Per-project git worktree managers, lazily created on first worktree use.
    worktrees: HashMap<String, WorktreeManager>,
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
}

impl Daemon {
    /// Construct the daemon and run its actor loop on a background task.
    /// Persisted tasks are loaded from the store (Running/Queued tasks come back
    /// as Interrupted — no live-session resumption in v1).
    pub fn spawn(projects: Vec<ProjectEntry>, store: Option<Store>) -> DaemonHandle {
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let (event_tx, _) = broadcast::channel(2048);
        let (agent_tx, agent_rx) = mpsc::unbounded_channel();
        let (service_tx, service_rx) = mpsc::unbounded_channel();
        let (pf_tx, pf_rx) = mpsc::unbounded_channel();
        let (acp_tx, acp_rx) = mpsc::unbounded_channel();
        let (policy_tx, policy_rx) = mpsc::unbounded_channel::<PolicyCheck>();

        let tasks = store
            .as_ref()
            .and_then(|s| s.load_tasks().ok())
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();

        let configured_agents = store
            .as_ref()
            .and_then(|s| s.load_agents().ok())
            .unwrap_or_default();

        let needs_setup = store
            .as_ref()
            .map(|s| !s.agents_configured())
            .unwrap_or(false);

        let orch_config = store
            .as_ref()
            .and_then(|s| s.load_orchestrator_config().ok())
            .flatten()
            .unwrap_or_default();

        let daemon = Daemon {
            projects,
            tasks,
            configured_agents,
            sessions: HashMap::new(),
            agents: AgentManager::new(agent_tx),
            services: ServiceManager::new(service_tx),
            portforwards: PortForwardManager::new(pf_tx),
            event_tx: event_tx.clone(),
            acp_tx,
            store,
            resume_replay: HashMap::new(),
            worktrees: HashMap::new(),
            policies: default_policies(),
            policy_tx,
            orch_tx: None,
            orch_event_rx: None,
            orch_config,
        };

        let handle = DaemonHandle { cmd_tx, event_tx };

        // Detect installed agents in background so it doesn't block startup,
        // then emit setup_needed if no agents are configured yet.
        if needs_setup {
            let ev_tx = handle.event_tx.clone();
            tokio::task::spawn_blocking(move || {
                let detected = super::agents::detected_agents();
                let _ = ev_tx.send(Event::AgentsSetupNeeded { detected });
            });
        }

        // Spawn the orchestrator with loaded config.
        let orch_config = daemon.orch_config.clone();
        let orch_handle = handle.clone();
        let (orch_cmd_tx, orch_event_bcast) =
            crate::orchestration::spawn_orchestrator(orch_config, orch_handle);

        // Forward orchestrator events into the daemon broadcast.
        let ev_tx = handle.event_tx.clone();
        let mut orch_event_rx = orch_event_bcast.subscribe();
        tokio::spawn(async move {
            while let Ok(ev) = orch_event_rx.recv().await {
                let _ = ev_tx.send(Event::OrchestrationEvent(ev));
            }
        });

        // Rebuild daemon with orchestrator handles.
        let mut daemon = daemon;
        daemon.orch_tx = Some(orch_cmd_tx);
        daemon.orch_event_rx = None; // receiver moved to forwarder task

        tokio::spawn(daemon.run(cmd_rx, agent_rx, service_rx, pf_rx, acp_rx, policy_rx));

        handle
    }

    fn emit(&self, event: Event) {
        // Err just means no subscribers right now — fine.
        let _ = self.event_tx.send(event);
    }

    fn persist(&self, task: &Task) {
        if let Some(store) = &self.store {
            let _ = store.upsert_task(task);
        }
    }

    /// Build the serializable snapshot handed to a client on subscribe.
    fn build_snapshot(&self) -> wire::Snapshot {
        let projects = self
            .projects
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let (start, end) = crate::ports::port_range(i);
                let config = load_workspace_config(std::path::Path::new(&p.path));
                let declared_services = config.as_ref().map(sorted_services).unwrap_or_default();
                let agent_templates = config
                    .as_ref()
                    .and_then(|c| c.agent_templates.clone())
                    .map(|m| m.into_iter().map(|(k, v)| (k, v.command)).collect())
                    .unwrap_or_default();
                wire::ProjectInfo {
                    name: p.name.clone(),
                    path: p.path.clone(),
                    port_range: (start, end),
                    declared_services,
                    agent_templates,
                }
            })
            .collect();

        let services = self
            .services
            .all()
            .map(|s| wire::ServiceInfo {
                project: s.project_name.clone(),
                name: s.name.clone(),
                command: s.command.clone(),
                status: wireconv::service_status(&s.status),
                original_port: s.original_port,
                allocated_port: s.allocated_port,
                log_seq: 0,
            })
            .collect();

        // Build portforwards from config first (Stopped), then override with
        // live state for any that have been started. This ensures portforwards
        // always appear in the snapshot even before they're started.
        let mut pf_map: std::collections::HashMap<String, wire::PortForwardInfo> =
            std::collections::HashMap::new();
        for p in &self.projects {
            if let Some(config) = load_workspace_config(std::path::Path::new(&p.path)) {
                for pf_cfg in &config.portforwards {
                    let name = pf_cfg
                        .name
                        .clone()
                        .unwrap_or_else(|| format!("{}:{}", pf_cfg.namespace, pf_cfg.pod));
                    let key = format!("{}/{}", p.name, name);
                    pf_map.insert(
                        key,
                        wire::PortForwardInfo {
                            project: p.name.clone(),
                            name,
                            namespace: pf_cfg.namespace.clone(),
                            pod: pf_cfg.pod.clone(),
                            local_port: pf_cfg.local_port,
                            remote_port: pf_cfg.remote_port,
                            status: wire::PortForwardStatus::Stopped,
                        },
                    );
                }
            }
        }
        for (key, pf) in &self.portforwards.forwards {
            let project = key
                .split_once('/')
                .map(|(p, _)| p)
                .unwrap_or("")
                .to_string();
            pf_map.insert(
                key.clone(),
                wire::PortForwardInfo {
                    project,
                    name: pf.name.clone(),
                    namespace: pf.namespace.clone(),
                    pod: pf.pod_prefix.clone(),
                    local_port: pf.local_port,
                    remote_port: pf.remote_port,
                    status: wireconv::pf_status(&pf.status),
                },
            );
        }
        let mut portforwards: Vec<wire::PortForwardInfo> = pf_map.into_values().collect();
        portforwards.sort_by(|a, b| a.name.cmp(&b.name));

        let mut tasks: Vec<wire::TaskInfo> = self.tasks.values().map(wireconv::task_info).collect();
        tasks.sort_by_key(|t| t.created_at);

        let terminals = self
            .agents
            .all()
            .map(|a| {
                let (cols, rows) = a.dims();
                wire::TerminalInfo {
                    id: a.id.clone(),
                    project: a.project_name.clone(),
                    command: a.command.clone(),
                    started_at: a.started_at,
                    cols,
                    rows,
                }
            })
            .collect();

        let session_history = self
            .store
            .as_ref()
            .and_then(|s| s.load_all_session_updates().ok())
            .unwrap_or_default();

        wire::Snapshot {
            projects,
            services,
            portforwards,
            tasks,
            terminals,
            session_history,
            agents: self.configured_agents.clone(),
        }
    }

    fn project_path(&self, name: &str) -> Option<String> {
        self.projects
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.path.clone())
    }

    /// Bump a task's `updated_at`, persist, and emit `TaskUpdated` so every
    /// client refetches its diff/branch (used after git ops change the tree).
    fn bump_task(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.updated_at = super::task::now_secs();
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
    }

    fn project_index(&self, name: &str) -> usize {
        self.projects
            .iter()
            .position(|p| p.name == name)
            .unwrap_or(0)
    }

    async fn run(
        mut self,
        mut cmd_rx: mpsc::Receiver<Command>,
        mut agent_rx: mpsc::UnboundedReceiver<AgentEvent>,
        mut service_rx: mpsc::UnboundedReceiver<ServiceEvent>,
        mut pf_rx: mpsc::UnboundedReceiver<PfEvent>,
        mut acp_rx: mpsc::UnboundedReceiver<(String, AcpUpdate)>,
        mut policy_rx: mpsc::UnboundedReceiver<PolicyCheck>,
    ) {
        loop {
            tokio::select! {
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(Command::Shutdown) | None => break,
                        Some(cmd) => self.handle_command(cmd).await,
                    }
                }
                Some(ev) = agent_rx.recv() => self.handle_agent_event(ev),
                Some(ev) = service_rx.recv() => self.handle_service_event(ev),
                Some(ev) = pf_rx.recv() => self.handle_pf_event(ev),
                Some((task_id, update)) = acp_rx.recv() => self.handle_acp_update(task_id, update),
                Some(check) = policy_rx.recv() => self.handle_policy_check(check).await,
            }
        }

        // Teardown — stop everything we started.
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        kill_listeners_in_ranges(&self.project_port_ranges()).await;
        self.agents.kill_all();
    }

    fn handle_agent_event(&mut self, ev: AgentEvent) {
        self.agents.apply_event(&ev);
        match ev {
            AgentEvent::Data { id, .. } => {
                if let Some(agent) = self.agents.get(&id) {
                    self.emit(Event::AgentStatus {
                        id: id.clone(),
                        status: agent.status.clone(),
                    });
                    // Serialize and push the terminal screen for remote clients.
                    if let Ok(parser) = agent.screen.lock() {
                        let screen = wireconv::terminal_screen(&parser);
                        self.emit(Event::TerminalScreen {
                            terminal_id: id,
                            screen,
                        });
                    }
                }
            }
            AgentEvent::Exit { id, .. } => self.emit(Event::AgentExited { id }),
        }
    }

    fn handle_service_event(&mut self, ev: ServiceEvent) {
        let broadcast = match &ev {
            ServiceEvent::Log { key, line, .. } => {
                let (project, service) = split_key(key);
                Event::ServiceLog {
                    project,
                    service,
                    line: line.clone(),
                }
            }
            ServiceEvent::StatusChange { key, status, .. } => {
                let (project, service) = split_key(key);
                let allocated_port = self
                    .services
                    .get(&project, &service)
                    .map(|s| s.allocated_port)
                    .unwrap_or(0);
                Event::ServiceStatus {
                    project,
                    service,
                    status: status.clone(),
                    allocated_port,
                }
            }
        };
        self.services.apply_event(ev);
        match &broadcast {
            Event::ServiceStatus {
                project, service, ..
            } => {
                self.emit_service_status(project, service);
            }
            _ => self.emit(broadcast),
        }
    }

    fn handle_pf_event(&mut self, ev: PfEvent) {
        let broadcast = match &ev {
            PfEvent::Log {
                project,
                name,
                line,
            } => Event::PortForwardLog {
                project: project.clone(),
                name: name.clone(),
                line: line.clone(),
            },
            PfEvent::Active { project, name, .. } | PfEvent::Restarted { project, name, .. } => {
                Event::PortForwardStatus {
                    project: project.clone(),
                    name: name.clone(),
                    status: PfStatus::Active,
                }
            }
            PfEvent::Failed { project, name, .. } => Event::PortForwardStatus {
                project: project.clone(),
                name: name.clone(),
                status: PfStatus::Failed,
            },
        };
        self.portforwards.apply_event(ev);
        self.emit(broadcast);
    }

    async fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::Shutdown => {}
            Command::Projects(reply) => {
                let _ = reply.send(self.projects.clone());
            }
            Command::Tasks(reply) => {
                let mut tasks: Vec<Task> = self.tasks.values().cloned().collect();
                tasks.sort_by_key(|t| t.created_at);
                let _ = reply.send(tasks);
            }
            Command::Snapshot(reply) => {
                let _ = reply.send(self.build_snapshot());
            }
            Command::OpenProject { name } => self.open_project(&name).await,
            Command::StartService { project, service } => {
                self.start_one_service(&project, &service).await;
            }
            Command::StopService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.emit_service_status(&project, &service);
            }
            Command::RestartService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.emit_service_status(&project, &service);
                self.start_one_service(&project, &service).await;
            }
            Command::StartAllServices { project } => {
                self.start_services(&project).await;
            }
            Command::StopProject { project } => {
                let services: Vec<String> = self
                    .services
                    .list_for_project(&project)
                    .into_iter()
                    .map(|svc| svc.name.clone())
                    .collect();
                self.services.stop_project(&project).await.ok();
                self.portforwards.stop_project(&project);
                if let Some(index) = self.projects.iter().position(|p| p.name == project) {
                    kill_listeners_in_ranges(&[crate::ports::port_range(index)]).await;
                }
                for service in services {
                    self.emit_service_status(&project, &service);
                }
            }
            Command::StopRuntime => {
                self.stop_runtime().await;
            }
            Command::ServiceLogs {
                project,
                service,
                after,
                limit,
                reply,
            } => {
                let lines = self
                    .services
                    .get(&project, &service)
                    .map(|s| {
                        let start = (after as usize).min(s.logs.len());
                        let mut window: Vec<String> = s.logs[start..].to_vec();
                        if let Some(n) = limit {
                            let n = n as usize;
                            if window.len() > n {
                                window = window.split_off(window.len() - n);
                            }
                        }
                        window
                    })
                    .unwrap_or_default();
                let _ = reply.send(lines);
            }
            Command::StartAllPortForwards { project } => {
                self.start_portforwards(&project).await;
            }
            Command::StartPortForward { project, name } => {
                self.start_one_portforward(&project, &name).await;
            }
            Command::StopPortForward { project, name } => {
                self.portforwards.stop(&project, &name);
            }
            Command::SpawnAgent {
                project,
                command,
                description,
                cols,
                rows,
                reply,
            } => {
                let result = match self.project_path(&project) {
                    Some(path) => {
                        self.agents
                            .spawn(&project, &path, &command, &description, cols, rows)
                    }
                    None => Err(anyhow::anyhow!("unknown project: {project}")),
                };
                if let Ok(ref id) = result {
                    if let Some(agent) = self.agents.get(id) {
                        self.emit(Event::AgentSpawned {
                            id: id.clone(),
                            project: project.clone(),
                            screen: Arc::clone(&agent.screen),
                        });
                    }
                }
                let _ = reply.send(result);
            }
            Command::WriteAgent { id, data } => self.agents.write(&id, data),
            Command::ResizeAgent { id, cols, rows } => self.agents.resize(&id, cols, rows),
            Command::KillAgent { id } => {
                self.agents.kill(&id);
                self.emit(Event::AgentExited { id });
            }
            Command::CreateTask {
                project,
                prompt,
                agent,
                tags,
                include_runtime_context,
                worktree: use_worktree,
                reply,
            } => {
                let mut task = Task::new(&project, &prompt, &agent, tags);
                // Create worktree if requested and project has a git repo.
                if use_worktree {
                    if let Some(path) = self.project_path(&project) {
                        let wt_mgr = self
                            .worktrees
                            .entry(project.clone())
                            .or_insert_with(|| WorktreeManager::new(std::path::PathBuf::from(&path)));
                        match wt_mgr.create(&task.id, None).await {
                            Ok(wt) => {
                                task.worktree = Some(wt.path.to_string_lossy().to_string());
                            }
                            Err(e) => {
                                eprintln!("[daemon] worktree creation failed: {e}");
                                // Fall back to non-isolated run.
                            }
                        }
                    }
                }
                let id = task.id.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());
                self.start_session(
                    &id,
                    &project,
                    &agent,
                    &prompt,
                    include_runtime_context,
                    None,
                );
            }
            Command::GetDiff { task_id, reply } => {
                // Resolve the repo path (sync) before awaiting git, so no shared
                // borrow of self is held across the await.
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let (files, branch) = match repo {
                    Some(path) => (
                        super::diff::working_diff(&path).await.unwrap_or_default(),
                        super::diff::current_branch(&path).await,
                    ),
                    None => (Vec::new(), None),
                };
                let _ = reply.send(wire::TaskDiff {
                    task_id,
                    files,
                    branch,
                });
            }
            Command::GetFileContents {
                task_id,
                path,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let doc = match repo {
                    Some(p) => super::diff::file_doc(&p, &path).await.ok(),
                    None => None,
                };
                let _ = reply.send(doc);
            }
            Command::ListFiles { task_id, reply } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let files = match repo {
                    Some(p) => super::diff::list_files(&p).await.unwrap_or_default(),
                    None => Vec::new(),
                };
                let _ = reply.send(files);
            }
            Command::SaveFile {
                task_id,
                path,
                content,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                if let Some(p) = repo {
                    if super::diff::save_file(&p, &path, &content).is_ok() {
                        // Nudge clients so the diff/file list refetches.
                        if let Some(task) = self.tasks.get_mut(&task_id) {
                            task.updated_at = super::task::now_secs();
                            let updated = task.clone();
                            self.persist(&updated);
                            self.emit(Event::TaskUpdated(updated));
                        }
                    }
                }
            }
            Command::ResolveHunk {
                task_id,
                file,
                hunk_index,
                resolution,
            } => {
                // accept keeps the change (no-op); only reject touches the tree.
                if resolution == wire::HunkResolution::Reject {
                    let repo = self
                        .tasks
                        .get(&task_id)
                        .and_then(|t| self.project_path(&t.project));
                    if let Some(path) = repo {
                        if super::diff::reject_hunk(&path, &file, hunk_index)
                            .await
                            .is_ok()
                        {
                            if let Some(task) = self.tasks.get_mut(&task_id) {
                                task.updated_at = super::task::now_secs();
                                if task.files_changed > 0 {
                                    task.files_changed -= 1;
                                }
                                let updated = task.clone();
                                self.persist(&updated);
                                self.emit(Event::TaskUpdated(updated));
                            }
                        }
                    }
                }
            }
            Command::GitCommit {
                task_id,
                message,
                files,
                amend,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let result = match repo {
                    Some(p) => super::diff::commit(&p, &message, files.as_deref(), amend)
                        .await
                        .map_err(|e| e.to_string()),
                    None => Err(format!("no repo for task {task_id}")),
                };
                if result.is_ok() {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        task.updated_at = super::task::now_secs();
                        task.files_changed = 0;
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
                let _ = reply.send(result);
            }
            Command::GitUpdate { task_id, reply } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let result = match repo {
                    Some(p) => super::diff::update_project(&p).await.unwrap_or_else(|e| {
                        wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: e.to_string(),
                            conflicts: Vec::new(),
                            branch: None,
                        }
                    }),
                    None => wire::GitOpResult {
                        status: wire::GitOpStatus::Error,
                        message: format!("no repo for task {task_id}"),
                        conflicts: Vec::new(),
                        branch: None,
                    },
                };
                // A clean update changed HEAD/tree — nudge clients to refetch.
                if result.status == wire::GitOpStatus::Ok {
                    self.bump_task(&task_id);
                }
                let _ = reply.send(result);
            }
            Command::GitBranches { task_id, reply } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let list = match repo {
                    Some(p) => super::diff::list_branches(&p).await.unwrap_or_default(),
                    None => wire::GitBranchList::default(),
                };
                let _ = reply.send(list);
            }
            Command::GitSwitchBranch {
                task_id,
                branch,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let result = match repo {
                    Some(p) => super::diff::switch_branch(&p, &branch)
                        .await
                        .unwrap_or_else(|e| wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: e.to_string(),
                            conflicts: Vec::new(),
                            branch: None,
                        }),
                    None => wire::GitOpResult {
                        status: wire::GitOpStatus::Error,
                        message: format!("no repo for task {task_id}"),
                        conflicts: Vec::new(),
                        branch: None,
                    },
                };
                // Switching branches changes the whole working tree — refetch.
                if result.status == wire::GitOpStatus::Ok {
                    self.bump_task(&task_id);
                }
                let _ = reply.send(result);
            }
            Command::CancelTask { id } => {
                if let Some(handle) = self.sessions.remove(&id) {
                    handle.cancel();
                }
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(TaskStatus::Done);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            Command::DeleteTask { id } => {
                if let Some(handle) = self.sessions.remove(&id) {
                    handle.cancel();
                }
                // Clean up worktree if the task had one.
                if let Some(task) = self.tasks.get(&id) {
                    if task.worktree.is_some() {
                        if let Some(wt_mgr) = self.worktrees.get_mut(&task.project) {
                            if let Err(e) = wt_mgr.remove(&id).await {
                                eprintln!("[daemon] worktree cleanup failed for {id}: {e}");
                            }
                        }
                    }
                }
                if self.tasks.remove(&id).is_some() {
                    if let Some(store) = &self.store {
                        let _ = store.delete_task(&id);
                    }
                    self.emit(Event::TaskRemoved { id });
                }
            }
            Command::MergeWorktree { task_id, reply } => {
                let result = if let Some(task) = self.tasks.get(&task_id) {
                    if let Some(wt_mgr) = self.worktrees.get(&task.project) {
                        match wt_mgr.merge(&task_id).await {
                            Ok(super::worktree::MergeResult::Ok { branch }) => {
                                // Clean up after merge.
                                if let Some(wt_mgr) = self.worktrees.get_mut(&task.project) {
                                    let _ = wt_mgr.remove(&task_id).await;
                                }
                                // Clear the worktree field on the task.
                                if let Some(task) = self.tasks.get_mut(&task_id) {
                                    task.worktree = None;
                                    task.updated_at = super::task::now_secs();
                                    let updated = task.clone();
                                    self.persist(&updated);
                                    self.emit(Event::TaskUpdated(updated));
                                }
                                Ok(branch)
                            }
                            Ok(super::worktree::MergeResult::Conflict { message, branch }) => {
                                Err(format!("merge conflict on {branch}: {message}"))
                            }
                            Ok(super::worktree::MergeResult::Error(msg)) => Err(msg),
                            Err(e) => Err(e.to_string()),
                        }
                    } else {
                        Err("no worktree manager for this project".into())
                    }
                } else {
                    Err(format!("unknown task {task_id}"))
                };
                let _ = reply.send(result);
            }
            Command::ListWorktrees { project, reply } => {
                let wts = if let Some(wt_mgr) = self.worktrees.get(&project) {
                    wt_mgr
                        .list()
                        .into_iter()
                        .map(|wt| wire::WorktreeInfo {
                            task_id: wt.task_id.clone(),
                            path: wt.path.to_string_lossy().to_string(),
                            branch: wt.branch.clone(),
                            base_branch: wt.base_branch.clone(),
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let _ = reply.send(wts);
            }
            Command::ListSessions { project, reply } => {
                let path = self.project_path(&project);
                let agents = self.configured_agents.clone();
                tokio::task::spawn_blocking(move || {
                    let sessions = match path {
                        Some(p) => super::sessions::external_sessions(&p, &agents),
                        None => Vec::new(),
                    };
                    let _ = reply.send(sessions);
                });
            }
            Command::ResumeTask {
                project,
                agent,
                session_id,
                title,
                reply,
            } => {
                let prompt = if title.is_empty() {
                    format!("Resumed {agent} session")
                } else {
                    title
                };
                let task = Task::new(&project, &prompt, &agent, vec!["resumed".into()]);
                let id = task.id.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());
                // Load history only (empty prompt); user continues via session.prompt.
                self.start_session(&id, &project, &agent, "", false, Some(session_id));
            }
            Command::SessionPrompt { task_id, text } => {
                let user_update = wire::SessionUpdate::UserMessage { text: text.clone() };
                match self.sessions.get(&task_id).cloned() {
                    Some(handle) => {
                        self.mark_task_running(&task_id);
                        // Echo the developer's message through the same
                        // persisted stream as agent updates. If a reconnect
                        // retry submits the same text again after the first
                        // attempt was already recorded, keep the transcript
                        // readable by dropping only that exact consecutive
                        // duplicate.
                        self.emit_session_unless_last_duplicate(&task_id, user_update);
                        handle.prompt(text);
                    }
                    None => {
                        let resume = self.tasks.get(&task_id).and_then(|task| {
                            task.session_id.as_ref().map(|session_id| {
                                (task.project.clone(), task.agent.clone(), session_id.clone())
                            })
                        });

                        if let Some((project, agent, session_id)) = resume {
                            self.mark_task_running(&task_id);
                            self.prepare_resume_replay_guard(&task_id);
                            self.emit_session_unless_last_duplicate(&task_id, user_update);
                            self.emit_session(
                                &task_id,
                                wire::SessionUpdate::AgentText {
                                    text: "Reconnecting to the saved agent session…".into(),
                                },
                            );
                            self.start_session(
                                &task_id,
                                &project,
                                &agent,
                                &text,
                                false,
                                Some(session_id),
                            );
                        } else {
                            // No live session and no persisted native session id
                            // to load. Say so instead of dropping the message.
                            self.emit_session_unless_last_duplicate(&task_id, user_update);
                            self.emit_session(
                                &task_id,
                                wire::SessionUpdate::AgentText {
                                    text: "⚠ No live agent session for this task — its \
                                           session ended and there is no saved session id \
                                           to resume. Start or resume a new task to continue."
                                        .into(),
                                },
                            );
                        }
                    }
                }
            }
            Command::SessionPermission {
                task_id,
                request_id,
                outcome,
            } => {
                if let Some(handle) = self.sessions.get(&task_id) {
                    handle.answer(request_id.clone(), outcome.clone());
                }
                // Record the answer so clients show it resolved even after a
                // reopen/restart (the request update stays in history).
                self.emit_session(
                    &task_id,
                    wire::SessionUpdate::PermissionResolved {
                        request_id,
                        outcome,
                    },
                );
            }
            Command::SessionSetConfigOption {
                task_id,
                config_id,
                value,
            } => {
                if let Some(handle) = self.sessions.get(&task_id) {
                    handle.set_config_option(config_id, value);
                }
            }
            Command::DetectAgents { reply } => {
                // Spawn blocking so `which` calls don't stall the actor loop.
                tokio::task::spawn_blocking(move || {
                    let detected = super::agents::detected_agents();
                    let _ = reply.send(detected);
                });
            }
            Command::UpdateAgents { agents } => {
                if let Some(store) = &self.store {
                    let _ = store.save_agents(&agents);
                }
                self.configured_agents = agents.clone();
                self.emit(Event::AgentsUpdated { agents });
            }
            Command::StartOrchestration { project, goal, reply } => {
                if let Some(orch_tx) = &self.orch_tx {
                    // Spawn — the orchestrator will call back into the daemon
                    // (create_task) which would deadlock if we blocked here.
                    let orch_tx = orch_tx.clone();
                    tokio::spawn(async move {
                        let (rtx, rrx) = oneshot::channel();
                        let _ = orch_tx
                            .send(crate::orchestration::OrchCommand::StartPlan {
                                project,
                                goal,
                                reply: rtx,
                            })
                            .await;
                        let graph_id = rrx.await.unwrap_or_default();
                        let _ = reply.send(graph_id);
                    });
                } else {
                    let _ = reply.send(String::new());
                }
            }
            Command::ListOrchestrations { reply } => {
                if let Some(orch_tx) = &self.orch_tx {
                    let (rtx, rrx) = oneshot::channel();
                    let _ = orch_tx
                        .send(crate::orchestration::OrchCommand::List(rtx))
                        .await;
                    let infos = rrx.await.unwrap_or_default();
                    let _ = reply.send(infos);
                } else {
                    let _ = reply.send(vec![]);
                }
            }
            Command::GetOrchestratorConfig { reply } => {
                let dto = self.orch_config.clone().into();
                let _ = reply.send(dto);
            }
            Command::SaveOrchestratorConfig { config, reply } => {
                self.orch_config = config.into();
                // Persist to store if available.
                if let Some(ref store) = self.store {
                    let _ = store.save_orchestrator_config(&self.orch_config);
                }
                let _ = reply.send(true);
            }
        }
    }

    /// "Opening" a project starts both its declared services and port-forwards
    /// (what entering a project did implicitly in the TUI).
    async fn open_project(&mut self, name: &str) {
        self.start_services(name).await;
        self.start_portforwards(name).await;
    }

    /// Start every declared service for a project (no port-forwards).
    async fn start_services(&mut self, name: &str) {
        let Some(path) = self.project_path(name) else {
            return;
        };
        let index = self.project_index(name);
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };

        for svc_name in sorted_services(&config) {
            if let Some(svc) = config.services.get(&svc_name) {
                self.services
                    .start(
                        name,
                        &path,
                        index,
                        &svc_name,
                        &svc.command,
                        svc.port.unwrap_or(0),
                        svc.env.as_ref(),
                        svc.ready_pattern.as_deref(),
                    )
                    .await
                    .ok();
                self.emit_service_status(name, &svc_name);
            }
        }
    }

    /// Start every declared port-forward for a project (no services).
    async fn start_portforwards(&mut self, name: &str) {
        let Some(path) = self.project_path(name) else {
            return;
        };
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };
        self.portforwards
            .start_all(name, &config.portforwards)
            .await;
    }

    /// Start a single declared port-forward, matched by its label (explicit
    /// `name:` in config, else the `namespace:pod` fallback the manager uses).
    async fn start_one_portforward(&mut self, project: &str, label: &str) {
        let Some(path) = self.project_path(project) else {
            return;
        };
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };
        let matched: Vec<_> = config
            .portforwards
            .into_iter()
            .filter(|cfg| {
                let cfg_label = cfg
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", cfg.namespace, cfg.pod));
                cfg_label == label
            })
            .collect();
        self.portforwards.start_all(project, &matched).await;
    }

    async fn start_one_service(&mut self, project: &str, service: &str) {
        let Some(path) = self.project_path(project) else {
            return;
        };
        let index = self.project_index(project);
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };
        let Some(svc) = config.services.get(service) else {
            return;
        };
        self.services
            .start(
                project,
                &path,
                index,
                service,
                &svc.command,
                svc.port.unwrap_or(0),
                svc.env.as_ref(),
                svc.ready_pattern.as_deref(),
            )
            .await
            .ok();
        self.emit_service_status(project, service);
    }

    /// Resolve a task's `agent` to a spawnable ACP command.
    /// Priority: global agent registry → project agentTemplates → raw command.
    fn resolve_agent_command(&self, project: &str, agent: &str) -> String {
        // 1. Global registry (configured via setup wizard / settings).
        if let Some(cfg) = self
            .configured_agents
            .iter()
            .find(|a| a.id == agent || a.display_name == agent)
        {
            return cfg.acp_command.clone();
        }
        // 2. Per-project agentTemplates override (legacy / power-user).
        if let Some(path) = self.project_path(project) {
            if let Some(config) = load_workspace_config(std::path::Path::new(&path)) {
                if let Some(tmpl) = config.agent_templates.and_then(|m| m.get(agent).cloned()) {
                    return tmpl.command;
                }
            }
        }
        // 3. Treat as raw ACP command.
        agent.to_string()
    }

    /// A context block describing the project's currently-running services and
    /// their live URLs — prepended to the agent's first prompt so it knows the
    /// app is already up and can hit real endpoints / run tests against it.
    fn runtime_context(&self, project: &str) -> Option<String> {
        let mut lines: Vec<String> = self
            .services
            .all()
            .filter(|s| {
                s.project_name == project
                    && s.allocated_port > 0
                    && matches!(s.status, ServiceStatus::Running | ServiceStatus::Starting)
            })
            .map(|s| format!("- {} → http://localhost:{}", s.name, s.allocated_port))
            .collect();
        if lines.is_empty() {
            return None;
        }
        lines.sort();
        Some(format!(
            "[warpforge] These services are already running for this project — \
             you can hit these endpoints and run tests against them:\n{}",
            lines.join("\n")
        ))
    }

    /// Spawn an ACP agent session for a task and remember its handle. When
    /// `resume` is set, load that native session id instead of starting fresh.
    /// Some agents replay prior history as `session/update`; the frontend stream
    /// is append-only today, so this path is used primarily to regain a live
    /// handle and deliver a new prompt after daemon restarts.
    ///
    /// If the task has a worktree, the agent runs in the worktree directory
    /// instead of the project root — so its edits are isolated.
    fn start_session(
        &mut self,
        task_id: &str,
        project: &str,
        agent: &str,
        prompt: &str,
        include_runtime_context: bool,
        resume: Option<String>,
    ) {
        // Resolve cwd: worktree path if set, otherwise project root.
        let cwd = if let Some(task) = self.tasks.get(task_id) {
            if let Some(ref wt_path) = task.worktree {
                wt_path.clone()
            } else {
                self.project_path(project)
                    .unwrap_or_else(|| ".".to_string())
            }
        } else {
            self.project_path(project)
                .unwrap_or_else(|| ".".to_string())
        };
        let command = self.resolve_agent_command(project, agent);
        let full_prompt = match include_runtime_context
            .then(|| self.runtime_context(project))
            .flatten()
        {
            Some(ctx) => format!("{ctx}\n\n{prompt}"),
            None => prompt.to_string(),
        };
        match spawn_acp_session(
            task_id.to_string(),
            command,
            cwd,
            full_prompt,
            resume,
            self.acp_tx.clone(),
            Some(self.policy_tx.clone()),
        ) {
            Ok(handle) => {
                self.sessions.insert(task_id.to_string(), handle);
            }
            Err(e) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(format!("failed to start agent: {e}"));
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    fn handle_acp_update(&mut self, task_id: String, update: AcpUpdate) {
        match update {
            AcpUpdate::SessionStarted { session_id } => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.attach_session(session_id);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::AgentText(text) => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::AgentText { text })
            }
            AcpUpdate::AgentThought(text) => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::AgentThought { text })
            }
            AcpUpdate::ToolCall {
                id,
                title,
                status,
                kind,
                content,
            } => self.emit_acp_session(
                &task_id,
                wire::SessionUpdate::ToolCall {
                    tool_call_id: id,
                    title,
                    status: wireconv::tool_status(&status),
                    tool_kind: kind,
                    content,
                },
            ),
            AcpUpdate::Plan { entries } => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::Plan { entries })
            }
            AcpUpdate::AvailableCommands { commands } => self.emit_acp_session(
                &task_id,
                wire::SessionUpdate::AvailableCommands { commands },
            ),
            AcpUpdate::ConfigOptions { options } => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.config_options = options;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::FileEdit { path } => {
                let update = wire::SessionUpdate::FileEdit { path };
                if self.should_skip_resume_replay(&task_id, &update) {
                    return;
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.files_changed += 1;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.emit_session(&task_id, update);
            }
            AcpUpdate::PermissionRequest {
                request_id,
                title,
                options,
            } => self.emit_acp_session(
                &task_id,
                wire::SessionUpdate::PermissionRequest {
                    request_id,
                    title,
                    options,
                },
            ),
            AcpUpdate::TurnEnded { stop_reason } => {
                // A clean turn end completes the node; a "disconnected" stop is
                // the agent process dying, which we treat as a failure.
                let success = stop_reason != "disconnected";
                let update = wire::SessionUpdate::TurnEnded { stop_reason };
                if self.should_skip_resume_replay(&task_id, &update) {
                    return;
                }
                self.emit_session(&task_id, update);
                // Turn over: only NeedsReview if there are actually changes to
                // review; a pure Q&A turn goes Idle (waiting for the next
                // message) instead of falsely demanding a review.
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    if task.status == TaskStatus::Running {
                        let next = if task.files_changed > 0 {
                            TaskStatus::NeedsReview
                        } else {
                            TaskStatus::Idle
                        };
                        task.set_status(next);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
                let result = self.collect_agent_text(&task_id);
                self.notify_orch_finished(&task_id, success, result);
            }
            AcpUpdate::Error(message) => {
                let reason = message.clone();
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.notify_orch_finished(&task_id, false, reason);
            }
        }
    }

    fn emit_acp_session(&mut self, task_id: &str, update: wire::SessionUpdate) {
        if self.should_skip_resume_replay(task_id, &update) {
            return;
        }
        self.emit_session(task_id, update);
    }

    fn mark_task_running(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            if task.status != TaskStatus::Done {
                task.blocked_reason = None;
                task.set_status(TaskStatus::Running);
                let updated = task.clone();
                self.persist(&updated);
                self.emit(Event::TaskUpdated(updated));
            }
        }
    }

    fn emit_session_unless_last_duplicate(&self, task_id: &str, update: wire::SessionUpdate) {
        if let Some(store) = &self.store {
            if let Ok(Some(last)) = store.load_last_session_update(task_id) {
                if last == update {
                    return;
                }
            }
        }
        self.emit_session(task_id, update);
    }

    fn prepare_resume_replay_guard(&mut self, task_id: &str) {
        let Some(store) = &self.store else {
            return;
        };
        let Ok(updates) = store.load_session_updates(task_id) else {
            return;
        };
        let replayable = updates
            .into_iter()
            .filter(is_acp_replay_update)
            .collect::<VecDeque<_>>();
        if !replayable.is_empty() {
            self.resume_replay.insert(task_id.to_string(), replayable);
        }
    }

    fn should_skip_resume_replay(&mut self, task_id: &str, update: &wire::SessionUpdate) -> bool {
        if !is_acp_replay_update(update) {
            return false;
        }

        let Some(history) = self.resume_replay.get_mut(task_id) else {
            return false;
        };

        if history.front() == Some(update) {
            history.pop_front();
            if history.is_empty() {
                self.resume_replay.remove(task_id);
            }
            return true;
        }

        // First mismatch means the agent has moved past replay into live output
        // (or its replay shape differs from ours). Stop filtering immediately.
        self.resume_replay.remove(task_id);
        false
    }

    /// Concatenate the agent's text output for a task (its persisted
    /// `AgentText` updates) — used as the orchestrator node's result, e.g. the
    /// planner's task-graph JSON.
    fn collect_agent_text(&self, task_id: &str) -> String {
        let Some(store) = &self.store else {
            return String::new();
        };
        let Ok(updates) = store.load_session_updates(task_id) else {
            return String::new();
        };
        updates
            .into_iter()
            .filter_map(|u| match u {
                wire::SessionUpdate::AgentText { text } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// Tell the orchestrator a dispatched task finished. No-op unless the task
    /// carries the "orchestrator" tag and an orchestrator is wired.
    fn notify_orch_finished(&self, task_id: &str, success: bool, result: String) {
        let Some(orch_tx) = self.orch_tx.clone() else {
            return;
        };
        let is_orch = self
            .tasks
            .get(task_id)
            .map_or(false, |t| t.tags.iter().any(|tag| tag == "orchestrator"));
        if !is_orch {
            return;
        }
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            let _ = orch_tx
                .send(crate::orchestration::OrchCommand::TaskFinished {
                    task_id,
                    result,
                    success,
                })
                .await;
        });
    }

    fn emit_session(&self, task_id: &str, update: wire::SessionUpdate) {
        if let Some(store) = &self.store {
            let _ = store.save_session_update(task_id, &update);
        }
        self.emit(Event::SessionUpdate {
            task_id: task_id.to_string(),
            update,
        });
    }

    /// Broadcast a service's current status. Emitted right after a start so a
    /// client learns the service exists (it may have subscribed before it did)
    /// — without this, newly started services never appear for other clients.
    fn emit_service_status(&self, project: &str, service: &str) {
        if let Some(svc) = self.services.get(project, service) {
            self.emit(Event::ServiceStatus {
                project: project.to_string(),
                service: service.to_string(),
                status: svc.status.clone(),
                allocated_port: svc.allocated_port,
            });
        }
    }

    async fn stop_runtime(&mut self) {
        let services: Vec<(String, String)> = self
            .services
            .list()
            .into_iter()
            .map(|svc| (svc.project_name.clone(), svc.name.clone()))
            .collect();
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        kill_listeners_in_ranges(&self.project_port_ranges()).await;
        for (project, service) in services {
            self.emit_service_status(&project, &service);
        }
    }

    fn project_port_ranges(&self) -> Vec<(u16, u16)> {
        self.projects
            .iter()
            .enumerate()
            .map(|(index, _)| crate::ports::port_range(index))
            .collect()
    }

    /// Build a PolicyContext for evaluating an action on a task.
    fn policy_context(
        &self,
        task_id: &str,
        phase: Phase,
        tool_name: Option<String>,
        tool_input: Option<serde_json::Value>,
    ) -> Option<PolicyContext> {
        let task = self.tasks.get(task_id)?;
        let project_path = self.project_path(&task.project)?;
        let cwd = if let Some(ref wt) = task.worktree {
            std::path::PathBuf::from(wt)
        } else {
            std::path::PathBuf::from(&project_path)
        };
        Some(PolicyContext {
            phase,
            tool_name,
            tool_input,
            agent: task.agent.clone(),
            task_id: task_id.to_string(),
            project: task.project.clone(),
            cwd,
            labels: HashMap::new(),
        })
    }

    /// Evaluate all policies for an action on a task.
    async fn evaluate_policies(
        &self,
        task_id: &str,
        phase: Phase,
        tool_name: Option<String>,
        tool_input: Option<serde_json::Value>,
    ) -> crate::policies::PolicyResult {
        let ctx = match self.policy_context(task_id, phase, tool_name, tool_input) {
            Some(ctx) => ctx,
            None => return crate::policies::PolicyResult::allow(),
        };
        self.policies.evaluate_all(&ctx).await
    }

    /// Handle a policy check request from an ACP reader task.
    async fn handle_policy_check(&mut self, check: PolicyCheck) {
        let result = self.policies.evaluate_all(&check.ctx).await;
        let _ = check.reply.send(result);
    }
}

/// Create the default policy set for a new daemon.
fn default_policies() -> PolicyRegistry {
    let mut reg = PolicyRegistry::new();
    reg.push(Box::new(BlastRadiusPolicy::default()));
    reg.push(Box::new(SpawnBoundsPolicy::new(6)));
    // CostBudget disabled by default (max=∞). Enable via config when needed.
    // WorktreeGuard enabled per-task in start_session, not globally.
    reg
}
