use std::collections::{HashMap, HashSet};

use anyhow::Result;

use crate::daemon::task::{Task, TaskStatus};

/// Tracks unresolved permission requests per task. Keyed by task_id (not
/// session_id) because Command::SessionPermission and AcpUpdate::PermissionRequest
/// both use task_id as the correlation key, and sessions are keyed by task_id.
#[derive(Default)]
pub(crate) struct PendingPermissions {
    pub(crate) by_task: HashMap<String, HashSet<String>>,
}

impl PendingPermissions {
    pub(crate) fn record(&mut self, task_id: &str, request_id: &str) {
        self.by_task
            .entry(task_id.to_string())
            .or_default()
            .insert(request_id.to_string());
    }

    pub(crate) fn resolve(&mut self, task_id: &str, request_id: &str) {
        if let Some(requests) = self.by_task.get_mut(task_id) {
            requests.remove(request_id);
            if requests.is_empty() {
                self.by_task.remove(task_id);
            }
        }
    }

    pub(crate) fn cleanup_task(&mut self, task_id: &str) {
        self.by_task.remove(task_id);
    }

    pub(crate) fn has_pending(&self, task_id: &str) -> bool {
        self.by_task.get(task_id).is_some_and(|r| !r.is_empty())
    }
}

/// Lifecycle state transitions for settle/snooze visibility overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleAction {
    Settle,
    Unsettle,
    Snooze { until: u64 },
    Unsnooze,
}

/// Pure lifecycle transition function. Returns:
/// - Err for validation failures (running, pending permission, invalid until)
/// - Ok(None) for true no-ops (task already in target state)
/// - Ok(Some(task)) when changes were made (caller must persist/emit)
pub(crate) fn apply_lifecycle_action(
    task: &Task,
    has_pending: bool,
    now: u64,
    action: LifecycleAction,
) -> Result<Option<Task>, String> {
    match action {
        LifecycleAction::Settle => {
            if task.status == TaskStatus::Running {
                return Err(format!("task {} is running", task.id));
            }
            if has_pending {
                return Err(format!("task {} has pending permission request", task.id));
            }
            // Check if already in target state
            let already_settled = task.settled_override == Some(true)
                && task.settled_at.is_some()
                && task.snoozed_until.is_none()
                && task.snoozed_at.is_none();
            if already_settled {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.settled_override = Some(true);
            // Preserve existing settled_at only when already settled (override=true)
            // Otherwise replace stale timestamp with now
            updated.settled_at = match task.settled_override {
                Some(true) => Some(task.settled_at.unwrap_or(now)),
                _ => Some(now),
            };
            // Clear snooze
            updated.snoozed_until = None;
            updated.snoozed_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
        LifecycleAction::Unsettle => {
            // Check if already in target state
            let already_unsettled = task.settled_override == Some(false)
                && task.settled_at.is_none()
                && task.snoozed_until.is_none()
                && task.snoozed_at.is_none();
            if already_unsettled {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.settled_override = Some(false);
            updated.settled_at = None;
            updated.snoozed_until = None;
            updated.snoozed_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
        LifecycleAction::Snooze { until } => {
            if until <= now {
                return Err("snooze until must be in the future".to_string());
            }
            if has_pending {
                return Err(format!("task {} has pending permission request", task.id));
            }
            // Check if already in target state
            let already_snoozed = task.snoozed_until == Some(until)
                && task.snoozed_at.is_some()
                && task.settled_override == Some(false)
                && task.settled_at.is_none();
            if already_snoozed {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.snoozed_until = Some(until);
            // Preserve snoozed_at only when same until AND Some; otherwise set now
            updated.snoozed_at = if task.snoozed_until == Some(until) && task.snoozed_at.is_some() {
                task.snoozed_at
            } else {
                Some(now)
            };
            updated.settled_override = Some(false);
            updated.settled_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
        LifecycleAction::Unsnooze => {
            // Check if already in target state
            if task.snoozed_until.is_none() && task.snoozed_at.is_none() {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.snoozed_until = None;
            updated.snoozed_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
    }
}
