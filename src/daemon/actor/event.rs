use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::agent::AgentStatus;
use crate::portforward::PfStatus;
use crate::service::ServiceStatus;

use crate::daemon::task::Task;

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
    ProjectConfigChanged(wire::ProjectConfigState),
    AgentsSetupNeeded {
        detected: Vec<wire::DetectedAgent>,
    },
    AgentsUpdated {
        agents: Vec<wire::AgentConfig>,
    },
    /// Account list or active selection changed.
    AccountsUpdated {
        accounts: Vec<wire::AccountInfo>,
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
    /// Session transcripts of finished tasks older than the retention window
    /// were removed; `updates` counts the deleted rows.
    HistoryPruned {
        updates: u64,
    },
    /// The retention sweep settled and/or deleted tasks (see HistorySwept's
    /// wire doc for the counters' meaning).
    HistorySwept {
        settled: u64,
        expired: u64,
        kept: u64,
    },
    /// A PTY terminal's rendered screen changed (serialized, so clients need no
    /// terminal emulator — the daemon owns the one authoritative vt100 parser).
    TerminalScreen {
        terminal_id: String,
        screen: wire::TerminalScreen,
    },
    /// A new terminal was spawned. Wire clients use this to add TerminalInfo to
    /// their snapshot projection. Internal-only info (parser handle) stays on
    /// AgentSpawned for the in-process TUI.
    TerminalSpawned {
        info: wire::TerminalInfo,
    },
    /// Raw PTY output bytes (base64) for terminal-emulator clients.
    TerminalData {
        terminal_id: String,
        data_b64: String,
    },
    /// Orchestration pipeline event (plan created, node dispatched, etc.)
    #[allow(clippy::enum_variant_names)]
    OrchestrationEvent(crate::orchestration::OrchEvent),
    /// An opaque LSP message from a language server's stdout.
    LspMessage {
        server_id: String,
        payload: serde_json::Value,
    },
    /// A language server exited.
    LspExit {
        server_id: String,
        code: Option<i32>,
    },
    AgentLimitsUpdated {
        accounts: Vec<wire::AgentAccountLimits>,
    },
    /// An automation was created or changed — including the scheduler moving
    /// `next_run_at`, which is what keeps the desktop's "Next run" column live.
    AutomationUpdated(Box<wire::Automation>),
    AutomationRemoved {
        id: String,
    },
    /// A run row was written or its status changed.
    AutomationRunUpdated(Box<wire::AutomationRun>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectRemovalError {
    Conflict(String),
    NotFound(String),
    Internal(String),
}

impl std::fmt::Display for ProjectRemovalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict(message) | Self::NotFound(message) | Self::Internal(message) => {
                f.write_str(message)
            }
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ProjectLiveResources {
    pub(crate) services: usize,
    pub(crate) portforwards: usize,
    pub(crate) terminals: usize,
}

impl ProjectLiveResources {
    pub(crate) fn any(&self) -> bool {
        self.services + self.portforwards + self.terminals > 0
    }

    pub(crate) fn conflict_message(&self, project: &str) -> String {
        let mut counts = Vec::new();
        if self.services > 0 {
            counts.push(format!(
                "{} live service{}",
                self.services,
                plural(self.services)
            ));
        }
        if self.portforwards > 0 {
            counts.push(format!(
                "{} live port-forward{}",
                self.portforwards,
                plural(self.portforwards)
            ));
        }
        if self.terminals > 0 {
            counts.push(format!(
                "{} live terminal{}",
                self.terminals,
                plural(self.terminals)
            ));
        }
        format!(
            "Project \"{project}\" has {}; retry project.remove with stop_resources=true to stop them and remove the registration",
            counts.join(", ")
        )
    }
}

pub(crate) fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// Collapse a dropped memory reply channel into a "disabled" error, matching
/// what a never-opened store reports.
pub(crate) fn memory_dropped() -> crate::daemon::memory::MemoryError {
    crate::daemon::memory::MemoryError::Disabled("memory disabled".into())
}

/// Collapse a failed oneshot into an error `GitOpResult` instead of panicking.
pub(crate) fn op_result_or_dropped(
    received: Result<wire::GitOpResult, oneshot::error::RecvError>,
    message: &str,
) -> wire::GitOpResult {
    received.unwrap_or_else(|_| wire::GitOpResult {
        status: wire::GitOpStatus::Error,
        message: message.to_string(),
        conflicts: Vec::new(),
        branch: None,
    })
}

/// What a finished git operation changed about a task.
///
/// These describe something that already happened on disk, so applying one late
/// is still correct — a commit that landed is a commit that landed. The only
/// guard needed is that the task still exists, which the handlers check.
#[derive(Debug, Clone, Copy)]
pub enum GitEffect {
    /// HEAD or the working tree moved: nudge clients to refetch.
    Bump,
    /// A commit landed, so the task has no uncommitted changes left.
    Committed,
    /// A hunk was rejected, so one fewer file differs.
    HunkRejected,
}
