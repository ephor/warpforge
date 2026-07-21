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
        | wire::SessionUpdate::PermissionResolved { .. }
        | wire::SessionUpdate::PromptCapabilities { .. } => false,
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
        wire::SessionUpdate::Usage { .. } => false,
    }
}

/// System preamble prepended to an orchestrator-chat session's first prompt.
const ORCHESTRATOR_SYSTEM: &str = "\
You are an orchestrator agent in warpforge. You coordinate work by delegating to \
sub-agents rather than doing large tasks yourself.\n\n\
You have two MCP tools:\n\
- spawn_agent(agent, task): dispatch a sub-agent (e.g. \"claude\", \"codex\", \
\"opencode\") to work on a task. It runs asynchronously in its own session and \
returns immediately. Spawn several in one turn to parallelize.\n\
- read_inbox(): collect finished sub-agent results. When a sub-agent finishes you \
will receive a system message telling you results are waiting — call read_inbox to \
collect them, then decide the next step (spawn more, or report back to the user).\n\n\
Talk to the user normally. When a task needs real work, delegate it with \
spawn_agent, tell the user what you dispatched, and continue the conversation. \
The user can keep messaging you while sub-agents run.";

/// The warpforge MCP bridge config handed to an orchestrator session so the
/// agent can call spawn_agent / read_inbox back into this daemon.
fn orchestrator_mcp_servers(task_id: &str, project: &str) -> Vec<serde_json::Value> {
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "warpforge".to_string());
    vec![serde_json::json!({
        "name": "warpforge",
        "command": exe,
        "args": ["__mcp-orchestrator"],
        "env": [
            { "name": "WF_ORCH_TASK", "value": task_id },
            { "name": "WF_ORCH_PROJECT", "value": project },
        ],
    })]
}

