//! Wire types for the warpforge daemon API.
//!
//! Transport: WebSocket on 127.0.0.1 (endpoint + auth token published in
//! `~/.warpforge/daemon.json`). Every frame is a JSON object in one of three
//! shapes:
//!
//! - client → daemon  request:  `{ "id": 7, "method": "task.create", "params": { … } }`
//! - daemon → client  response: `{ "id": 7, "result": { … } }` or `{ "id": 7, "error": { … } }`
//! - daemon → client  event:    `{ "event": "service.log", "data": { … } }`
//!
//! Events are broadcast to every subscribed client — the daemon has no concept
//! of a "primary" UI. Clients call `state.subscribe` once after connecting and
//! receive a full [`Snapshot`] followed by incremental events.
//!
//! This crate is deliberately dependency-light (serde only) so the TUI, the
//! Tauri shell's Rust side, and any future client can share it without pulling
//! in daemon internals.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Version of the daemon WebSocket contract. Bump this only for a breaking
/// wire change; application versions may advance without changing it.
pub const PROTOCOL_VERSION: u32 = 1;

fn default_true() -> bool {
    true
}

// ─── Envelope ────────────────────────────────────────────────────────────────

/// A client → daemon frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub method: Method,
}

/// A daemon → client frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
// Events intentionally stay inline: this is the shared wire envelope and
// boxing only one variant would leak an allocation detail into every client.
#[allow(clippy::large_enum_variant)]
pub enum ServerMessage {
    Response { id: u64, result: serde_json::Value },
    Error { id: u64, error: RpcError },
    Event(Event),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    NotFound,
    Conflict,
    AgentUnavailable,
    Internal,
    Updating,
}

