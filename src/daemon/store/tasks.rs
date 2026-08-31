//! Task rows: the genuinely new, must-not-be-lost state.

use anyhow::Result;

use warpforge_protocol as wire;

use super::Store;
use crate::daemon::task::{Task, TaskStatus};

impl Store {
    pub fn upsert_task(&self, task: &Task) -> Result<()> {
        let tags = serde_json::to_string(&task.tags)?;
        let config_options = serde_json::to_string(&task.config_options)?;
        self.conn.execute(
            r#"
            INSERT INTO tasks
                (id, session_id, project, prompt, agent, status, tags, title,
                 created_at, updated_at, files_changed, blocked_reason, config_options, worktree,
                 parent_task_id, settled_override, settled_at, snoozed_until, snoozed_at,
                 account_id, backlog_item_id, blocked_kind, model)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
            ON CONFLICT(id) DO UPDATE SET
                session_id=excluded.session_id,
                status=excluded.status,
                tags=excluded.tags,
                title=excluded.title,
                updated_at=excluded.updated_at,
                files_changed=excluded.files_changed,
                blocked_reason=excluded.blocked_reason,
                config_options=excluded.config_options,
                worktree=excluded.worktree,
                settled_override=excluded.settled_override,
                settled_at=excluded.settled_at,
                snoozed_until=excluded.snoozed_until,
                snoozed_at=excluded.snoozed_at,
                account_id=excluded.account_id,
                backlog_item_id=excluded.backlog_item_id,
                blocked_kind=excluded.blocked_kind,
                model=excluded.model
            "#,
            rusqlite::params![
                task.id,
                task.session_id,
                task.project,
                task.prompt,
                task.agent,
                task.status.to_string(),
                tags,
                task.title,
                task.created_at,
                task.updated_at,
                task.files_changed,
                task.blocked_reason,
                config_options,
                task.worktree,
                task.parent_task_id,
                task.settled_override,
                task.settled_at,
                task.snoozed_until,
                task.snoozed_at,
                task.account_id,
                task.backlog_item_id,
                blocked_kind_str(task.blocked_kind),
                task.model,
            ],
        )?;
        Ok(())
    }

    /// Load all persisted tasks. Any task that was mid-flight when the daemon
    /// last stopped is normalised to `Interrupted`; the live process handle is
    /// gone, but a saved `session_id` can be loaded again when the user sends
    /// the next prompt and the agent supports ACP session/load.
    pub fn load_tasks(&self) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, project, prompt, agent, status, tags, \
             created_at, updated_at, files_changed, blocked_reason, config_options, worktree, \
             parent_task_id, title, settled_override, settled_at, snoozed_until, snoozed_at, \
             account_id, backlog_item_id, blocked_kind, model \
             FROM tasks",
        )?;
        let rows = stmt.query_map([], |row| {
            let tags_json: String = row.get(6)?;
            let status_str: String = row.get(5)?;
            let config_options_json: String = row.get(11)?;
            let mut status = parse_status(&status_str);
            if matches!(status, TaskStatus::Running | TaskStatus::Queued) {
                status = TaskStatus::Interrupted;
            }
            Ok(Task {
                id: row.get(0)?,
                session_id: row.get(1)?,
                project: row.get(2)?,
                prompt: row.get(3)?,
                agent: row.get(4)?,
                status,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                title: row.get(14)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                files_changed: row.get::<_, i64>(9)? as u32,
                blocked_reason: row.get(10)?,
                blocked_kind: parse_blocked_kind(row.get(21)?),
                config_options: serde_json::from_str(&config_options_json).unwrap_or_default(),
                worktree: row.get(12)?,
                orchestration_graph: None,
                workflow_run: None,
                parent_task_id: row.get(13)?,
                settled_override: row.get::<_, Option<i64>>(15)?.map(|v| v != 0),
                settled_at: row.get::<_, Option<u64>>(16)?,
                snoozed_until: row.get::<_, Option<u64>>(17)?,
                snoozed_at: row.get::<_, Option<u64>>(18)?,
                account_id: row.get(19)?,
                backlog_item_id: row.get(20)?,
                model: row.get(22)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Delete a task and its session history permanently.
    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM session_updates WHERE task_id = ?1",
            rusqlite::params![id],
        )?;
        self.conn.execute(
            "DELETE FROM workflow_runs WHERE task_id = ?1",
            rusqlite::params![id],
        )?;
        // Break backlog/tracker links so the UI shows "Start task" instead of
        // a dead "Open task" button after the task is gone.
        self.conn.execute(
            "UPDATE backlog_items SET task_id = NULL, status = 'todo' WHERE task_id = ?1",
            rusqlite::params![id],
        )?;
        self.conn.execute(
            "UPDATE tracker_links SET task_id = NULL WHERE task_id = ?1",
            rusqlite::params![id],
        )?;
        self.conn
            .execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    /// Waiting tasks with nothing to review that nobody touched past `cutoff`
    /// (epoch seconds). These are the auto-settle candidates: a task with a
    /// diff is deliberately excluded, as is anything snoozed or already
    /// settled. Timestamps come from the database so the caller can run this
    /// fully off the actor loop.
    pub fn find_ignored_waiting_tasks(&self, cutoff: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM tasks
              WHERE status = 'waiting'
                AND files_changed = 0
                AND (settled_override IS NULL OR settled_override = 0)
                AND (snoozed_until IS NULL OR snoozed_until <= strftime('%s','now'))
                AND updated_at < ?1",
        )?;
        let ids = stmt
            .query_map(rusqlite::params![cutoff], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    /// Closed tasks untouched past `cutoff`, with their `files_changed` count
    /// so the caller can keep the ones that still hold unmerged changes.
    pub fn find_expired_closed_tasks(&self, cutoff: i64) -> Result<Vec<(String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, files_changed FROM tasks
              WHERE status = 'done' AND updated_at < ?1",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![cutoff], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }
}

/// `"idle"` and `"needs_review"` are the pre-merge spellings of `Waiting`. Rows
/// written by older daemons are still on disk in every existing install, so both
/// must keep loading — this arm is load-bearing, not tidy-up.
fn blocked_kind_str(kind: Option<wire::TaskBlockedKind>) -> Option<&'static str> {
    match kind {
        Some(wire::TaskBlockedKind::SessionLost) => Some("session_lost"),
        Some(wire::TaskBlockedKind::ModelMismatch) => Some("model_mismatch"),
        None => None,
    }
}

/// An unknown value — written by a newer daemon sharing this store — reads back
/// as `None`, leaving the client with the plain `blocked_reason` it always had.
fn parse_blocked_kind(s: Option<String>) -> Option<wire::TaskBlockedKind> {
    match s.as_deref() {
        Some("session_lost") => Some(wire::TaskBlockedKind::SessionLost),
        Some("model_mismatch") => Some(wire::TaskBlockedKind::ModelMismatch),
        _ => None,
    }
}

fn parse_status(s: &str) -> TaskStatus {
    match s {
        "queued" => TaskStatus::Queued,
        "running" => TaskStatus::Running,
        "waiting" | "idle" | "needs_review" => TaskStatus::Waiting,
        "done" => TaskStatus::Done,
        "blocked" => TaskStatus::Blocked,
        "interrupted" => TaskStatus::Interrupted,
        // A status this build has never heard of came from a newer daemon
        // sharing the same store. Degrade to "the human's turn", never to
        // `Queued`: that reads as "never started", and the loader rewrites
        // `Queued` to `Interrupted`, so finished work would come back looking
        // like it had been cut short.
        _ => TaskStatus::Waiting,
    }
}
