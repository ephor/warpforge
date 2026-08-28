use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Mirror of `wire::TaskStatus`; see that enum for why `Waiting` is one state
/// and not the old `Idle` / `NeedsReview` pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStatus {
    Queued,
    Running,
    /// Turn over; waiting on the human. Whether there is a diff to look at is
    /// `files_changed > 0`, not a separate status.
    Waiting,
    Blocked,
    Interrupted,
    Done,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            TaskStatus::Queued => "queued",
            TaskStatus::Running => "running",
            TaskStatus::Waiting => "waiting",
            TaskStatus::Done => "done",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Interrupted => "interrupted",
        };
        f.write_str(s)
    }
}

/// A unit of work on the board: a prompt handed to an agent within one project.
///
/// `id` (the task) and `session_id` (the ACP agent session) are deliberately
/// **separate** identifiers. Today a task has at most one session, but the
/// roadmap has multiple agents collaborating on a single task — so nothing
/// keys session state off the task id. Keeping them distinct now means that
/// future is additive (N sessions under a task), not a schema migration.
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub id: String,
    pub session_id: Option<String>,
    pub project: String,
    pub prompt: String,
    pub agent: String,
    pub status: TaskStatus,
    pub tags: Vec<String>,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub files_changed: u32,
    pub blocked_reason: Option<String>,
    /// Why the task is blocked, when the daemon can say something more useful
    /// than the raw message. `None` = no classification; read `blocked_reason`.
    pub blocked_kind: Option<warpforge_protocol::TaskBlockedKind>,
    /// Latest session selectors (model/mode/…) from the ACP session. Persisted
    /// so resumed/interrupted tasks keep the last known controls after restart.
    pub config_options: Vec<warpforge_protocol::ConfigOption>,
    /// Path to the git worktree for this task, if it runs isolated.
    /// `None` = run in the project's main working directory.
    pub worktree: Option<String>,
    /// Orchestration graph for parent orchestrator tasks.
    pub orchestration_graph: Option<warpforge_protocol::OrchGraphInfo>,
    /// Live workflow pipeline state for workflow parent tasks. Derived from
    /// the engine's run (not persisted with the task — the run itself is).
    pub workflow_run: Option<warpforge_protocol::WorkflowRunInfo>,
    /// When this task was spawned by an orchestrator agent as a sub-agent, the
    /// id of that orchestrator task. Its result is delivered back into the
    /// parent's inbox on completion.
    pub parent_task_id: Option<String>,
    /// Explicit settle override (true = settled, false = not settled).
    /// `None` = derive from execution status only.
    pub settled_override: Option<bool>,
    /// Unix seconds when the task was last settled.
    pub settled_at: Option<u64>,
    /// Unix seconds until which the task is snoozed.
    pub snoozed_until: Option<u64>,
    /// Unix seconds when the current snooze was set.
    pub snoozed_at: Option<u64>,
    /// Agent account this task's session was started with. Recorded so resume
    /// and restart reuse the same account even after the active one changed.
    /// `None` = whatever account is active at spawn time.
    pub account_id: Option<String>,
    /// Id of the backlog item this task was started from, if any.
    pub backlog_item_id: Option<String>,
    /// Last explicit model intent the user expressed for this task.
    pub model: Option<String>,
}

impl Task {
    pub fn new(project: &str, prompt: &str, agent: &str, tags: Vec<String>) -> Self {
        let ts = now_secs();
        let title = derive_title(prompt);
        Self {
            id: format!("t_{}", &Uuid::new_v4().to_string()[..8]),
            session_id: None,
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            status: TaskStatus::Queued,
            tags,
            title,
            created_at: ts,
            updated_at: ts,
            files_changed: 0,
            blocked_reason: None,
            blocked_kind: None,
            config_options: Vec::new(),
            worktree: None,
            orchestration_graph: None,
            workflow_run: None,
            parent_task_id: None,
            settled_override: None,
            settled_at: None,
            snoozed_until: None,
            snoozed_at: None,
            account_id: None,
            backlog_item_id: None,
            model: None,
        }
    }

    /// Attach an agent session to this task. The session id is generated by
    /// (or negotiated with) the ACP layer; it is never derived from `id`.
    pub fn attach_session(&mut self, session_id: String) {
        self.session_id = Some(session_id);
        self.status = TaskStatus::Running;
        self.updated_at = now_secs();
    }

    pub fn set_status(&mut self, status: TaskStatus) {
        self.status = status;
        self.updated_at = now_secs();
    }
}

/// Derive a display title from a prompt: first line, stripped of leading
/// whitespace and markdown fences, truncated to 80 characters. Returns empty
/// string for empty prompts.
fn derive_title(prompt: &str) -> String {
    let line = prompt
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches("# ")
        .trim_start_matches('*')
        .trim_start_matches('-')
        .trim();
    let max = 80;
    if line.len() <= max {
        line.to_string()
    } else {
        let end = line
            .char_indices()
            .take(max)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(max);
        line[..end].to_string()
    }
}