// ─── Methods (client → daemon) ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum Method {
    /// Negotiate the wire contract before a client enables mutations.
    #[serde(rename = "system.handshake")]
    SystemHandshake {
        client_version: String,
        protocol_version: u32,
    },
    /// Quiesce a desktop-owned daemon and shut it down for an atomic app
    /// update. Refused for externally started daemons or active work.
    #[serde(rename = "update.prepareShutdown")]
    UpdatePrepareShutdown {
        expected_daemon_version: String,
        protocol_version: u32,
    },

    /// Subscribe to state updates. Response is a [`Snapshot`]; events follow.
    #[serde(rename = "state.subscribe")]
    StateSubscribe {
        /// Empty = everything. Otherwise topic prefixes: "task", "service",
        /// "portforward", "agent", "project".
        #[serde(default)]
        topics: Vec<String>,
    },

    // ── Projects ──
    #[serde(rename = "project.add")]
    ProjectAdd { path: String, name: Option<String> },
    #[serde(rename = "project.remove")]
    ProjectRemove { name: String },

    // ── Runtime lifecycle ──
    /// Stop all running dev services and port-forwards without shutting down
    /// the daemon or killing agent sessions.
    #[serde(rename = "runtime.stopAll")]
    RuntimeStopAll {},

    // ── Dev servers (existing ServiceManager behaviour, exposed) ──
    #[serde(rename = "service.start")]
    ServiceStart { project: String, service: String },
    #[serde(rename = "service.stop")]
    ServiceStop { project: String, service: String },
    #[serde(rename = "service.restart")]
    ServiceRestart { project: String, service: String },
    /// Start every service declared in the project's .warpforge.yaml
    /// (what the TUI did implicitly on "Enter project").
    #[serde(rename = "service.startAll")]
    ServiceStartAll { project: String },
    #[serde(rename = "service.stopAll")]
    ServiceStopAll { project: String },
    /// Fetch a window of retained log lines (events only carry the tail).
    #[serde(rename = "service.logs")]
    ServiceLogs {
        project: String,
        service: String,
        /// Return lines with seq > after. 0 = from the oldest retained line.
        #[serde(default)]
        after: u64,
        #[serde(default)]
        limit: Option<u32>,
    },

    // ── Port-forwards ──
    #[serde(rename = "portforward.startAll")]
    PortForwardStartAll { project: String },
    #[serde(rename = "portforward.start")]
    PortForwardStart { project: String, name: String },
    #[serde(rename = "portforward.stop")]
    PortForwardStop { project: String, name: String },

    // ── Tasks (agent sessions on the board) ──
    #[serde(rename = "task.create")]
    TaskCreate {
        project: String,
        /// Prompt / instruction handed to the agent.
        prompt: String,
        /// Agent template name from .warpforge.yaml, or a raw command.
        agent: String,
        #[serde(default)]
        tags: Vec<String>,
        /// When true (default), the daemon prepends a runtime-context block to
        /// the agent's first prompt describing the project's currently-running
        /// services and their live URLs/ports — so the agent knows the app is
        /// already up and can hit real endpoints / run tests against them.
        /// This is what ties Projects to agent work (see docs/UI_CONCEPT.md).
        #[serde(default = "default_true")]
        include_runtime_context: bool,
        /// When true, create an isolated git worktree for this task so it
        /// doesn't conflict with the main working tree or other tasks.
        #[serde(default)]
        worktree: bool,
        /// When set, this task is a sub-agent spawned by the given orchestrator
        /// task; its result is delivered back into that orchestrator's inbox.
        #[serde(default)]
        parent_task_id: Option<String>,
        /// Files and images included with the initial prompt.
        #[serde(default)]
        attachments: Vec<PromptAttachment>,
        /// Model id to apply to the agent session before the first prompt
        /// (via `session/setConfigOption`). When `None`, the daemon falls back
        /// to the agent's `last_model` so orchestrator-spawned sub-agents
        /// inherit the user's previous choice without an explicit UI pick.
        #[serde(default)]
        default_model: Option<String>,
    },
    #[serde(rename = "task.cancel")]
    TaskCancel { task_id: String },
    /// Archive a finished task off the board.
    #[serde(rename = "task.archive")]
    TaskArchive { task_id: String },
    /// Delete a task and its persisted session history permanently.
    #[serde(rename = "task.delete")]
    TaskDelete { task_id: String },
    /// Merge a task's worktree branch back into its base branch and remove
    /// the worktree. No-op if the task has no worktree.
    #[serde(rename = "task.mergeWorktree")]
    TaskMergeWorktree { task_id: String },
    /// List active worktrees for a project.
    #[serde(rename = "task.listWorktrees")]
    TaskListWorktrees { project: String },

    // ── External agent sessions (claude/codex on-disk session stores) ──
    /// List agent sessions found on disk for a project's working directory.
    /// Returns `{ sessions: ExternalSession[] }`.
    #[serde(rename = "sessions.list")]
    SessionsList { project: String },
    /// Resume an existing external agent session as a new warpforge task.
    /// Returns `{ taskId }`.
    #[serde(rename = "task.resume")]
    TaskResume {
        project: String,
        agent: String,
        session_id: String,
        #[serde(default)]
        title: String,
    },

    /// Drain an orchestrator task's inbox of finished sub-agent results.
    /// Returns `{ results: ChildResult[] }`. Called by the orchestrator's
    /// `read_inbox` MCP tool.
    #[serde(rename = "orchestrator.readInbox")]
    OrchestratorReadInbox { parent_task_id: String },

    // ── Agent registry ──
    /// Detect installed ACP-capable agents. Returns `{ detected: DetectedAgent[] }`.
    #[serde(rename = "agents.detect")]
    AgentsDetect {},
    /// Save the user's agent configuration (from setup wizard or settings).
    #[serde(rename = "agents.update")]
    AgentsUpdate { agents: Vec<AgentConfig> },

    // ── ACP passthrough for a task's agent session ──
    /// Send a follow-up user message into a running session.
    #[serde(rename = "session.prompt")]
    SessionPrompt {
        task_id: String,
        text: String,
        #[serde(default)]
        attachments: Vec<PromptAttachment>,
    },
    /// Answer a permission request raised by the agent.
    #[serde(rename = "session.permission")]
    SessionPermission {
        task_id: String,
        request_id: String,
        outcome: PermissionOutcome,
    },
    /// Change a session selector (model/mode/…) the agent exposes.
    #[serde(rename = "session.setConfigOption")]
    SessionSetConfigOption {
        task_id: String,
        config_id: String,
        value: String,
    },

    // ── Diff / review ──
    #[serde(rename = "diff.get")]
    DiffGet { task_id: String },
    #[serde(rename = "diff.resolveHunk")]
    DiffResolveHunk {
        task_id: String,
        file: String,
        hunk_index: u32,
        resolution: HunkResolution,
    },
    /// Full old (HEAD) + new (working-tree) contents of one file — powers the
    /// editable side-by-side (CodeMirror merge) review.
    #[serde(rename = "file.contents")]
    FileContents { task_id: String, path: String },
    /// List files in the task's project working tree.
    #[serde(rename = "file.list")]
    FileList {
        #[serde(default)]
        task_id: String,
        #[serde(default)]
        project: Option<String>,
    },
    /// Write new contents to a file in the task's working tree (in-review edit).
    #[serde(rename = "file.save")]
    FileSave {
        task_id: String,
        path: String,
        content: String,
    },
    /// Stage files and commit them in the task's repo. `files=None` stages all
    /// changes; `amend` rewrites the previous commit.
    #[serde(rename = "git.commit")]
    GitCommit {
        task_id: String,
        message: String,
        #[serde(default)]
        files: Option<Vec<String>>,
        #[serde(default)]
        amend: bool,
    },
    /// Pull the task's project repo up to its upstream (rebase + autostash).
    /// Any conflict rolls the working tree back to the exact prior state.
    #[serde(rename = "git.update")]
    GitUpdate { task_id: String },
    /// List local branches of the task's project repo.
    #[serde(rename = "git.branches")]
    GitBranches { task_id: String },
    /// Switch the task's project repo to `branch`, carrying uncommitted changes
    /// across (stash → checkout → unstash). A conflict rolls back to the branch
    /// you were on with your changes intact.
    #[serde(rename = "git.switchBranch")]
    GitSwitchBranch { task_id: String, branch: String },
    /// Describe the commits and files that would be sent by `git.push`.
    #[serde(rename = "git.pushInfo")]
    GitPushInfo { task_id: String },
    /// Push the current branch. With `force`, uses `--force-with-lease`.
    #[serde(rename = "git.push")]
    GitPush {
        task_id: String,
        #[serde(default)]
        force: bool,
    },

    // ── Raw terminal agents (legacy PTY sessions, kept for the TUI) ──
    #[serde(rename = "terminal.spawn")]
    TerminalSpawn { project: String, command: String },
    #[serde(rename = "terminal.input")]
    TerminalInput {
        terminal_id: String,
        /// Base64-encoded raw bytes for the PTY.
        data_b64: String,
    },
    #[serde(rename = "terminal.resize")]
    TerminalResize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "terminal.kill")]
    TerminalKill { terminal_id: String },

    // ── Orchestration ──
    /// Start an orchestration: planner → workers → reviewers pipeline.
    /// Returns `{ graphId, taskId }` — the taskId is the parent orchestrator task.
    #[serde(rename = "orchestrate.start")]
    OrchestrateStart { project: String, goal: String },
    /// List active orchestration graphs.
    #[serde(rename = "orchestrate.list")]
    OrchestrateList {},
    /// Cancel an orchestration and its child tasks.
    #[serde(rename = "orchestrate.cancel")]
    OrchestrateCancel { graph_id: String },
    /// Get the orchestrator configuration.
    #[serde(rename = "orchestrate.getConfig")]
    OrchestrateGetConfig {},
    /// Save the orchestrator configuration.
    #[serde(rename = "orchestrate.saveConfig")]
    OrchestrateSaveConfig { config: OrchestratorConfigDto },

    // ── Bootstrap wizard (desktop) ──
    /// Scan the repo, build the bootstrap prompt from the user's answers, and
    /// create a config-gen task. Returns `{ taskId }`.
    #[serde(rename = "bootstrap.start")]
    BootstrapStart {
        project: String,
        answers: BootstrapAnswers,
    },
    /// Extract the YAML from an agent response and validate it. Returns
    /// `{ yaml, issues: [{ severity, message }] }`.
    #[serde(rename = "bootstrap.finalize")]
    BootstrapFinalize { response: String },
    /// Read the project's current config file and validate it. Used after a
    /// bootstrap task to review what the agent wrote. Returns
    /// `{ yaml, issues: [{ severity, message }] }`.
    #[serde(rename = "bootstrap.readConfig")]
    BootstrapReadConfig { project: String },
    /// Write the accepted YAML to the project's config file. Returns
    /// `{ ok, path }`.
    #[serde(rename = "bootstrap.writeConfig")]
    BootstrapWriteConfig { project: String, yaml: String },
}

