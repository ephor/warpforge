//! SQLite persistence for the daemon. Tasks are the genuinely new, must-not-be-
//! lost state (projects still live in `~/.warpforge/projects.json`, port ranges
//! are derived from project index), so this store is task-focused for now.
//!
//! The connection is owned by the actor task and only ever touched from there,
//! so no locking is needed beyond what rusqlite provides.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;

use warpforge_protocol as wire;

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
            CREATE TABLE IF NOT EXISTS session_updates (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id     TEXT NOT NULL,
                update_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS session_updates_task_idx ON session_updates(task_id);
            CREATE TABLE IF NOT EXISTS agents (
                id           TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                acp_command  TEXT NOT NULL,
                enabled      INTEGER NOT NULL DEFAULT 1
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

    /// Returns true if the agents table has at least one row.
    pub fn agents_configured(&self) -> bool {
        self.conn
            .query_row("SELECT COUNT(*) FROM agents", [], |row| row.get::<_, i64>(0))
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    pub fn load_agents(&self) -> Result<Vec<wire::AgentConfig>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, display_name, acp_command, enabled FROM agents ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(wire::AgentConfig {
                id: row.get(0)?,
                display_name: row.get(1)?,
                acp_command: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn save_agents(&self, agents: &[wire::AgentConfig]) -> Result<()> {
        self.conn.execute("DELETE FROM agents", [])?;
        for a in agents {
            self.conn.execute(
                "INSERT INTO agents (id, display_name, acp_command, enabled) VALUES (?1,?2,?3,?4)",
                rusqlite::params![a.id, a.display_name, a.acp_command, a.enabled as i64],
            )?;
        }
        Ok(())
    }

    /// Delete a task and its session history permanently.
    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM session_updates WHERE task_id = ?1", rusqlite::params![id])?;
        self.conn
            .execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    pub fn save_session_update(&self, task_id: &str, update: &wire::SessionUpdate) -> Result<()> {
        let json = serde_json::to_string(update)?;
        self.conn.execute(
            "INSERT INTO session_updates (task_id, update_json) VALUES (?1, ?2)",
            rusqlite::params![task_id, json],
        )?;
        Ok(())
    }

    /// Load all persisted session updates grouped by task id, in insertion order.
    pub fn load_all_session_updates(&self) -> Result<HashMap<String, Vec<wire::SessionUpdate>>> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, update_json FROM session_updates ORDER BY id",
        )?;
        let mut map: HashMap<String, Vec<wire::SessionUpdate>> = HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows.filter_map(|r| r.ok()) {
            if let Ok(update) = serde_json::from_str::<wire::SessionUpdate>(&row.1) {
                map.entry(row.0).or_default().push(update);
            }
        }
        Ok(map)
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
