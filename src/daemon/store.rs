//! SQLite persistence for the daemon. Tasks are the genuinely new, must-not-be-
//! lost state (projects still live in `~/.warpforge/projects.json`, port ranges
//! are derived from project index), so this store is task-focused for now.
//!
//! The connection is owned by the actor task and only ever touched from there,
//! so no locking is needed beyond what rusqlite provides.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::PathBuf;

use super::task::{Task, TaskStatus};

fn db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
        .join("warpforge.db")
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating if needed) the default database.
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        Self::open_at(&path)
    }

    /// Open at an explicit path (":memory:" works — used by tests).
    pub fn open_at(path: &std::path::Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS tasks (
                id              TEXT PRIMARY KEY,
                session_id      TEXT,
                project         TEXT NOT NULL,
                prompt          TEXT NOT NULL,
                agent           TEXT NOT NULL,
                status          TEXT NOT NULL,
                tags            TEXT NOT NULL,      -- JSON array
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                files_changed   INTEGER NOT NULL,
                blocked_reason  TEXT
            );
            "#,
        )?;
        Ok(Self { conn })
    }

    pub fn upsert_task(&self, task: &Task) -> Result<()> {
        let tags = serde_json::to_string(&task.tags)?;
        self.conn.execute(
            r#"
            INSERT INTO tasks
                (id, session_id, project, prompt, agent, status, tags,
                 created_at, updated_at, files_changed, blocked_reason)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
            ON CONFLICT(id) DO UPDATE SET
                session_id=excluded.session_id,
                status=excluded.status,
                tags=excluded.tags,
                updated_at=excluded.updated_at,
                files_changed=excluded.files_changed,
                blocked_reason=excluded.blocked_reason
            "#,
            rusqlite::params![
                task.id,
                task.session_id,
                task.project,
                task.prompt,
                task.agent,
                task.status.to_string(),
                tags,
                task.created_at,
                task.updated_at,
                task.files_changed,
                task.blocked_reason,
            ],
        )?;
        Ok(())
    }

    /// Load all persisted tasks. Any task that was mid-flight when the daemon
    /// last stopped is normalised to `Interrupted` — v1 does not resume live
    /// ACP sessions, and the board surfaces these for one-click re-queue.
    pub fn load_tasks(&self) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, project, prompt, agent, status, tags, \
             created_at, updated_at, files_changed, blocked_reason FROM tasks",
        )?;
        let rows = stmt.query_map([], |row| {
            let tags_json: String = row.get(6)?;
            let status_str: String = row.get(5)?;
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
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                files_changed: row.get::<_, i64>(9)? as u32,
                blocked_reason: row.get(10)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

fn parse_status(s: &str) -> TaskStatus {
    match s {
        "queued" => TaskStatus::Queued,
        "running" => TaskStatus::Running,
        "needs_review" => TaskStatus::NeedsReview,
        "done" => TaskStatus::Done,
        "blocked" => TaskStatus::Blocked,
        "interrupted" => TaskStatus::Interrupted,
        _ => TaskStatus::Queued,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_interrupted_recovery() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let mut task = Task::new("demo", "do a thing", "claude", vec!["x".into()]);
        task.attach_session("sess-1".into()); // -> Running
        store.upsert_task(&task).unwrap();

        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        // Running at persist time -> Interrupted on reload (no session resumption).
        assert_eq!(loaded[0].status, TaskStatus::Interrupted);
        assert_eq!(loaded[0].id, task.id);
        assert_eq!(loaded[0].session_id.as_deref(), Some("sess-1"));
        assert_eq!(loaded[0].tags, vec!["x".to_string()]);
    }
}