/// Answers collected by the desktop bootstrap wizard. Mirrors the daemon's
/// `bootstrap::UserRuntimeAnswers`; `runtime_kind` is one of `local`,
/// `docker-compose`, `kubernetes`, `mixed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAnswers {
    pub agent: String,
    pub runtime_kind: String,
    #[serde(default)]
    pub compose_path: String,
    #[serde(default)]
    pub k8s_manifests_path: String,
    #[serde(default)]
    pub k8s_helm_file: String,
    #[serde(default)]
    pub k8s_release_names: String,
    #[serde(default)]
    pub k8s_namespace: String,
    #[serde(default)]
    pub dev_commands: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    Allow,
    AllowAlways,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HunkResolution {
    Accept,
    Reject,
}

// ─── Events (daemon → client) ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// Full state snapshot, sent as the reply-adjacent first event after
    /// `state.subscribe` and again after daemon-side recovery.
    #[serde(rename = "state.snapshot")]
    Snapshot(Snapshot),

    #[serde(rename = "project.added")]
    ProjectAdded(ProjectInfo),
    #[serde(rename = "project.removed")]
    ProjectRemoved { name: String },

    #[serde(rename = "service.status")]
    ServiceStatus {
        project: String,
        service: String,
        status: ServiceStatus,
        allocated_port: u16,
    },
    #[serde(rename = "service.log")]
    ServiceLog {
        project: String,
        service: String,
        /// Monotonic per-service sequence number so clients can detect gaps
        /// and backfill via `service.logs`.
        seq: u64,
        line: String,
    },

    #[serde(rename = "portforward.status")]
    PortForwardStatus {
        project: String,
        name: String,
        status: PortForwardStatus,
    },
    #[serde(rename = "portforward.log")]
    PortForwardLog {
        project: String,
        name: String,
        seq: u64,
        line: String,
    },

    #[serde(rename = "task.created")]
    TaskCreated(TaskInfo),
    #[serde(rename = "task.updated")]
    TaskUpdated(TaskInfo),
    /// A task was deleted; clients should drop it from all views.
    #[serde(rename = "task.removed")]
    TaskRemoved { id: String },

    /// Structured ACP session update for a task: tool calls, agent text,
    /// file edits, permission requests. Mirrors ACP `session/update`.
    #[serde(rename = "session.update")]
    SessionUpdate {
        task_id: String,
        update: SessionUpdate,
    },

    /// Daemon detected installed agents on first start; no agents configured
    /// yet. Frontend should show the setup wizard.
    #[serde(rename = "agents.setup_needed")]
    AgentsSetupNeeded { detected: Vec<DetectedAgent> },

    /// Agent registry updated (after setup wizard or settings change).
    #[serde(rename = "agents.updated")]
    AgentsUpdated { agents: Vec<AgentConfig> },

    /// Terminal (PTY) screen changed. Carries the rendered screen contents,
    /// not raw bytes — every client sees the same vt100 state.
    #[serde(rename = "terminal.screen")]
    TerminalScreen {
        terminal_id: String,
        screen: TerminalScreen,
    },
    #[serde(rename = "terminal.exited")]
    TerminalExited { terminal_id: String, code: i32 },

    // ── Orchestration ──
    /// A worker/reviewer node was dispatched.
    #[serde(rename = "orchestration.nodeDispatched")]
    OrchestrationNodeDispatched {
        graph_id: String,
        node_id: String,
        task_id: String,
        agent: String,
        kind: String,
    },
    /// A node completed successfully.
    #[serde(rename = "orchestration.nodeCompleted")]
    OrchestrationNodeCompleted {
        graph_id: String,
        node_id: String,
        task_id: String,
    },
    /// A node failed.
    #[serde(rename = "orchestration.nodeFailed")]
    OrchestrationNodeFailed {
        graph_id: String,
        node_id: String,
        task_id: String,
        reason: String,
    },
    /// All nodes in the orchestration are done.
    #[serde(rename = "orchestration.allComplete")]
    OrchestrationAllComplete { graph_id: String, project: String },
}

