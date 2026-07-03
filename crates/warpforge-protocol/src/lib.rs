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
}

// ─── Methods (client → daemon) ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum Method {
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

    // ── Dev servers (existing ServiceManager behaviour, exposed) ──
    #[serde(rename = "service.start")]
    ServiceStart { project: String, service: String },
    #[serde(rename = "service.stop")]
    ServiceStop { project: String, service: String },
    #[serde(rename = "service.restart")]
    ServiceRestart { project: String, service: String },
    /// Start every service declared in the project's .workspace.yaml
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
        /// Agent template name from .workspace.yaml, or a raw command.
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
    },
    #[serde(rename = "task.cancel")]
    TaskCancel { task_id: String },
    /// Archive a finished task off the board.
    #[serde(rename = "task.archive")]
    TaskArchive { task_id: String },

    // ── ACP passthrough for a task's agent session ──
    /// Send a follow-up user message into a running session.
    #[serde(rename = "session.prompt")]
    SessionPrompt { task_id: String, text: String },
    /// Answer a permission request raised by the agent.
    #[serde(rename = "session.permission")]
    SessionPermission {
        task_id: String,
        request_id: String,
        outcome: PermissionOutcome,
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
    /// Write new contents to a file in the task's working tree (in-review edit).
    #[serde(rename = "file.save")]
    FileSave { task_id: String, path: String, content: String },

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
    TerminalResize { terminal_id: String, cols: u16, rows: u16 },
    #[serde(rename = "terminal.kill")]
    TerminalKill { terminal_id: String },
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
    PortForwardLog { project: String, name: String, seq: u64, line: String },

    #[serde(rename = "task.created")]
    TaskCreated(TaskInfo),
    #[serde(rename = "task.updated")]
    TaskUpdated(TaskInfo),

    /// Structured ACP session update for a task: tool calls, agent text,
    /// file edits, permission requests. Mirrors ACP `session/update`.
    #[serde(rename = "session.update")]
    SessionUpdate { task_id: String, update: SessionUpdate },

    /// Terminal (PTY) screen changed. Carries the rendered screen contents,
    /// not raw bytes — every client sees the same vt100 state.
    #[serde(rename = "terminal.screen")]
    TerminalScreen { terminal_id: String, screen: TerminalScreen },
    #[serde(rename = "terminal.exited")]
    TerminalExited { terminal_id: String, code: i32 },
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    /// Inclusive port range assigned to this project.
    pub port_range: (u16, u16),
    /// Services declared in .workspace.yaml (may not be running).
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
}

/// Board columns. `Interrupted` covers sessions lost to a daemon restart —
/// the task is preserved in SQLite and can be re-queued, but the live ACP
/// session is gone (v1 does not resume sessions).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    NeedsReview,
    Done,
    Blocked,
    Interrupted,
}

/// Structured agent-session update, a deliberately small projection of ACP's
/// `session/update` notification. Extend as views need more.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionUpdate {
    /// The developer's own prompt, echoed by the daemon into the stream so
    /// every attached client shows the same conversation.
    UserMessage { text: String },
    AgentText { text: String },
    AgentThought { text: String },
    ToolCall {
        tool_call_id: String,
        title: String,
        status: ToolCallStatus,
        /// ACP tool kind: read/edit/delete/move/search/execute/think/fetch/other.
        #[serde(default)]
        tool_kind: String,
        /// Rendered tool output/content, if the agent included any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    FileEdit { path: String },
    PermissionRequest {
        request_id: String,
        title: String,
        options: Vec<String>,
    },
    /// The agent's plan / todo list (ACP `plan` update).
    Plan { entries: Vec<PlanEntry> },
    /// Slash-commands the agent exposes (ACP `available_commands_update`).
    AvailableCommands { commands: Vec<CommandInfo> },
    TurnEnded { stop_reason: String },
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

// ─── Diff / review ───────────────────────────────────────────────────────────

/// Result of `diff.get`: the task's working-tree changes, per file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub task_id: String,
    pub files: Vec<FileDiff>,
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn snapshot_event_roundtrip() {
        let ev = Event::Snapshot(Snapshot::default());
        let json = serde_json::to_string(&ev).unwrap();
        let back: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ev);
    }
}
