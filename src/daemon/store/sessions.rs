//! Streamed ACP session updates: the append-only transcript behind every task.

use anyhow::Result;
use std::collections::HashMap;

use warpforge_protocol as wire;

use super::snapshot::fold_for_snapshot;
use super::Store;

impl Store {
    pub fn save_session_update(&self, task_id: &str, update: &wire::SessionUpdate) -> Result<()> {
        let json = serde_json::to_string(update)?;
        let now = crate::daemon::task::now_secs() as i64;
        // created_at column may not exist on very old DBs if migration failed; fallback without it
        if self
            .conn
            .execute(
                "INSERT INTO session_updates (task_id, update_json, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![task_id, json, now],
            )
            .is_err()
        {
            self.conn.execute(
                "INSERT INTO session_updates (task_id, update_json) VALUES (?1, ?2)",
                rusqlite::params![task_id, json],
            )?;
        }
        Ok(())
    }

    pub fn load_session_updates(&self, task_id: &str) -> Result<Vec<wire::SessionUpdate>> {
        let mut stmt = self
            .conn
            .prepare("SELECT update_json FROM session_updates WHERE task_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map(rusqlite::params![task_id], |row| row.get::<_, String>(0))?;
        let mut updates = Vec::new();
        for row in rows.filter_map(|r| r.ok()) {
            if let Ok(update) = serde_json::from_str::<wire::SessionUpdate>(&row) {
                updates.push(update);
            }
        }
        Ok(updates)
    }

    pub fn load_last_session_update(&self, task_id: &str) -> Result<Option<wire::SessionUpdate>> {
        let mut stmt = self.conn.prepare(
            "SELECT update_json FROM session_updates WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
        )?;
        let mut rows = stmt.query(rusqlite::params![task_id])?;
        if let Some(row) = rows.next()? {
            let json: String = row.get(0)?;
            Ok(serde_json::from_str::<wire::SessionUpdate>(&json).ok())
        } else {
            Ok(None)
        }
    }

    /// First-seen timestamps of every streamed tool call, keyed by
    /// `(task_id, tool_call_id)`. Read once at daemon startup: the actor keeps
    /// only this small map rather than the full transcripts it was derived from.
    pub fn load_tool_call_starts(&self) -> Result<HashMap<(String, String), u64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, update_json FROM session_updates ORDER BY id")?;
        let mut map = HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows.filter_map(|r| r.ok()) {
            if let Ok(wire::SessionUpdate::ToolCall {
                tool_call_id,
                started_at: Some(started_at),
                ..
            }) = serde_json::from_str::<wire::SessionUpdate>(&row.1)
            {
                // First-seen wins. Later frames of the same tool call repeat the
                // timestamp the daemon assigned, but a daemon restart mid-call
                // can assign a new one — and this map exists precisely so a
                // call's start time does not move under the user.
                map.entry((row.0, tool_call_id)).or_insert(started_at);
            }
        }
        Ok(map)
    }

    /// Delete the session history of every finished task (`status = 'done'`)
    /// whose `updated_at` predates `cutoff` (epoch seconds). Returns the number
    /// of rows removed. Live work is never touched.
    pub fn prune_finished_session_updates(&self, cutoff: i64) -> Result<usize> {
        let deleted = self.conn.execute(
            "DELETE FROM session_updates
              WHERE task_id IN (SELECT id FROM tasks WHERE status = 'done' AND updated_at < ?1)",
            rusqlite::params![cutoff],
        )?;
        Ok(deleted)
    }

    /// Fold the write-ahead log back into the main database and truncate it.
    /// Called after a prune actually deleted rows, so the space (and a WAL
    /// that can otherwise grow to hundreds of megabytes) is returned.
    pub fn checkpoint_wal(&self) -> Result<()> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// Load persisted histories as semantic rows. Raw ACP text chunks and
    /// repeated tool lifecycle frames remain in SQLite for replay fidelity but
    /// are folded before building the desktop snapshot.
    pub fn load_all_session_updates(&self) -> Result<HashMap<String, Vec<wire::SessionUpdate>>> {
        let mut map = self.load_all_session_updates_raw()?;
        for updates in map.values_mut() {
            *updates = fold_for_snapshot(updates);
        }
        Ok(map)
    }

    /// Every persisted update, per task, exactly as written.
    ///
    /// Unlike [`Store::load_all_session_updates`] nothing is folded or trimmed:
    /// the resume replay guard matches the agent's replay against this history
    /// chunk for chunk, so a folded `AgentText` would never compare equal and
    /// the whole turn would be emitted twice.
    pub fn load_all_session_updates_raw(
        &self,
    ) -> Result<HashMap<String, Vec<wire::SessionUpdate>>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, update_json FROM session_updates ORDER BY id")?;
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

    pub fn load_spend_rows(&self) -> Result<Vec<(String, String, Option<i64>)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, update_json, created_at FROM session_updates ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }
}