// ─── State DTOs ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub projects: Vec<ProjectInfo>,
    pub services: Vec<ServiceInfo>,
    pub portforwards: Vec<PortForwardInfo>,
    pub tasks: Vec<TaskInfo>,
    pub terminals: Vec<TerminalInfo>,
    /// Persisted session conversation history keyed by task id. Sent on
    /// `state.subscribe` so clients can reconstruct conversations without
    /// polling. Omitted from the wire when empty.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub session_history: HashMap<String, Vec<SessionUpdate>>,
    /// All configured agents (enabled or not). Empty until the user completes
    /// the setup wizard.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    /// Inclusive port range assigned to this project.
    pub port_range: (u16, u16),
    /// Services declared in .warpforge.yaml (may not be running).
    pub declared_services: Vec<String>,
    pub agent_templates: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub project: String,
    pub name: String,
    pub command: String,
    pub status: ServiceStatus,
    pub original_port: u16,
    pub allocated_port: u16,
    /// Sequence number of the newest retained log line.
    pub log_seq: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceStatus {
    Starting,
    Running,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub project: String,
    pub name: String,
    pub namespace: String,
    pub pod: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub status: PortForwardStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortForwardStatus {
    Starting,
    Active,
    Restarting,
    Failed,
    Stopped,
}

/// A task on the board: one agent session working on one prompt in one project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub project: String,
    pub prompt: String,
    pub agent: String,
    pub status: TaskStatus,
    pub tags: Vec<String>,
    /// Unix seconds.
    pub created_at: u64,
    pub updated_at: u64,
    /// Files touched so far (drives the board card's diff badge).
    pub files_changed: u32,
    /// Set when status == Blocked or Failed.
    pub blocked_reason: Option<String>,
    /// Session selectors (model/mode/…) reported by the agent. The daemon
    /// persists the last known set so resumed/interrupted tasks can still show
    /// their controls after a restart.
    #[serde(default)]
    pub config_options: Vec<ConfigOption>,
    /// Path to the git worktree for this task, if isolated.
    /// `null` / omitted when the task runs in the project's main working dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// Orchestration graph for parent orchestrator tasks. Contains child nodes
    /// (workers/reviewers) each with their own task_id for navigation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_graph: Option<OrchGraphInfo>,
    /// Task that spawned this task through the orchestrator MCP. Keeping this
    /// on the wire lets clients present the child in its parent's context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
}

