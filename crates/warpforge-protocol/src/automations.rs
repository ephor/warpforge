//! Wire types for scheduled automations.
//!
//! An automation is a named prompt that the daemon runs on a schedule, with a
//! chosen agent and an explicit per-automation model. Every run becomes a real
//! daemon task, so the transcript, diff and runtime context of a scheduled run
//! are the same objects a hand-created task has — an [`AutomationRun`] is just
//! the bookkeeping row that links the two.
//!
//! `Method`/`Event` variants live in `lib.rs` (those enums must stay exhaustive
//! in one file); everything they carry lives here.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// Deserialize `Option<Option<T>>` so JSON `null` becomes `Some(None)`
/// ("clear this field") instead of the outer `None` ("leave it alone").
/// Without this, "clear" is unreachable over the wire.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// Default grace window: 12 hours. A machine that was asleep over an occurrence
/// still runs it on wake, but a laptop reopened after a week does not fire a
/// week-old job the moment it comes back.
pub const DEFAULT_MISSED_RUN_GRACE_MINUTES: u32 = 720;

/// Which schedule shape the user picked. Purely a UI hint: the cron expression
/// in [`AutomationTrigger::cron`] is always populated and is what the scheduler
/// reads, so there is exactly one code path for "when does this run next".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationPreset {
    Hourly,
    #[serde(rename = "every5")]
    Every5Minutes,
    Daily,
    Weekdays,
    Weekly,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrigger {
    pub preset: AutomationPreset,
    /// Standard 5-field cron (`min hour dom month dow`). Presets are stored
    /// *expanded* into this field so the UI can always show what will run.
    pub cron: String,
}

impl Default for AutomationTrigger {
    fn default() -> Self {
        Self {
            preset: AutomationPreset::Daily,
            cron: "0 9 * * *".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    /// Row written, work not dispatched yet (a precheck is in flight).
    Pending,
    /// A task is running the prompt.
    Running,
    Completed,
    Failed,
    /// The precheck command exited non-zero, could not be spawned, or timed
    /// out. A precheck that cannot run has not authorized the run.
    SkippedPrecheck,
    /// The occurrence came due while the daemon was down and is now older than
    /// the automation's grace window.
    SkippedMissed,
    /// The previous run of this same automation had not finished. Reported
    /// honestly rather than folded into `SkippedMissed`.
    SkippedRunning,
}

impl AutomationRunStatus {
    /// Only final runs are evictable by retention: a `Running` run's completion
    /// lands later and must still find its row.
    pub fn is_final(self) -> bool {
        !matches!(self, Self::Pending | Self::Running)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::SkippedPrecheck => "skipped_precheck",
            Self::SkippedMissed => "skipped_missed",
            Self::SkippedRunning => "skipped_running",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunTrigger {
    Scheduled,
    Manual,
}

impl AutomationRunTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    /// Project *name*, matching `TaskInfo::project`.
    pub project: String,
    pub name: String,
    pub prompt: String,
    /// Agent id (`claude`, `codex`, `opencode`, …).
    pub agent: String,
    /// Per-automation model override. `None` inherits the agent's last-used
    /// model, exactly as a hand-created task with no explicit pick does.
    pub model: Option<String>,
    /// Non-model ACP config overrides (reasoning effort, mode) keyed by the
    /// option id the agent probe reported.
    #[serde(default)]
    pub config_overrides: HashMap<String, String>,
    pub trigger: AutomationTrigger,
    /// IANA zone name. Empty means the daemon host's local zone.
    #[serde(default)]
    pub timezone: String,
    /// `sh -c` command run in the project directory before a scheduled run.
    /// Non-zero exit skips the run.
    pub precheck: Option<String>,
    pub enabled: bool,
    pub missed_run_grace_minutes: u32,
    /// Send the prompt into the previous run's task instead of creating a new
    /// one, so the automation accumulates one conversation.
    pub reuse_session: bool,
    /// Run each new task in an isolated git worktree.
    pub worktree: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Next occurrence, epoch seconds. `None` when disabled.
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_status: Option<AutomationRunStatus>,
    /// Task the newest run used — the anchor for `reuse_session`.
    pub last_task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    /// 1-based, monotonic per automation. Derived from `MAX + 1`, never a row
    /// count — retention deletes rows and a count would reissue numbers.
    pub run_number: u64,
    pub trigger: AutomationRunTrigger,
    pub status: AutomationRunStatus,
    /// The occurrence this run belongs to, which is not the same as
    /// `started_at` when the daemon caught up after being down.
    pub scheduled_for: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub task_id: Option<String>,
    pub error: Option<String>,
    /// First few KiB of the agent's final text. The full transcript stays on
    /// the task.
    pub output: Option<String>,
}

/// Update payload. Every field is optional: absent means "leave alone", so one
/// call can flip just `enabled`.
///
/// `precheck` is a double `Option` because "not mentioned" and "cleared" are
/// different edits and both have to be expressible.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<Option<String>>,
    #[serde(default)]
    pub config_overrides: Option<HashMap<String, String>>,
    #[serde(default)]
    pub trigger: Option<AutomationTrigger>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub precheck: Option<Option<String>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub missed_run_grace_minutes: Option<u32>,
    #[serde(default)]
    pub reuse_session: Option<bool>,
    #[serde(default)]
    pub worktree: Option<bool>,
}