/// A finished sub-agent's result, queued in its orchestrator parent's inbox
/// until the orchestrator agent drains it via the `read_inbox` MCP tool.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildResult {
    pub child_id: String,
    pub agent: String,
    pub prompt: String,
    pub output: String,
    pub success: bool,
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
    /// Atomically check whether an update can interrupt this daemon. If no
    /// blockers exist, the actor tears down and acknowledges only afterward;
    /// commands queued behind this one are never allowed to start new work.
    UpdateSafety {
        reply: oneshot::Sender<Vec<String>>,
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
        /// Set when this task is a sub-agent of an orchestrator task.
        parent_task_id: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        /// Model id to apply to the agent session before the first prompt
        /// (via `session/set_config_option`). When None, the daemon falls back
        /// to the agent's `last_model` so orchestrator-spawned sub-agents
        /// inherit the user's previous pick without an explicit UI selection.
        default_model: Option<String>,
        reply: oneshot::Sender<String>,
    },
    /// Drain an orchestrator task's inbox of finished sub-agent results.
    ReadInbox {
        parent_task_id: String,
        reply: oneshot::Sender<Vec<ChildResult>>,
    },
    CancelTask {
        id: String,
    },
    /// Archive a task (set status to Done, hide from live views).
    ArchiveTask {
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
        project: Option<String>,
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
    GitPushInfo {
        task_id: String,
        reply: oneshot::Sender<Result<wire::GitPushInfo, String>>,
    },
    GitPush {
        task_id: String,
        force: bool,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Send a follow-up prompt into a task's running agent session.
    SessionPrompt {
        task_id: String,
        text: String,
        attachments: Vec<wire::PromptAttachment>,
        reply: oneshot::Sender<Result<(), String>>,
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
    /// Trigger an ACP probe for one agent's model selectors. The probe runs in
    /// a background task and reports back via [`Command::AgentProbed`].
    ProbeAgent { id: String },
    /// A probe finished — persist the discovered models and re-emit agents.
    AgentProbed {
        id: String,
        models: Vec<wire::ConfigOption>,
        last_model: Option<String>,
    },
    /// Start an orchestration plan (planner→worker→reviewer pipeline).
    StartOrchestration {
        project: String,
        goal: String,
        reply: oneshot::Sender<(String, String)>,
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
    /// Force-set a task's status and emit a TaskUpdated event. Used by the
    /// orchestrator to reflect aggregate orchestration state on the parent task.
    SetTaskStatus {
        id: String,
        status: TaskStatus,
    },
    /// Add a project to the registry, generate config if needed, broadcast update.
    AddProject {
        path: String,
        name: Option<String>,
        reply: oneshot::Sender<Result<ProjectEntry, String>>,
    },
    /// Remove a project from the registry and broadcast the update.
    RemoveProject {
        name: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
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
    ProjectAdded(wire::ProjectInfo),
    ProjectRemoved {
        name: String,
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
    #[allow(clippy::enum_variant_names)]
    OrchestrationEvent(crate::orchestration::OrchEvent),
}

/// Cloneable handle clients use to talk to the daemon.
#[derive(Clone)]
pub struct DaemonHandle {
    pub cmd_tx: mpsc::Sender<Command>,
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

    #[allow(clippy::too_many_arguments)]
    pub async fn create_task(
        &self,
        project: &str,
        prompt: &str,
        agent: &str,
        tags: Vec<String>,
        include_runtime_context: bool,
        worktree: bool,
        parent_task_id: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CreateTask {
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            tags,
            include_runtime_context,
            worktree,
            parent_task_id,
            attachments,
            default_model,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn set_task_status(&self, id: &str, status: TaskStatus) {
        self.send(Command::SetTaskStatus {
            id: id.to_string(),
            status,
        })
        .await;
    }

    pub async fn read_inbox(&self, parent_task_id: &str) -> Vec<ChildResult> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ReadInbox {
            parent_task_id: parent_task_id.to_string(),
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

    pub async fn list_files(
        &self,
        task_id: &str,
        project: Option<String>,
    ) -> Vec<wire::ProjectFile> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListFiles {
            task_id: task_id.to_string(),
            project,
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

    pub async fn git_push_info(&self, task_id: &str) -> Result<wire::GitPushInfo, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitPushInfo {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the push preview request".into()))
    }

    pub async fn git_push(&self, task_id: &str, force: bool) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitPush {
            task_id: task_id.to_string(),
            force,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| wire::GitOpResult {
            status: wire::GitOpStatus::Error,
            message: "daemon dropped the push request".into(),
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

    /// Register a new project, generate config if needed, broadcast to clients.
    pub async fn add_project(
        &self,
        path: &str,
        name: Option<&str>,
    ) -> Result<ProjectEntry, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::AddProject {
            path: path.to_string(),
            name: name.map(str::to_string),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err("daemon dropped reply".into()))
    }

    /// Remove a project from the registry and broadcast to clients.
    pub async fn remove_project(&self, name: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::RemoveProject {
            name: name.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err("daemon dropped reply".into()))
    }

    /// Ask the daemon to tear down (stop services, port-forwards, agents) and
    /// end its actor loop. Used on SIGTERM so we don't leave orphans.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Shutdown { reply: tx }).await;
        let _ = rx.await;
    }

    pub async fn update_blockers(&self) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::UpdateSafety { reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| vec!["daemon closed during update safety check".into()])
    }

    pub async fn session_prompt(
        &self,
        task_id: &str,
        text: &str,
        attachments: Vec<wire::PromptAttachment>,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SessionPrompt {
            task_id: task_id.into(),
            text: text.into(),
            attachments,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the prompt request".into()))
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
    /// Sender back to this actor's command channel — used so background tasks
    /// (e.g. the ACP probe) can deliver results without needing a borrow of the
    /// actor. Held alongside `store` etc. as a primary mutator handle.
    cmd_tx: mpsc::Sender<Command>,
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
    /// Per-orchestrator-task inbox of finished sub-agent results, keyed by the
    /// parent (orchestrator) task id. Drained by the `read_inbox` MCP tool.
    orchestrator_inbox: HashMap<String, Vec<ChildResult>>,
    /// Orchestrator tasks with results that arrived mid-turn: wake them once
    /// their current turn ends (deferred so a fan-out of N completions yields
    /// one wake, and an ignored wake never re-fires into a loop).
    pending_wake: std::collections::HashSet<String>,
    /// Stable first-seen timestamps for streamed frames of the same tool call.
    tool_call_starts: HashMap<(String, String), u64>,
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
        let probe_candidates: Vec<String> = configured_agents
            .iter()
            .filter(|a| a.enabled && a.models.is_empty())
            .map(|a| a.id.clone())
            .collect();

        let needs_setup = store
            .as_ref()
            .map(|s| !s.agents_configured())
            .unwrap_or(false);

        let orch_config = store
            .as_ref()
            .and_then(|s| s.load_orchestrator_config().ok())
            .flatten()
            .unwrap_or_default();

        let tool_call_starts = store
            .as_ref()
            .and_then(|s| s.load_all_session_updates().ok())
            .unwrap_or_default()
            .into_iter()
            .flat_map(|(task_id, updates)| {
                updates.into_iter().filter_map(move |update| match update {
                    wire::SessionUpdate::ToolCall {
                        tool_call_id,
                        started_at: Some(started_at),
                        ..
                    } => Some(((task_id.clone(), tool_call_id), started_at)),
                    _ => None,
                })
            })
            .collect();

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
            cmd_tx: cmd_tx.clone(),
            store,
            resume_replay: HashMap::new(),
            worktrees: HashMap::new(),
            policies: default_policies(),
            policy_tx,
            orch_tx: None,
            orch_event_rx: None,
            orch_config,
            orchestrator_inbox: HashMap::new(),
            pending_wake: std::collections::HashSet::new(),
            tool_call_starts,
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

        // Kick off background ACP probes for agents whose cached model list is
        // stale (enabled + empty `models`). Probes update the cache via
        // `Command::AgentProbed`; cheap to issue even before `run` is ready.
        let probe_tx = handle.cmd_tx.clone();
        if !probe_candidates.is_empty() {
            tokio::spawn(async move {
                for id in probe_candidates {
                    let _ = probe_tx.send(Command::ProbeAgent { id }).await;
                }
            });
        }

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
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));

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
        enum ShutdownReply {
            Requested(oneshot::Sender<()>),
            Update(oneshot::Sender<Vec<String>>),
        }

        let shutdown_reply = loop {
            tokio::select! {
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(Command::Shutdown { reply }) => break Some(ShutdownReply::Requested(reply)),
                        Some(Command::UpdateSafety { reply }) => {
                            let blockers = self.update_blockers_snapshot();
                            if blockers.is_empty() {
                                break Some(ShutdownReply::Update(reply));
                            }
                            let _ = reply.send(blockers);
                        }
                        None => break None,
                        Some(cmd) => self.handle_command(cmd).await,
                    }
                }
                Some(ev) = agent_rx.recv() => self.handle_agent_event(ev),
                Some(ev) = service_rx.recv() => self.handle_service_event(ev),
                Some(ev) = pf_rx.recv() => self.handle_pf_event(ev),
                Some((task_id, update)) = acp_rx.recv() => self.handle_acp_update(task_id, update),
                Some(check) = policy_rx.recv() => self.handle_policy_check(check).await,
            }
        };

        // Teardown — stop everything we started.
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        kill_listeners_in_ranges(&self.project_port_ranges()).await;
        self.agents.kill_all();
        match shutdown_reply {
            Some(ShutdownReply::Requested(reply)) => {
                let _ = reply.send(());
            }
            Some(ShutdownReply::Update(reply)) => {
                let _ = reply.send(Vec::new());
            }
            None => {}
        }
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

    fn update_blockers_snapshot(&self) -> Vec<String> {
        let mut blockers = Vec::new();
        let active_tasks = self
            .tasks
            .values()
            .filter(|task| matches!(task.status, TaskStatus::Queued | TaskStatus::Running))
            .count();
        if active_tasks > 0 {
            blockers.push(format!("{active_tasks} agent task(s) are active"));
        }
        let terminals = self
            .agents
            .all()
            .filter(|agent| {
                matches!(
                    agent.status,
                    AgentStatus::Spawning | AgentStatus::Running | AgentStatus::NeedsReview
                )
            })
            .count();
        if terminals > 0 {
            blockers.push(format!("{terminals} terminal session(s) are active"));
        }
        let transitioning_services = self
            .services
            .all()
            .filter(|service| matches!(service.status, ServiceStatus::Starting))
            .count();
        if transitioning_services > 0 {
            blockers.push(format!(
                "{transitioning_services} service(s) are still starting"
            ));
        }
        let transitioning_forwards = self
            .portforwards
            .forwards
            .values()
            .filter(|forward| matches!(forward.status, PfStatus::Starting | PfStatus::Restarting))
            .count();
        if transitioning_forwards > 0 {
            blockers.push(format!(
                "{transitioning_forwards} port-forward(s) are transitioning"
            ));
        }
        blockers
    }

    async fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::AddProject { path, name, reply } => {
                let result = self.add_project(&path, name.as_deref()).await;
                let _ = reply.send(result);
            }
            Command::RemoveProject { name, reply } => {
                let result = self.remove_project(&name).await;
                let _ = reply.send(result);
            }
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
                parent_task_id,
                attachments,
                default_model,
                reply,
            } => {
                let mut task = Task::new(&project, &prompt, &agent, tags);
                task.parent_task_id = parent_task_id;
                // Create worktree if requested and project has a git repo.
                if use_worktree {
                    if let Some(path) = self.project_path(&project) {
                        let wt_mgr = self.worktrees.entry(project.clone()).or_insert_with(|| {
                            WorktreeManager::new(std::path::PathBuf::from(&path))
                        });
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
                // Resolve the model the session should start with: an explicit
                // UI pick wins; otherwise fall back to the user's last choice
                // for this agent (so orchestrator-spawned sub-agents inherit it
                // without a UI). Update the persisted last-model whenever the
                // user made an explicit pick so the next task defaults to it.
                let resolved_model = default_model.clone().or_else(|| {
                    self.configured_agents
                        .iter()
                        .find(|a| a.id == agent)
                        .and_then(|a| a.last_model.clone())
                });
                if let Some(ref m) = default_model {
                    if let Some(agent_cfg) = self.configured_agents.iter_mut().find(|a| a.id == agent) {
                        if agent_cfg.last_model.as_deref() != Some(m.as_str()) {
                            agent_cfg.last_model = Some(m.clone());
                            if let Some(ref store) = self.store {
                                let _ = store.update_agent_models(
                                    &agent_cfg.id,
                                    &agent_cfg.models,
                                    agent_cfg.last_model.as_deref(),
                                );
                            }
                            let agents = self.configured_agents.clone();
                            self.emit(Event::AgentsUpdated { agents });
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
                    attachments,
                    resolved_model,
                );
            }
            Command::ReadInbox {
                parent_task_id,
                reply,
            } => {
                let results = self
                    .orchestrator_inbox
                    .remove(&parent_task_id)
                    .unwrap_or_default();
                self.pending_wake.remove(&parent_task_id);
                let _ = reply.send(results);
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
            Command::ListFiles {
                task_id,
                project,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
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
            Command::GitPushInfo { task_id, reply } => {
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                let result = match repo {
                    Some(path) => super::diff::push_info(&path)
                        .await
                        .map_err(|e| e.to_string()),
                    None => Err(format!("no repo for task {task_id}")),
                };
                let _ = reply.send(result);
            }
            Command::GitPush {
                task_id,
                force,
                reply,
            } => {
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                let result = match repo {
                    Some(path) => super::diff::push(&path, force).await.unwrap_or_else(|e| {
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
            Command::ArchiveTask { id } => {
                // Collect children that reference this task as parent so we
                // can archive them together with the leader.
                let child_ids: Vec<String> = self
                    .tasks
                    .values()
                    .filter(|t| t.parent_task_id.as_deref() == Some(&id))
                    .map(|t| t.id.clone())
                    .collect();

                // Archive the leader itself.
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(TaskStatus::Done);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }

                // Archive every direct child so the whole group moves to history.
                for cid in child_ids {
                    if let Some(child) = self.tasks.get_mut(&cid) {
                        child.set_status(TaskStatus::Done);
                        let updated = child.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
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
                    self.tool_call_starts
                        .retain(|(task_id, _), _| task_id != &id);
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
                self.start_session(&id, &project, &agent, "", false, Some(session_id), vec![], None);
            }
            Command::SessionPrompt {
                task_id,
                text,
                attachments,
                reply,
            } => {
                let root = self.tasks.get(&task_id).map(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                        .unwrap_or_else(|| ".".into())
                });
                let prepared = root
                    .ok_or_else(|| format!("unknown task {task_id}"))
                    .and_then(|root| {
                        super::prompt::prepare_prompt(
                            std::path::Path::new(&root),
                            text.clone(),
                            &attachments,
                        )
                    });
                let prepared = match prepared {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let user_update = wire::SessionUpdate::UserMessage {
                    text: text.clone(),
                    attachments: prepared.summaries.clone(),
                };
                let live_delivery = self
                    .sessions
                    .get(&task_id)
                    .cloned()
                    .map(|handle| handle.prompt(prepared.clone()));
                match live_delivery {
                    Some(Ok(())) => {
                        self.mark_task_running(&task_id);
                        // Echo the developer's message through the same
                        // persisted stream as agent updates. If a reconnect
                        // retry submits the same text again after the first
                        // attempt was already recorded, keep the transcript
                        // readable by dropping only that exact consecutive
                        // duplicate.
                        self.emit_session_unless_last_duplicate(&task_id, user_update);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Err(_)) | None => {
                        // A closed command channel is a stale handle. Remove it
                        // before reconnecting so its last process guard can
                        // terminate/reap the old child.
                        self.sessions.remove(&task_id);
                        let resume = self.tasks.get(&task_id).and_then(|task| {
                            task.session_id.as_ref().map(|session_id| {
                                (task.project.clone(), task.agent.clone(), session_id.clone())
                            })
                        });

                        if let Some((project, agent, session_id)) = resume {
                            self.mark_task_running(&task_id);
                            self.prepare_resume_replay_guard(&task_id);
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
                                attachments,
                                None,
                            );
                            let _ = reply.send(Ok(()));
                        } else {
                            // Reject without echoing a user message that was never delivered.
                            let _ = reply.send(Err("no live or resumable agent session".into()));
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
                self.emit(Event::AgentsUpdated { agents: self.configured_agents.clone() });
                // Probe any newly-enabled agent without cached models.
                let probe_ids: Vec<String> = self
                    .configured_agents
                    .iter()
                    .filter(|a| a.enabled && a.models.is_empty())
                    .map(|a| a.id.clone())
                    .collect();
                for id in probe_ids {
                    let _ = self.cmd_tx.send(Command::ProbeAgent { id }).await;
                }
            }
            Command::ProbeAgent { id } => {
                if let Some(agent) = self.configured_agents.iter().find(|a| a.id == id) {
                    if !agent.enabled || agent.models.is_empty() {
                        let acp_command = agent.acp_command.clone();
                        let agent_id = agent.id.clone();
                        let last_model = agent.last_model.clone();
                        let cmd_tx = self.cmd_tx.clone();
                        let cwd = std::env::current_dir()
                            .unwrap_or_else(|_| std::path::PathBuf::from("."));
                        tokio::spawn(async move {
                            let res = super::agent_probe::probe_models(
                                &acp_command,
                                &cwd,
                            )
                            .await;
                            let models = match res {
                                Ok(m) => m,
                                Err(e) => {
                                    eprintln!(
                                        "[daemon] ACP probe failed for agent '{agent_id}': {e}"
                                    );
                                    Vec::new()
                                }
                            };
                            let _ = cmd_tx
                                .send(Command::AgentProbed {
                                    id: agent_id,
                                    models,
                                    last_model,
                                })
                                .await;
                        });
                    }
                }
            }
            Command::AgentProbed {
                id,
                models,
                last_model,
            } => {
                if let Some(agent) = self.configured_agents.iter_mut().find(|a| a.id == id) {
                    agent.models = models.clone();
                    agent.last_model = last_model.clone();
                    if let Some(store) = &self.store {
                        let _ = store.update_agent_models(
                            &id,
                            &models,
                            last_model.as_deref(),
                        );
                    }
                }
                self.emit(Event::AgentsUpdated {
                    agents: self.configured_agents.clone(),
                });
            }
            Command::StartOrchestration {
                project,
                goal,
                reply,
            } => {
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
                        let result = rrx.await.unwrap_or_default();
                        let _ = reply.send(result);
                    });
                } else {
                    let _ = reply.send((String::new(), String::new()));
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
            Command::SetTaskStatus { id, status } => {
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(status);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    /// "Opening" a project starts both its declared services and port-forwards
    /// (what entering a project did implicitly in the TUI).
    async fn open_project(&mut self, name: &str) {
        self.start_services(name).await;
        self.start_portforwards(name).await;
    }

    /// Register a new project: write to registry, generate config if missing,
    /// add to in-memory list, and broadcast the update to all clients.
    async fn add_project(
        &mut self,
        path: &str,
        name: Option<&str>,
    ) -> Result<ProjectEntry, String> {
        let entry =
            crate::registry::add_project(path, name).map_err(|e| format!("registry: {e}"))?;

        // Generate .warpforge.yaml if none exists.
        let config_file = crate::config::find_config_file(std::path::Path::new(&entry.path));
        if !config_file.exists() {
            crate::config::generate_workspace_yaml(std::path::Path::new(&entry.path)).ok();
            // non-fatal if it fails
        }

        // Add to in-memory list.
        self.projects.push(entry.clone());

        // Broadcast to all subscribed clients.
        let index = self.projects.len() - 1;
        let (start, end) = crate::ports::port_range(index);
        let config = load_workspace_config(std::path::Path::new(&entry.path));
        let declared_services = config.as_ref().map(sorted_services).unwrap_or_default();
        let agent_templates = config
            .as_ref()
            .and_then(|c| c.agent_templates.clone())
            .map(|m| m.into_iter().map(|(k, v)| (k, v.command)).collect())
            .unwrap_or_default();
        let info = wire::ProjectInfo {
            name: entry.name.clone(),
            path: entry.path.clone(),
            port_range: (start, end),
            declared_services,
            agent_templates,
        };
        self.emit(Event::ProjectAdded(info));

        Ok(entry)
    }

    /// Remove a project from the registry, in-memory list, and broadcast.
    async fn remove_project(&mut self, name: &str) -> Result<(), String> {
        crate::registry::remove_project(name).map_err(|e| format!("registry: {e}"))?;

        self.projects.retain(|p| p.name != name);

        self.emit(Event::ProjectRemoved {
            name: name.to_string(),
        });

        Ok(())
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
    /// Enabled agent ids the orchestrator may delegate to (from the registry).
    fn available_agent_ids(&self) -> Vec<String> {
        self.configured_agents
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect()
    }

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
    #[allow(clippy::too_many_arguments)]
    fn start_session(
        &mut self,
        task_id: &str,
        project: &str,
        agent: &str,
        prompt: &str,
        include_runtime_context: bool,
        resume: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
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
        // An orchestrator-chat session gets the warpforge MCP bridge (spawn_agent
        // / read_inbox tools) and an orchestrator system preamble; a plain task
        // gets neither.
        let is_orchestrator = self
            .tasks
            .get(task_id)
            .is_some_and(|t| t.tags.iter().any(|x| x == "orchestrator-chat"));
        let (mcp_servers, base_prompt) = if is_orchestrator {
            let agents = self.available_agent_ids();
            let roster = if agents.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\nAgents you can pass to spawn_agent: {}.",
                    agents.join(", ")
                )
            };
            (
                orchestrator_mcp_servers(task_id, project),
                format!("{ORCHESTRATOR_SYSTEM}{roster}\n\n{prompt}"),
            )
        } else {
            (Vec::new(), prompt.to_string())
        };
        let full_prompt = match include_runtime_context
            .then(|| self.runtime_context(project))
            .flatten()
        {
            Some(ctx) => format!("{ctx}\n\n{base_prompt}"),
            None => base_prompt,
        };
        let prepared_prompt = match super::prompt::prepare_prompt(
            std::path::Path::new(&cwd),
            full_prompt,
            &attachments,
        ) {
            Ok(prompt) => prompt,
            Err(error) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(error);
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                return;
            }
        };
        if !prompt.is_empty() || !prepared_prompt.summaries.is_empty() {
            self.emit_session_unless_last_duplicate(
                task_id,
                wire::SessionUpdate::UserMessage {
                    text: prompt.to_string(),
                    attachments: prepared_prompt.summaries.clone(),
                },
            );
        }
        match spawn_acp_session(
            task_id.to_string(),
            command,
            cwd,
            prepared_prompt,
            resume,
            mcp_servers,
            self.acp_tx.clone(),
            Some(self.policy_tx.clone()),
            default_model,
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
            } => {
                let key = (task_id.clone(), id.clone());
                let started_at = *self.tool_call_starts.entry(key).or_insert_with(|| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                });
                self.emit_acp_session(
                    &task_id,
                    wire::SessionUpdate::ToolCall {
                        tool_call_id: id,
                        title,
                        status: wireconv::tool_status(&status),
                        started_at: Some(started_at),
                        tool_kind: kind,
                        content,
                    },
                )
            }
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
            AcpUpdate::Usage { used, size, cost } => self.emit_session_unless_last_duplicate(
                &task_id,
                wire::SessionUpdate::Usage { used, size, cost },
            ),
            AcpUpdate::PromptCapabilities {
                image,
                embedded_context,
            } => self.emit_session(
                &task_id,
                wire::SessionUpdate::PromptCapabilities {
                    image,
                    embedded_context,
                },
            ),
            AcpUpdate::FileEdit {
                path,
                tool_call_id,
                additions,
                deletions,
            } => {
                let update = wire::SessionUpdate::FileEdit {
                    path,
                    tool_call_id: Some(tool_call_id),
                    additions,
                    deletions,
                };
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
                let output = self.collect_agent_text(&task_id);
                self.notify_orch_finished(&task_id, success, output.clone());
                // Deliver to a parent if this was a sub-agent; and drain our own
                // inbox if we are a parent that just went idle.
                self.deliver_child_result(&task_id, success, output);
                // If we are an orchestrator whose sub-agents finished mid-turn,
                // process them now that the turn is over.
                if self.pending_wake.remove(&task_id) {
                    self.wake_parent(&task_id);
                }
            }
            AcpUpdate::Error { run_id, message } => {
                if self
                    .sessions
                    .get(&task_id)
                    .is_some_and(|handle| handle.run_id() != run_id)
                {
                    return;
                }
                let reason = message.clone();
                // Remove dead ACP handle so subsequent prompts trigger resume.
                self.sessions.remove(&task_id);
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.notify_orch_finished(&task_id, false, reason.clone());
                self.deliver_child_result(&task_id, false, reason);
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
            .is_some_and(|t| t.tags.iter().any(|tag| tag == "orchestrator"));
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

    /// If `child_id` was spawned by an orchestrator, queue its result in the
    /// parent's inbox and (if the parent is idle) wake it.
    fn deliver_child_result(&mut self, child_id: &str, success: bool, output: String) {
        let Some(child) = self.tasks.get(child_id) else {
            return;
        };
        let Some(parent_id) = child.parent_task_id.clone() else {
            return;
        };
        let result = ChildResult {
            child_id: child_id.to_string(),
            agent: child.agent.clone(),
            prompt: child.prompt.clone(),
            output,
            success,
        };
        self.orchestrator_inbox
            .entry(parent_id.clone())
            .or_default()
            .push(result);
        // Wake now if the orchestrator is idle; otherwise defer to its turn end.
        let running = self
            .tasks
            .get(&parent_id)
            .is_some_and(|t| t.status == TaskStatus::Running);
        if running {
            self.pending_wake.insert(parent_id);
        } else {
            self.wake_parent(&parent_id);
        }
    }

    /// Inject a system nudge into an orchestrator's session so it drains its
    /// inbox. No-op if the inbox is empty.
    fn wake_parent(&mut self, parent_id: &str) {
        let pending = self
            .orchestrator_inbox
            .get(parent_id)
            .map_or(0, |v| v.len());
        if pending == 0 {
            return;
        }
        let Some(handle) = self.sessions.get(parent_id).cloned() else {
            // Orchestrator session isn't live right now (e.g. it ended while a
            // sub-agent was still running). Keep the results queued and retry
            // the nudge when the parent next runs (its next turn end).
            self.pending_wake.insert(parent_id.to_string());
            return;
        };
        self.mark_task_running(parent_id);
        let _ = handle.prompt(super::prompt::PreparedPrompt {
            content: vec![super::prompt::PromptContent::Text(format!(
                "[System] {pending} sub-agent result(s) ready in your inbox. \
                 Call the read_inbox tool to collect them, then decide what to do next."
            ))],
            summaries: vec![],
            has_images: false,
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