/// Board columns. `Interrupted` covers sessions whose live ACP handle was lost
/// to a daemon restart. If the task has a saved native session id and the agent
/// supports `session/load`, the daemon can reconnect when the user continues.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    /// The agent finished a turn that produced no changes and is now waiting for
    /// your next message. Distinct from `NeedsReview` (which means there are
    /// uncommitted changes to look at) and `Done` (finished/archived).
    Idle,
    NeedsReview,
    Done,
    Blocked,
    Interrupted,
}

/// Structured agent-session update, a deliberately small projection of ACP's
/// `session/update` notification. Extend as views need more.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageCost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionUpdate {
    /// The developer's own prompt, echoed by the daemon into the stream so
    /// every attached client shows the same conversation.
    UserMessage {
        text: String,
        #[serde(default)]
        attachments: Vec<PromptAttachmentSummary>,
    },
    PromptCapabilities {
        image: bool,
        embedded_context: bool,
    },
    AgentText {
        text: String,
    },
    AgentThought {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        status: ToolCallStatus,
        /// Unix epoch milliseconds when the daemon first observed this call.
        /// Optional for histories written by older Warpforge versions.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<u64>,
        /// ACP tool kind: read/edit/delete/move/search/execute/think/fetch/other.
        #[serde(default)]
        tool_kind: String,
        /// Rendered tool output/content, if the agent included any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    FileEdit {
        path: String,
        /// ACP tool-call id, used by clients to coalesce lifecycle frames for
        /// the same edit. Optional for histories written by older versions.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        /// Line-level changes reported by this individual edit operation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        additions: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deletions: Option<u32>,
    },
    PermissionRequest {
        request_id: String,
        title: String,
        options: Vec<String>,
    },
    /// A permission request the developer answered — recorded in the stream so
    /// the resolved state survives reopen/restart (the request itself lingers).
    PermissionResolved {
        request_id: String,
        outcome: String,
    },
    /// The agent's plan / todo list (ACP `plan` update).
    Plan {
        entries: Vec<PlanEntry>,
    },
    /// Slash-commands the agent exposes (ACP `available_commands_update`).
    AvailableCommands {
        commands: Vec<CommandInfo>,
    },
    /// Current ACP context-window utilization and optional cumulative cost.
    Usage {
        used: u64,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<SessionUsageCost>,
    },
    TurnEnded {
        stop_reason: String,
    },
}

/// A transient attachment sent with a prompt. Image data is never persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptAttachment {
    File {
        path: String,
    },
    Image {
        name: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
    },
}

/// Safe, persistence-friendly attachment metadata stored in the transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptAttachmentSummary {
    File { path: String },
    Image { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    /// "pending" | "in_progress" | "completed".
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// A session-level selector the agent exposes (ACP `configOptions`): model,
/// mode, reasoning effort, etc. We surface it read-only for now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    /// "mode" | "model" | "model_config" | "thought_level" | …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub current_value: String,
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

// ─── Git operations (update / branch switch) ────────────────────────────────

/// Machine-readable outcome of a `git.update` / `git.switchBranch` op.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitOpStatus {
    /// Nothing to do — already up to date / already on that branch.
    UpToDate,
    /// Completed cleanly (pulled, or switched with changes carried over).
    Ok,
    /// A conflict was hit and the working tree was rolled back to the exact
    /// prior state. `conflicts` lists the files that blocked it.
    Conflict,
    /// Precondition failed (no upstream, detached HEAD, unknown branch, …).
    Error,
}

/// Result of `git.update` / `git.switchBranch`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    pub status: GitOpStatus,
    /// Human-readable one-liner for the toast/banner.
    pub message: String,
    /// Files that blocked the op (on `Conflict`); empty otherwise.
    #[serde(default)]
    pub conflicts: Vec<String>,
    /// Current branch after the op (so the UI can refresh its chip).
    #[serde(default)]
    pub branch: Option<String>,
}

/// Result of `git.branches`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
    #[serde(default)]
    pub current: Option<String>,
    pub branches: Vec<String>,
}

/// One file contained in an outgoing commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushFile {
    pub path: String,
    /// Git's compact name-status code (`A`, `M`, `D`, `R`, …).
    pub status: String,
}

/// One commit that is not present on the push target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub files: Vec<GitPushFile>,
}

/// Preview returned by `git.pushInfo`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushInfo {
    pub branch: String,
    pub remote: String,
    pub remote_branch: String,
    /// Configured upstream, or the target Warpforge will create on first push.
    pub upstream: String,
    pub has_upstream: bool,
    pub commits: Vec<GitPushCommit>,
}

// ─── Diff / review ───────────────────────────────────────────────────────────

/// Result of `diff.get`: the task's working-tree changes, per file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub task_id: String,
    pub files: Vec<FileDiff>,
    /// Current git branch of the task's project, if it's a repo.
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileDiffStatus,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileDiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Unified-diff body lines, each prefixed with ' ', '+', or '-'.
    pub lines: Vec<String>,
    pub resolution: Option<HunkResolution>,
}

/// Result of `file.contents`: a file's HEAD (old) and working-tree (new) text,
/// for the editable side-by-side (CodeMirror merge) review.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDoc {
    pub path: String,
    pub status: FileDiffStatus,
    pub old_text: String,
    pub new_text: String,
}

/// Result of `file.list`: project files available to open in the editor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    #[serde(default)]
    pub changed: bool,
}

// ─── Terminal agents (legacy PTY path) ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub project: String,
    pub command: String,
    pub started_at: u64,
    pub cols: u16,
    pub rows: u16,
}

/// A rendered vt100 screen. Row-oriented so clients don't need a terminal
/// emulator: the daemon owns the single authoritative vt100 parser.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreen {
    pub cols: u16,
    pub rows: u16,
    pub cursor: (u16, u16),
    /// One entry per row; each row is a run-length list of styled spans.
    pub rows_content: Vec<Vec<StyledSpan>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyledSpan {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inverse: bool,
}

// ─── Agent registry ──────────────────────────────────────────────────────────

/// A user-configured ACP agent (persisted in SQLite, managed via UI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub display_name: String,
    /// The ACP server command run as `sh -c <acp_command>`.
    pub acp_command: String,
    pub enabled: bool,
    /// Cached model/effort selectors the agent exposed via its last ACP
    /// `session/update` (`configOptions`). Probed once on enable and refreshed
    /// on daemon startup so the New Task view can offer a model picker before
    /// any prompt is sent. Empty when the probe failed or the agent exposes no
    /// model selector.
    #[serde(default)]
    pub models: Vec<ConfigOption>,
    /// Last model the user explicitly picked when starting a task with this
    /// agent. Used as the default for new tasks and for orchestrator-spawned
    /// sub-agents (which have no UI to pick from). `None` until the first
    /// explicit choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_model: Option<String>,
}

/// An agent candidate surfaced by auto-detection (sent in the setup popup).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub default_acp_command: String,
    pub install_hint: String,
}

/// An agent session discovered on disk (claude/codex native session store),
/// resumable via `task.resume` → ACP `session/load`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    /// Agent id this session belongs to ("claude" | "codex").
    pub agent: String,
    /// The agent's native session id (uuid) — passed to ACP `session/load`.
    pub session_id: String,
    /// Human-readable title (first user prompt or codex thread name); may be empty.
    pub title: String,
    /// Unix seconds of last activity (file mtime / index timestamp).
    pub updated_at: u64,
    /// Rough message count (0 if unknown).
    pub message_count: u32,
}

/// A git worktree for an isolated task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub task_id: String,
    pub path: String,
    pub branch: String,
    pub base_branch: String,
}

/// Contents of `~/.warpforge/daemon.json`, written by the daemon on startup
/// so clients can discover the endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEndpoint {
    pub pid: u32,
    /// e.g. "ws://127.0.0.1:61814"
    pub url: String,
    /// Random per-daemon-start token; clients send it as the first frame:
    /// `{ "auth": "<token>" }`.
    pub token: String,
    pub version: String,
    #[serde(default)]
    pub protocol_version: u32,
    #[serde(default)]
    pub owner: DaemonOwner,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaemonOwner {
    Desktop,
    #[default]
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHandshake {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub owner: DaemonOwner,
    pub protocol_compatible: bool,
    pub exact_version_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHandoff {
    pub ready: bool,
    #[serde(default)]
    pub blockers: Vec<String>,
}

// ─── Orchestration DTOs ──────────────────────────────────────────────────────

/// Orchestration graph info, embedded in a parent TaskInfo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchGraphInfo {
    pub id: String,
    pub goal: String,
    pub nodes: Vec<OrchNodeInfo>,
}

/// A single node in the orchestration graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchNodeInfo {
    pub id: String,
    pub kind: OrchNodeKind,
    pub agent: String,
    pub status: OrchNodeStatus,
    /// Task ID on the board — click to open TaskDetail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Node result text from the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchNodeKind {
    Plan,
    Implement,
    Review,
    Merge,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchNodeStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Skipped,
}

/// Orchestrator configuration DTO (wire format).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorConfigDto {
    pub planner_agent: String,
    pub worker_pool: Vec<OrchWorkerPoolDto>,
    pub reviewer_pool: Vec<OrchReviewerPoolDto>,
    pub worktrees_enabled: bool,
}

impl Default for OrchestratorConfigDto {
    fn default() -> Self {
        Self {
            planner_agent: "claude".into(),
            worker_pool: vec![
                OrchWorkerPoolDto {
                    agent: "claude".into(),
                },
                OrchWorkerPoolDto {
                    agent: "codex".into(),
                },
            ],
            reviewer_pool: vec![OrchReviewerPoolDto {
                agent: "opencode".into(),
            }],
            worktrees_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchWorkerPoolDto {
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchReviewerPoolDto {
    pub agent: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_detect_roundtrip() {
        // Struct variant with empty params — client always sends params:{}.
        let json: serde_json::Value =
            serde_json::from_str(r#"{"id":1,"method":"agents.detect","params":{}}"#).unwrap();
        let req: Request = serde_json::from_value(json).unwrap();
        assert_eq!(req.id, 1);
        assert!(matches!(req.method, Method::AgentsDetect {}));
    }

    #[test]
    fn request_wire_shape() {
        let req = Request {
            id: 7,
            method: Method::TaskCreate {
                project: "my-app".into(),
                prompt: "fix the login bug".into(),
                agent: "claude".into(),
                tags: vec!["bug".into()],
                include_runtime_context: true,
                worktree: false,
                parent_task_id: None,
                attachments: vec![],
                default_model: Some("opus".into()),
            },
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["id"], 7);
        assert_eq!(json["method"], "task.create");
        assert_eq!(json["params"]["project"], "my-app");

        let back: Request = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);
    }

    #[test]
    fn prompt_attachments_are_backward_compatible_and_roundtrip() {
        let old: Request = serde_json::from_str(
            r#"{"id":1,"method":"session.prompt","params":{"task_id":"t1","text":"hi"}}"#,
        )
        .unwrap();
        assert!(
            matches!(old.method, Method::SessionPrompt { attachments, .. } if attachments.is_empty())
        );

        for attachment in [
            PromptAttachment::File {
                path: "src/main.rs".into(),
            },
            PromptAttachment::Image {
                name: "shot.png".into(),
                mime_type: "image/png".into(),
                data: "AA==".into(),
            },
        ] {
            let value = serde_json::to_value(&attachment).unwrap();
            assert_eq!(
                serde_json::from_value::<PromptAttachment>(value).unwrap(),
                attachment
            );
        }

        let old_history: SessionUpdate =
            serde_json::from_str(r#"{"kind":"user_message","text":"hello"}"#).unwrap();
        assert!(
            matches!(old_history, SessionUpdate::UserMessage { attachments, .. } if attachments.is_empty())
        );

        let old_tool: SessionUpdate = serde_json::from_str(
            r#"{"kind":"tool_call","tool_call_id":"t1","title":"wait","status":"in_progress","tool_kind":"execute"}"#,
        )
        .unwrap();
        assert!(matches!(
            old_tool,
            SessionUpdate::ToolCall {
                started_at: None,
                ..
            }
        ));

        let old_file_edit: SessionUpdate =
            serde_json::from_str(r#"{"kind":"file_edit","path":"src/main.rs"}"#).unwrap();
        assert!(matches!(
            old_file_edit,
            SessionUpdate::FileEdit {
                tool_call_id: None,
                additions: None,
                deletions: None,
                ..
            }
        ));
    }

    #[test]
    fn event_wire_shape() {
        let ev = Event::ServiceLog {
            project: "my-app".into(),
            service: "db".into(),
            seq: 42,
            line: "ready".into(),
        };
        let json = serde_json::to_value(ServerMessage::Event(ev.clone())).unwrap();
        assert_eq!(json["event"], "service.log");
        assert_eq!(json["data"]["seq"], 42);

        let back: ServerMessage = serde_json::from_value(json).unwrap();
        assert_eq!(back, ServerMessage::Event(ev));
    }

    #[test]
    fn response_vs_error_disambiguation() {
        let ok: ServerMessage =
            serde_json::from_str(r#"{"id":1,"result":{"taskId":"abc"}}"#).unwrap();
        assert!(matches!(ok, ServerMessage::Response { id: 1, .. }));

        let err: ServerMessage = serde_json::from_str(
            r#"{"id":2,"error":{"code":"not_found","message":"no such task"}}"#,
        )
        .unwrap();
        match err {
            ServerMessage::Error { id, error } => {
                assert_eq!(id, 2);
                assert_eq!(error.code, ErrorCode::NotFound);
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn old_daemon_endpoint_defaults_to_external_and_unknown_protocol() {
        let endpoint: DaemonEndpoint = serde_json::from_str(
            r#"{"pid":42,"url":"ws://127.0.0.1:1","token":"t","version":"0.1.0"}"#,
        )
        .unwrap();
        assert_eq!(endpoint.protocol_version, 0);
        assert_eq!(endpoint.owner, DaemonOwner::External);
    }

    #[test]
    fn update_methods_keep_the_documented_wire_shape() {
        let handshake = serde_json::to_value(Request {
            id: 1,
            method: Method::SystemHandshake {
                client_version: "0.2.0".into(),
                protocol_version: PROTOCOL_VERSION,
            },
        })
        .unwrap();
        assert_eq!(handshake["method"], "system.handshake");
        assert_eq!(handshake["params"]["client_version"], "0.2.0");

        let handoff = serde_json::to_value(Request {
            id: 2,
            method: Method::UpdatePrepareShutdown {
                expected_daemon_version: "0.2.0".into(),
                protocol_version: PROTOCOL_VERSION,
            },
        })
        .unwrap();
        assert_eq!(handoff["method"], "update.prepareShutdown");
        assert_eq!(handoff["params"]["expected_daemon_version"], "0.2.0");
    }

    #[test]
    fn snapshot_event_roundtrip() {
        let ev = Event::Snapshot(Snapshot::default());
        let json = serde_json::to_string(&ev).unwrap();
        let back: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ev);
    }
}
