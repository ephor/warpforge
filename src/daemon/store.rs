//! SQLite persistence for the daemon. Tasks are the genuinely new, must-not-be-
//! lost state (projects still live in `~/.warpforge/projects.json`, port ranges
//! are derived from project index), so this store is task-focused for now.
//!
//! The connection is owned by the actor task and only ever touched from there,
//! so no locking is needed beyond what rusqlite provides.

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::PathBuf;

use warpforge_protocol as wire;

use super::task::{Task, TaskStatus};

/// Keep projected desktop state bounded like t3code's thread projector. Raw
/// rows stay durable in SQLite for agent resume/replay.
const MAX_SESSION_SNAPSHOT_UPDATES: usize = 2_000;
const SNAPSHOT_TRIM_HEADROOM: usize = 256;

fn append_snapshot_update(output: &mut Vec<wire::SessionUpdate>, update: wire::SessionUpdate) {
    match update {
        wire::SessionUpdate::AgentText { text } => {
            if let Some(wire::SessionUpdate::AgentText { text: previous }) = output.last_mut() {
                previous.push_str(&text);
            } else {
                output.push(wire::SessionUpdate::AgentText { text });
            }
        }
        wire::SessionUpdate::AgentThought { text } => {
            if let Some(wire::SessionUpdate::AgentThought { text: previous }) = output.last_mut() {
                previous.push_str(&text);
            } else {
                output.push(wire::SessionUpdate::AgentThought { text });
            }
        }
        wire::SessionUpdate::ToolCall {
            tool_call_id,
            title,
            status,
            started_at,
            tool_kind,
            content,
        } => {
            let existing = output.iter_mut().rev().find(|candidate| {
                matches!(
                    candidate,
                    wire::SessionUpdate::ToolCall {
                        tool_call_id: candidate_id,
                        ..
                    } if candidate_id == &tool_call_id
                )
            });
            if let Some(wire::SessionUpdate::ToolCall {
                title: previous_title,
                status: previous_status,
                started_at: previous_started_at,
                tool_kind: previous_kind,
                content: previous_content,
                ..
            }) = existing
            {
                if !title.is_empty() && title != tool_call_id {
                    *previous_title = title;
                }
                *previous_status = status;
                if previous_started_at.is_none() {
                    *previous_started_at = started_at;
                }
                if !tool_kind.is_empty() {
                    *previous_kind = tool_kind;
                }
                if content.is_some() {
                    *previous_content = content;
                }
            } else {
                output.push(wire::SessionUpdate::ToolCall {
                    tool_call_id,
                    title,
                    status,
                    started_at,
                    tool_kind,
                    content,
                });
            }
        }
        wire::SessionUpdate::FileEdit {
            path,
            tool_call_id: Some(tool_call_id),
            additions,
            deletions,
            hunks,
        } => {
            let existing = output.iter_mut().rev().find(|candidate| {
                matches!(
                    candidate,
                    wire::SessionUpdate::FileEdit {
                        tool_call_id: Some(candidate_id),
                        ..
                    } if candidate_id == &tool_call_id
                )
            });
            if let Some(wire::SessionUpdate::FileEdit {
                path: previous_path,
                additions: previous_additions,
                deletions: previous_deletions,
                hunks: previous_hunks,
                ..
            }) = existing
            {
                if !path.is_empty() {
                    *previous_path = path;
                }
                if additions.is_some() {
                    *previous_additions = additions;
                }
                if deletions.is_some() {
                    *previous_deletions = deletions;
                }
                if !hunks.is_empty() {
                    *previous_hunks = hunks;
                }
            } else {
                output.push(wire::SessionUpdate::FileEdit {
                    path,
                    tool_call_id: Some(tool_call_id),
                    additions,
                    deletions,
                    hunks,
                });
            }
        }
        update => output.push(update),
    }
}

fn db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
        .join("warpforge.db")
}

pub struct Store {
    conn: Connection,
}

/// A persisted agent account. Credentials never live here — only the vault path
/// and the display identity read out of it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredAccount {
    pub id: String,
    pub agent_id: String,
    pub label: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub home_dir: String,
    pub created_at: u64,
    pub active: bool,
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
                title           TEXT NOT NULL DEFAULT '',
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                files_changed   INTEGER NOT NULL,
                blocked_reason  TEXT,
                config_options  TEXT NOT NULL DEFAULT '[]',
                worktree        TEXT
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
            CREATE TABLE IF NOT EXISTS orchestrator_config (
                id         INTEGER PRIMARY KEY CHECK (id = 1),
                config_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_runs (
                task_id    TEXT PRIMARY KEY,
                run_json   TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_accounts (
                id         TEXT PRIMARY KEY,
                agent_id   TEXT NOT NULL,
                label      TEXT NOT NULL,
                email      TEXT,
                plan       TEXT,
                home_dir   TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_accounts_agent_idx
                ON agent_accounts(agent_id);
            CREATE TABLE IF NOT EXISTS active_account (
                agent_id   TEXT PRIMARY KEY,
                account_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tracker_links (
                item_id         TEXT PRIMARY KEY,
                provider        TEXT NOT NULL,
                project         TEXT NOT NULL DEFAULT '',
                external_id     TEXT NOT NULL,
                url             TEXT NOT NULL,
                status          TEXT NOT NULL,
                remote_status   TEXT,
                last_synced_at  INTEGER NOT NULL DEFAULT 0,
                task_id         TEXT
            );
            CREATE TABLE IF NOT EXISTS tracker_project_settings (
                project          TEXT PRIMARY KEY,
                linear_team_id   TEXT,
                linear_team_name TEXT
            );
            CREATE TABLE IF NOT EXISTS backlog_items (
                id TEXT PRIMARY KEY,
                number INTEGER NOT NULL,
                project TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo',
                priority TEXT NOT NULL DEFAULT 'none',
                source TEXT NOT NULL DEFAULT 'local',
                external_id TEXT,
                url TEXT,
                remote_status TEXT,
                assignee TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                task_id TEXT
            );
            CREATE INDEX IF NOT EXISTS backlog_items_project_idx
                ON backlog_items(project, number);
            "#,
        )?;
        // Existing databases from before config selector persistence won't have
        // this column. Ignore the duplicate-column error on newer DBs.
        let _ = conn.execute(
            "ALTER TABLE tasks ADD COLUMN config_options TEXT NOT NULL DEFAULT '[]'",
            [],
        );
        // Migration: add worktree column for tasks running in isolated git worktrees.
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN worktree TEXT", []);
        // Migration: add parent_task_id for orchestrator sub-agent tasks.
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT", []);
        // Migration: add title for human-readable task labels.
        let _ = conn.execute(
            "ALTER TABLE tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''",
            [],
        );
        // Migration: cache probed ACP model selectors + the user's last pick so
        // the New Task view can show a model picker before any prompt is sent
        // and so orchestrator-spawned sub-agents inherit the last choice.
        let _ = conn.execute(
            "ALTER TABLE agents ADD COLUMN models TEXT NOT NULL DEFAULT '[]'",
            [],
        );
        let _ = conn.execute("ALTER TABLE agents ADD COLUMN last_model TEXT", []);
        // Migration: lifecycle fields for settle/snooze visibility overlay.
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN settled_override INTEGER", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN settled_at INTEGER", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN snoozed_at INTEGER", []);
        // Migration: remember which agent account a task's session ran under, so
        // resume/restart reuses it after the active account changed.
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN account_id TEXT", []);
        // Migration: link a task back to the backlog item it was started from.
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN backlog_item_id TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN blocked_kind TEXT", []);
        // Migration: last explicit model intent the user expressed for a task
        // (creation default or an accepted mid-session switch), so resume
        // reconciles the live session to it after a daemon restart.
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN model TEXT", []);
        // Migration: mark links minted by an import, so unmapping a tracker can
        // drop its mirrored rows without touching items written here and pushed
        // out. Existing rows default to 0 — not provably imported, never purged.
        let _ = conn.execute(
            "ALTER TABLE tracker_links ADD COLUMN imported INTEGER NOT NULL DEFAULT 0",
            [],
        );
        Ok(Self { conn })
    }

    /// Run `writes` as one transaction. The persistence actor (see
    /// `daemon/runtime/persist.rs`) drains its queue through here so a burst of
    /// streamed session updates costs one commit instead of one per row.
    ///
    /// On any error the whole batch is rolled back — a half-applied batch would
    /// leave a task row without the session updates that explain it.
    pub fn write_batch(&self, writes: impl FnOnce(&Self) -> Result<()>) -> Result<()> {
        self.conn.execute_batch("BEGIN")?;
        match writes(self) {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

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

    /// Returns true if the agents table has at least one row.
    pub fn agents_configured(&self) -> bool {
        self.conn
            .query_row("SELECT COUNT(*) FROM agents", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    pub fn load_agents(&self) -> Result<Vec<wire::AgentConfig>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, display_name, acp_command, enabled, models, last_model FROM agents ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            let models_json: String = row.get(4)?;
            let models: Vec<wire::ConfigOption> =
                serde_json::from_str(&models_json).unwrap_or_default();
            Ok(wire::AgentConfig {
                id: row.get(0)?,
                display_name: row.get(1)?,
                acp_command: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                models,
                last_model: row.get::<_, Option<String>>(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Every registered agent account, with the active flag resolved from
    /// `active_account`. Usage is not persisted — it is a live readout.
    pub fn load_accounts(&self) -> Result<Vec<StoredAccount>> {
        let mut stmt = self.conn.prepare(
            "SELECT a.id, a.agent_id, a.label, a.email, a.plan, a.home_dir, a.created_at, \
             (SELECT account_id FROM active_account WHERE agent_id = a.agent_id) \
             FROM agent_accounts a ORDER BY a.agent_id, a.created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let active_id: Option<String> = row.get(7)?;
            Ok(StoredAccount {
                active: active_id.as_deref() == Some(id.as_str()),
                id,
                agent_id: row.get(1)?,
                label: row.get(2)?,
                email: row.get(3)?,
                plan: row.get(4)?,
                home_dir: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn upsert_account(&self, account: &StoredAccount) -> Result<()> {
        self.conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, label, email, plan, home_dir, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7) \
             ON CONFLICT(id) DO UPDATE SET \
                label=excluded.label, email=excluded.email, plan=excluded.plan, \
                home_dir=excluded.home_dir",
            rusqlite::params![
                account.id,
                account.agent_id,
                account.label,
                account.email,
                account.plan,
                account.home_dir,
                account.created_at,
            ],
        )?;
        Ok(())
    }

    /// Delete an account row and, when it was the active one, clear the
    /// selection for its agent. Leaving a dangling active id would resolve to
    /// "no account" on every later lookup with no way to notice.
    pub fn delete_account(&self, account_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM active_account WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn
            .execute("DELETE FROM agent_accounts WHERE id = ?1", [account_id])?;
        Ok(())
    }

    pub fn set_active_account(&self, agent_id: &str, account_id: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO active_account (agent_id, account_id) VALUES (?1,?2) \
             ON CONFLICT(agent_id) DO UPDATE SET account_id=excluded.account_id",
            [agent_id, account_id],
        )?;
        Ok(())
    }

    pub fn save_agents(&self, agents: &[wire::AgentConfig]) -> Result<()> {
        self.conn.execute("DELETE FROM agents", [])?;
        for a in agents {
            let models_json = serde_json::to_string(&a.models)?;
            self.conn.execute(
                "INSERT INTO agents (id, display_name, acp_command, enabled, models, last_model) \
                 VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    a.id,
                    a.display_name,
                    a.acp_command,
                    a.enabled as i64,
                    models_json,
                    a.last_model,
                ],
            )?;
        }
        Ok(())
    }

    /// Update only the probed model selectors and the last-used model for one
    /// agent, without touching the rest of the row.
    pub fn update_agent_models(
        &self,
        id: &str,
        models: &[wire::ConfigOption],
        last_model: Option<&str>,
    ) -> Result<()> {
        let models_json = serde_json::to_string(models)?;
        self.conn.execute(
            "UPDATE agents SET models = ?1, last_model = ?2 WHERE id = ?3",
            rusqlite::params![models_json, last_model, id],
        )?;
        Ok(())
    }

    pub fn load_orchestrator_config(
        &self,
    ) -> Result<Option<crate::orchestration::config::OrchestratorConfig>> {
        let mut stmt = self
            .conn
            .prepare("SELECT config_json FROM orchestrator_config WHERE id = 1")?;
        let mut rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        if let Some(Ok(json)) = rows.next() {
            Ok(serde_json::from_str(&json).ok())
        } else {
            Ok(None)
        }
    }

    pub fn save_orchestrator_config(
        &self,
        config: &crate::orchestration::config::OrchestratorConfig,
    ) -> Result<()> {
        let json = serde_json::to_string(config)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO orchestrator_config (id, config_json) VALUES (1, ?1)",
            rusqlite::params![json],
        )?;
        Ok(())
    }

    /// Persist a workflow pipeline's full state (spec snapshot included) as
    /// one JSON blob, replacing any previous snapshot for the task.
    pub fn save_workflow_run(&self, task_id: &str, run_json: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO workflow_runs (task_id, run_json, updated_at) \
             VALUES (?1, ?2, strftime('%s','now'))",
            rusqlite::params![task_id, run_json],
        )?;
        Ok(())
    }

    /// All persisted workflow runs as (task_id, run_json) pairs.
    pub fn load_workflow_runs(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, run_json FROM workflow_runs")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_workflow_run(&self, task_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM workflow_runs WHERE task_id = ?1",
            rusqlite::params![task_id],
        )?;
        Ok(())
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

    pub fn save_session_update(&self, task_id: &str, update: &wire::SessionUpdate) -> Result<()> {
        let json = serde_json::to_string(update)?;
        self.conn.execute(
            "INSERT INTO session_updates (task_id, update_json) VALUES (?1, ?2)",
            rusqlite::params![task_id, json],
        )?;
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

    pub fn upsert_backlog_item(&self, item: &wire::BacklogItem) -> Result<()> {
        self.conn.execute(
            r#"INSERT INTO backlog_items
               (id, number, project, title, body, status, priority, source,
                external_id, url, remote_status, assignee, created_at, updated_at, task_id)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, body=excluded.body, status=excluded.status,
                 priority=excluded.priority, source=excluded.source,
                 external_id=excluded.external_id, url=excluded.url,
                 remote_status=excluded.remote_status, assignee=excluded.assignee,
                 updated_at=excluded.updated_at, task_id=excluded.task_id"#,
            rusqlite::params![
                item.id,
                item.number,
                item.project,
                item.title,
                item.body,
                item.status,
                item.priority,
                item.source,
                item.external_id,
                item.url,
                item.remote_status,
                item.assignee,
                item.created_at,
                item.updated_at,
                item.task_id,
            ],
        )?;
        Ok(())
    }

    pub fn patch_backlog_external(
        &self,
        item_id: &str,
        external_id: &str,
        url: &str,
        source: &str,
        remote_status: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET external_id=?1, url=?2, source=?3, remote_status=?4, updated_at=?5 WHERE id=?6",
            rusqlite::params![external_id, url, source, remote_status, super::task::now_secs(), item_id],
        )?;
        Ok(())
    }

    pub fn get_backlog_item(&self, item_id: &str) -> Result<Option<wire::BacklogItem>> {
        let mut statement = self.conn.prepare("SELECT id,number,project,title,body,status,priority,source,external_id,url,remote_status,assignee,created_at,updated_at,task_id FROM backlog_items WHERE id=?1")?;
        let mut rows = statement.query_map(rusqlite::params![item_id], backlog_row)?;
        rows.next().transpose().map_err(Into::into)
    }

    pub fn link_backlog_task(&self, item_id: &str, task_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET task_id=?1, status='in_progress', updated_at=?2 WHERE id=?3",
            rusqlite::params![task_id, super::task::now_secs(), item_id],
        )?;
        Ok(())
    }

    /// Refresh the fields a tracker owns. `updated_at` is the caller's to pass:
    /// a mirrored row carries the *issue's* last-touched time, not the moment
    /// its sync ran, and only the import path knows the difference.
    pub fn update_backlog_remote(
        &self,
        item_id: &str,
        status: &str,
        remote_status: Option<&str>,
        url: &str,
        updated_at: u64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET status=?1, remote_status=?2, url=?3, updated_at=?4 WHERE id=?5",
            rusqlite::params![status, remote_status, url, updated_at, item_id],
        )?;
        Ok(())
    }

    /// Adopt the tracker's answer for who an issue is assigned to. Separate
    /// from the update above for the same reason as `set_backlog_created_at`:
    /// a caller without the issue in hand must not be able to clear it.
    pub fn set_backlog_assignee(&self, item_id: &str, assignee: Option<&str>) -> Result<()> {
        self.conn.execute(
            // `IS NOT` rather than `<>`, so unassigned (NULL) compares equal to
            // unassigned and the row is left alone.
            "UPDATE backlog_items SET assignee=?1 WHERE id=?2 AND assignee IS NOT ?1",
            rusqlite::params![assignee, item_id],
        )?;
        Ok(())
    }

    /// Correct an imported row's creation time. Separate from the update above
    /// because `created_at` is written once and then only ever repaired — a
    /// caller that does not know the issue's real creation time must not be
    /// able to overwrite it with the time of its own sync.
    pub fn set_backlog_created_at(&self, item_id: &str, created_at: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET created_at=?1 WHERE id=?2 AND created_at<>?1",
            rusqlite::params![created_at, item_id],
        )?;
        Ok(())
    }

    pub fn next_backlog_number(&self, project: &str) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(MAX(number), 0) + 1 FROM backlog_items WHERE project = ?1",
            rusqlite::params![project],
            |row| row.get(0),
        )?)
    }

    /// Delete a backlog item row (used to roll back a failed external create).
    pub fn delete_backlog_item(&self, item_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM backlog_items WHERE id = ?1",
            rusqlite::params![item_id],
        )?;
        Ok(())
    }

    /// Number of backlog item rows across all projects. Used to refuse a switch
    /// away from SQLite storage rather than silently hiding existing rows.
    pub fn count_backlog_items(&self) -> Result<u64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM backlog_items", [], |row| row.get(0))?)
    }

    pub fn list_backlog(
        &self,
        project: &str,
        query: &super::backlog::Query,
    ) -> Result<wire::BacklogPage> {
        // `priority` and `status` are enum-valued words, so ORDER BY on the raw
        // column sorts them alphabetically ("high" before "low" before
        // "urgent") — an order nobody asked for. Sort on their rank instead.
        let sort_column = match query.sort_by.as_str() {
            "title" => "title COLLATE NOCASE",
            "status" => super::backlog::STATUS_RANK_SQL,
            "priority" => super::backlog::PRIORITY_RANK_SQL,
            "source" => "source",
            "assignee" => "assignee COLLATE NOCASE",
            "number" => "number",
            _ => "updated_at",
        };
        let direction = if query.sort_desc { "DESC" } else { "ASC" };
        let page = query.page;
        let page_size = query.page_size.clamp(1, 100);
        let offset = page as u64 * page_size as u64;
        let search = query.search.trim();
        let pattern = format!("%{search}%");
        let (status, source, priority) = (
            query.status.as_deref(),
            query.source.as_deref(),
            query.priority.as_deref(),
        );
        let assignee_pattern = query
            .assignee
            .as_deref()
            .map(|value| format!("%{}%", value.trim()));
        let where_sql = "project = ?1 AND (?2 = '' OR title LIKE ?3 OR body LIKE ?3)\
                         AND (?4 IS NULL OR status = ?4)\
                         AND (?5 IS NULL OR source = ?5)\
                         AND (?6 IS NULL OR priority = ?6)\
                         AND (?7 IS NULL OR assignee LIKE ?7)";
        let count: u64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM backlog_items WHERE {where_sql}"),
            rusqlite::params![
                project,
                search,
                pattern,
                status,
                source,
                priority,
                assignee_pattern
            ],
            |row| row.get(0),
        )?;
        let sql = format!(
            "SELECT id,number,project,title,body,status,priority,source,external_id,url,remote_status,assignee,created_at,updated_at,task_id FROM backlog_items WHERE {where_sql} ORDER BY {sort_column} {direction}, id ASC LIMIT ?8 OFFSET ?9"
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(
            rusqlite::params![
                project,
                search,
                pattern,
                status,
                source,
                priority,
                assignee_pattern,
                page_size,
                offset
            ],
            backlog_row,
        )?;
        let items: Vec<wire::BacklogItem> = rows.collect::<std::result::Result<_, _>>()?;
        Ok(wire::BacklogPage {
            items,
            page,
            page_size,
            total: count,
            has_next_page: offset + (page_size as u64) < count,
        })
    }

    pub fn set_backlog_storage_mode(&self, mode: wire::BacklogStorageMode) -> Result<()> {
        let value = serde_json::to_string(&mode)?;
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS backlog_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)",
            [],
        )?;
        self.conn.execute(
            "INSERT INTO backlog_settings(id, mode) VALUES(1, ?1) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode",
            rusqlite::params![value.trim_matches('"')],
        )?;
        Ok(())
    }

    pub fn backlog_storage_mode(&self) -> Result<wire::BacklogStorageMode> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS backlog_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)",
            [],
        )?;
        let mode: Option<String> = self
            .conn
            .query_row("SELECT mode FROM backlog_settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(match mode.as_deref() {
            Some("yaml") => wire::BacklogStorageMode::Yaml,
            _ => wire::BacklogStorageMode::Sqlite,
        })
    }
}

fn backlog_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<wire::BacklogItem> {
    Ok(wire::BacklogItem {
        id: row.get(0)?,
        number: row.get(1)?,
        project: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        status: row.get(5)?,
        priority: row.get(6)?,
        source: row.get(7)?,
        external_id: row.get(8)?,
        url: row.get(9)?,
        remote_status: row.get(10)?,
        assignee: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        task_id: row.get(14)?,
    })
}

/// Fold a raw history into the shape the desktop snapshot wants: streamed text
/// concatenated, repeated tool frames collapsed, oldest entries dropped past
/// the cap.
pub fn fold_for_snapshot(updates: &[wire::SessionUpdate]) -> Vec<wire::SessionUpdate> {
    let mut output: Vec<wire::SessionUpdate> = Vec::new();
    for update in updates {
        append_snapshot_update(&mut output, update.clone());
        if output.len() > MAX_SESSION_SNAPSHOT_UPDATES + SNAPSHOT_TRIM_HEADROOM {
            let overflow = output.len() - MAX_SESSION_SNAPSHOT_UPDATES;
            output.drain(..overflow);
        }
    }
    if output.len() > MAX_SESSION_SNAPSHOT_UPDATES {
        let overflow = output.len() - MAX_SESSION_SNAPSHOT_UPDATES;
        output.drain(..overflow);
    }
    output
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

/// A persisted backlog-item ↔ external-tracker-issue link. This is what keeps
/// the desktop's backlog table in sync with GitHub/Linear without the daemon
/// owning the items themselves (they still live in zustand/localStorage).
#[derive(Debug, Clone, PartialEq)]
pub struct TrackerLink {
    pub item_id: String,
    pub provider: String,
    pub project: String,
    pub external_id: String,
    pub url: String,
    pub status: String,
    pub remote_status: Option<String>,
    pub last_synced_at: u64,
    pub task_id: Option<String>,
    /// True when `adopt_imported` minted this link from a tracker listing, as
    /// opposed to an item written here and pushed out. Only imported rows are
    /// eligible for the purge that follows a mapping change.
    pub imported: bool,
}

impl TrackerLink {
    pub fn to_wire(&self) -> wire::TrackerLinkInfo {
        wire::TrackerLinkInfo {
            item_id: self.item_id.clone(),
            provider: self.provider.clone(),
            external_id: self.external_id.clone(),
            url: self.url.clone(),
            status: self.status.clone(),
            remote_status: self.remote_status.clone(),
            last_synced_at: self.last_synced_at,
            task_id: self.task_id.clone(),
        }
    }
}

impl Store {
    pub fn upsert_tracker_link(&self, link: &TrackerLink) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO tracker_links
                (item_id, provider, project, external_id, url, status, remote_status,
                 last_synced_at, task_id, imported)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
            ON CONFLICT(item_id) DO UPDATE SET
                provider=excluded.provider,
                project=excluded.project,
                external_id=excluded.external_id,
                url=excluded.url,
                status=excluded.status,
                remote_status=excluded.remote_status,
                last_synced_at=excluded.last_synced_at,
                task_id=excluded.task_id,
                imported=excluded.imported
            "#,
            rusqlite::params![
                link.item_id,
                link.provider,
                link.project,
                link.external_id,
                link.url,
                link.status,
                link.remote_status,
                link.last_synced_at,
                link.task_id,
                link.imported,
            ],
        )?;
        Ok(())
    }

    pub fn load_tracker_link(&self, item_id: &str) -> Result<Option<TrackerLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_id, provider, project, external_id, url, status, remote_status, \
             last_synced_at, task_id, imported FROM tracker_links WHERE item_id = ?1",
        )?;
        let mut rows = stmt.query_map(rusqlite::params![item_id], |row| {
            Ok(TrackerLink {
                item_id: row.get(0)?,
                provider: row.get(1)?,
                project: row.get(2)?,
                external_id: row.get(3)?,
                url: row.get(4)?,
                status: row.get(5)?,
                remote_status: row.get(6)?,
                last_synced_at: row.get::<_, u64>(7)?,
                task_id: row.get(8)?,
                imported: row.get::<_, i64>(9)? != 0,
            })
        })?;
        rows.next().transpose().map_err(Into::into)
    }

    pub fn load_all_tracker_links(&self) -> Result<Vec<TrackerLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_id, provider, project, external_id, url, status, remote_status, \
             last_synced_at, task_id, imported FROM tracker_links ORDER BY last_synced_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TrackerLink {
                item_id: row.get(0)?,
                provider: row.get(1)?,
                project: row.get(2)?,
                external_id: row.get(3)?,
                url: row.get(4)?,
                status: row.get(5)?,
                remote_status: row.get(6)?,
                last_synced_at: row.get::<_, u64>(7)?,
                task_id: row.get(8)?,
                imported: row.get::<_, i64>(9)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn tracker_project_settings(&self, project: &str) -> Result<wire::TrackerProjectSettings> {
        let found = self
            .conn
            .query_row(
                "SELECT linear_team_id, linear_team_name FROM tracker_project_settings \
                 WHERE project = ?1",
                rusqlite::params![project],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let (linear_team_id, linear_team_name) = found.unwrap_or((None, None));
        Ok(wire::TrackerProjectSettings {
            project: project.to_string(),
            linear_team_id,
            linear_team_name,
        })
    }

    pub fn set_tracker_project_linear_team(
        &self,
        project: &str,
        team_id: Option<&str>,
        team_name: Option<&str>,
    ) -> Result<wire::TrackerProjectSettings> {
        self.conn.execute(
            "INSERT INTO tracker_project_settings(project, linear_team_id, linear_team_name) \
             VALUES(?1, ?2, ?3) ON CONFLICT(project) DO UPDATE SET \
             linear_team_id = excluded.linear_team_id, \
             linear_team_name = excluded.linear_team_name",
            rusqlite::params![project, team_id, team_name],
        )?;
        self.tracker_project_settings(project)
    }

    /// Drop the rows a *previous* Linear mapping imported into one project, when
    /// that mapping changes or is removed: they mirror a team this project is no
    /// longer reading, so keeping them means a backlog of other people's work
    /// with nothing to say where it came from. Returns how many went.
    ///
    /// Only rows `adopt_imported` created (`imported = 1`) are eligible. An item
    /// somebody wrote here and pushed to Linear also carries a link, and its
    /// title, body and priority are local-only — deleting that would lose work.
    pub fn delete_imported_linear_items(&self, project: &str) -> Result<usize> {
        let item_ids: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT item_id FROM tracker_links \
                 WHERE provider = 'linear' AND project = ?1 AND imported = 1",
            )?;
            let rows = stmt.query_map(rusqlite::params![project], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for item_id in &item_ids {
            self.conn.execute(
                "DELETE FROM backlog_items WHERE id = ?1",
                rusqlite::params![item_id],
            )?;
            self.conn.execute(
                "DELETE FROM tracker_links WHERE item_id = ?1",
                rusqlite::params![item_id],
            )?;
        }
        Ok(item_ids.len())
    }

    pub fn delete_tracker_link(&self, item_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM tracker_links WHERE item_id = ?1",
            rusqlite::params![item_id],
        )?;
        Ok(())
    }

    /// Link a daemon task to a backlog item (also called when the item was
    /// created locally without an external tracker).
    pub fn set_tracker_link_task(&self, item_id: &str, task_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tracker_links SET task_id = ?1 WHERE item_id = ?2",
            rusqlite::params![task_id, item_id],
        )?;
        Ok(())
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
        task.config_options = vec![wire::ConfigOption {
            id: "model".into(),
            name: "Model".into(),
            category: Some("model".into()),
            current_value: "opus".into(),
            options: vec![wire::ConfigChoice {
                value: "opus".into(),
                name: "Opus".into(),
            }],
        }];
        store.upsert_task(&task).unwrap();

        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        // Running at persist time -> Interrupted on reload (no session resumption).
        assert_eq!(loaded[0].status, TaskStatus::Interrupted);
        assert_eq!(loaded[0].id, task.id);
        assert_eq!(loaded[0].session_id.as_deref(), Some("sess-1"));
        assert_eq!(loaded[0].tags, vec!["x".to_string()]);
        assert_eq!(loaded[0].config_options, task.config_options);
    }

    /// The task's model intent must survive a restart: it is what resume
    /// reconciles the reloaded session against.
    #[test]
    fn task_model_roundtrips_and_defaults_to_none() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();

        // No intent expressed -> stays None.
        let plain = Task::new("demo", "p", "claude", vec![]);
        store.upsert_task(&plain).unwrap();

        let mut picked = Task::new("demo", "p", "claude", vec![]);
        picked.model = Some("claude-opus-5".into());
        store.upsert_task(&picked).unwrap();

        // An update must overwrite, not just insert.
        let mut switched = picked.clone();
        switched.model = Some("claude-sonnet-4".into());
        store.upsert_task(&switched).unwrap();

        let loaded = store.load_tasks().unwrap();
        let by_id = |id: &str| {
            loaded
                .iter()
                .find(|t| t.id == id)
                .unwrap_or_else(|| panic!("task {id} missing"))
                .clone()
        };
        assert_eq!(by_id(&plain.id).model, None);
        // The switch (same task id) overwrote the original pick.
        assert_eq!(by_id(&picked.id).model, Some("claude-sonnet-4".into()));
    }

    /// An existing database without the `model` column must still load.
    #[test]
    fn task_model_survives_upgrade_from_pre_model_schema() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("warpforge.db");
        {
            let pre = Connection::open(&db_path).unwrap();
            pre.execute_batch(
                r#"
                CREATE TABLE tasks (
                    id              TEXT PRIMARY KEY,
                    session_id      TEXT,
                    project         TEXT NOT NULL,
                    prompt          TEXT NOT NULL,
                    agent           TEXT NOT NULL,
                    status          TEXT NOT NULL,
                    tags            TEXT NOT NULL,
                    title           TEXT NOT NULL DEFAULT '',
                    created_at      INTEGER NOT NULL,
                    updated_at      INTEGER NOT NULL,
                    files_changed   INTEGER NOT NULL,
                    blocked_reason  TEXT,
                    config_options  TEXT NOT NULL DEFAULT '[]',
                    worktree        TEXT,
                    parent_task_id  TEXT
                );
                INSERT INTO tasks (id, session_id, project, prompt, agent, status, tags, title,
                                   created_at, updated_at, files_changed, blocked_reason, config_options)
                VALUES ('pre-model', NULL, 'proj', 'p', 'claude', 'waiting', '[]', 'Old task',
                        1700000000, 1700000001, 0, NULL, '[]');
                "#,
            )
            .unwrap();
        }

        let store = Store::open_at(&db_path).unwrap();
        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].model, None);
        // And an intent written into the upgraded schema reads back.
        let mut task = loaded[0].clone();
        task.model = Some("claude-opus-5".into());
        store.upsert_task(&task).unwrap();
        assert_eq!(
            store.load_tasks().unwrap()[0].model,
            Some("claude-opus-5".into())
        );
    }

    fn account(id: &str, agent: &str, label: &str) -> StoredAccount {
        StoredAccount {
            id: id.to_string(),
            agent_id: agent.to_string(),
            label: label.to_string(),
            email: Some(format!("{label}@example.com")),
            plan: Some("pro".into()),
            home_dir: format!("/tmp/{id}"),
            created_at: 1,
            active: false,
        }
    }

    #[test]
    fn accounts_roundtrip_with_active_selection() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        store
            .upsert_account(&account("codex:personal", "codex", "personal"))
            .unwrap();
        store
            .upsert_account(&account("codex:work", "codex", "work"))
            .unwrap();
        store
            .upsert_account(&account("claude:personal", "claude", "personal"))
            .unwrap();

        // No selection yet: nothing is active.
        assert!(store.load_accounts().unwrap().iter().all(|a| !a.active));

        store.set_active_account("codex", "codex:work").unwrap();
        let loaded = store.load_accounts().unwrap();
        let active: Vec<&str> = loaded
            .iter()
            .filter(|a| a.active)
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(active, vec!["codex:work"]);

        // Selection is per agent — picking a Codex account leaves Claude alone.
        store
            .set_active_account("claude", "claude:personal")
            .unwrap();
        let loaded = store.load_accounts().unwrap();
        assert_eq!(loaded.iter().filter(|a| a.active).count(), 2);

        // Rename is an update, not a second row.
        let mut renamed = account("codex:work", "codex", "job");
        renamed.email = Some("job@example.com".into());
        store.upsert_account(&renamed).unwrap();
        let loaded = store.load_accounts().unwrap();
        assert_eq!(loaded.len(), 3);
        let work = loaded.iter().find(|a| a.id == "codex:work").unwrap();
        assert_eq!(work.label, "job");
        assert!(work.active, "rename must not drop the active selection");
    }

    #[test]
    fn deleting_active_account_clears_selection() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        store
            .upsert_account(&account("codex:personal", "codex", "personal"))
            .unwrap();
        store.set_active_account("codex", "codex:personal").unwrap();

        store.delete_account("codex:personal").unwrap();
        assert!(store.load_accounts().unwrap().is_empty());

        // A dangling active row would make the next account silently inactive.
        store
            .upsert_account(&account("codex:personal", "codex", "personal"))
            .unwrap();
        assert!(store.load_accounts().unwrap().iter().all(|a| !a.active));
    }

    #[test]
    fn task_remembers_its_account() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let mut task = Task::new("demo", "do a thing", "codex", vec![]);
        task.account_id = Some("codex:work".into());
        store.upsert_task(&task).unwrap();
        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded[0].account_id.as_deref(), Some("codex:work"));
    }

    #[test]
    fn snapshot_history_coalesces_transport_chunks_but_raw_history_remains() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        for text in ["Hel", "lo", "!"] {
            store
                .save_session_update(
                    "task-1",
                    &wire::SessionUpdate::AgentText { text: text.into() },
                )
                .unwrap();
        }

        let raw = store.load_session_updates("task-1").unwrap();
        assert_eq!(raw.len(), 3);
        let snapshot = store.load_all_session_updates().unwrap();
        assert_eq!(
            snapshot["task-1"],
            vec![wire::SessionUpdate::AgentText {
                text: "Hello!".into()
            }]
        );
    }

    #[test]
    fn snapshot_history_is_bounded_without_deleting_raw_history() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        for index in 0..MAX_SESSION_SNAPSHOT_UPDATES + 5 {
            store
                .save_session_update(
                    "task-1",
                    &wire::SessionUpdate::UserMessage {
                        text: format!("prompt-{index}"),
                        attachments: vec![],
                    },
                )
                .unwrap();
        }

        assert_eq!(
            store.load_session_updates("task-1").unwrap().len(),
            MAX_SESSION_SNAPSHOT_UPDATES + 5
        );
        let snapshot = store.load_all_session_updates().unwrap();
        assert_eq!(snapshot["task-1"].len(), MAX_SESSION_SNAPSHOT_UPDATES);
        assert_eq!(
            snapshot["task-1"].first(),
            Some(&wire::SessionUpdate::UserMessage {
                text: "prompt-5".into(),
                attachments: vec![],
            })
        );
    }

    #[test]
    fn lifecycle_fields_null_default_roundtrip() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let task = Task::new("demo", "do a thing", "claude", vec![]);
        store.upsert_task(&task).unwrap();

        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].settled_override, None);
        assert_eq!(loaded[0].settled_at, None);
        assert_eq!(loaded[0].snoozed_until, None);
        assert_eq!(loaded[0].snoozed_at, None);
    }

    #[test]
    fn lifecycle_fields_non_null_roundtrip() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let mut task = Task::new("demo", "do a thing", "claude", vec![]);
        task.settled_override = Some(true);
        task.settled_at = Some(1_700_000_000);
        task.snoozed_until = Some(1_700_001_000);
        task.snoozed_at = Some(1_700_000_500);
        store.upsert_task(&task).unwrap();

        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].settled_override, Some(true));
        assert_eq!(loaded[0].settled_at, Some(1_700_000_000));
        assert_eq!(loaded[0].snoozed_until, Some(1_700_001_000));
        assert_eq!(loaded[0].snoozed_at, Some(1_700_000_500));
    }

    #[test]
    fn lifecycle_fields_settled_override_false_roundtrip() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let mut task = Task::new("demo", "do a thing", "claude", vec![]);
        task.settled_override = Some(false);
        store.upsert_task(&task).unwrap();

        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded[0].settled_override, Some(false));
    }

    #[test]
    fn pre_lifecycle_schema_migration_loads_null() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("warpforge.db");
        {
            let pre = Connection::open(&db_path).unwrap();
            pre.execute_batch(
                r#"
                CREATE TABLE tasks (
                    id              TEXT PRIMARY KEY,
                    session_id      TEXT,
                    project         TEXT NOT NULL,
                    prompt          TEXT NOT NULL,
                    agent           TEXT NOT NULL,
                    status          TEXT NOT NULL,
                    tags            TEXT NOT NULL,
                    title           TEXT NOT NULL DEFAULT '',
                    created_at      INTEGER NOT NULL,
                    updated_at      INTEGER NOT NULL,
                    files_changed   INTEGER NOT NULL,
                    blocked_reason  TEXT,
                    config_options  TEXT NOT NULL DEFAULT '[]',
                    worktree        TEXT,
                    parent_task_id  TEXT
                );
                INSERT INTO tasks (id, session_id, project, prompt, agent, status, tags, title,
                                   created_at, updated_at, files_changed, blocked_reason, config_options)
                VALUES ('old-1', NULL, 'proj', 'prompt', 'claude', 'idle', '[]', 'Old task',
                        1700000000, 1700000001, 0, NULL, '[]');
                "#,
            )
            .unwrap();
        }

        let store = Store::open_at(&db_path).unwrap();
        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "old-1");
        assert_eq!(loaded[0].settled_override, None);
        assert_eq!(loaded[0].settled_at, None);
        assert_eq!(loaded[0].snoozed_until, None);
        assert_eq!(loaded[0].snoozed_at, None);
    }

    /// `Idle` and `NeedsReview` merged into `Waiting`, but every existing
    /// install has rows on disk spelled the old way. Both must still load, or
    /// upgrading silently resets live tasks to `Queued` (the fallback arm).
    #[test]
    fn legacy_idle_and_needs_review_load_as_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("warpforge.db");
        {
            let pre = Connection::open(&db_path).unwrap();
            pre.execute_batch(
                r#"
                CREATE TABLE tasks (
                    id              TEXT PRIMARY KEY,
                    session_id      TEXT,
                    project         TEXT NOT NULL,
                    prompt          TEXT NOT NULL,
                    agent           TEXT NOT NULL,
                    status          TEXT NOT NULL,
                    tags            TEXT NOT NULL,
                    title           TEXT NOT NULL DEFAULT '',
                    created_at      INTEGER NOT NULL,
                    updated_at      INTEGER NOT NULL,
                    files_changed   INTEGER NOT NULL,
                    blocked_reason  TEXT,
                    config_options  TEXT NOT NULL DEFAULT '[]',
                    worktree        TEXT,
                    parent_task_id  TEXT
                );
                INSERT INTO tasks (id, session_id, project, prompt, agent, status, tags, title,
                                   created_at, updated_at, files_changed, blocked_reason, config_options)
                VALUES ('legacy-idle', NULL, 'proj', 'p', 'claude', 'idle', '[]', 'Idle task',
                        1700000000, 1700000001, 0, NULL, '[]'),
                       ('legacy-review', NULL, 'proj', 'p', 'claude', 'needs_review', '[]', 'Review task',
                        1700000000, 1700000002, 3, NULL, '[]');
                "#,
            )
            .unwrap();
        }

        let store = Store::open_at(&db_path).unwrap();
        let loaded = store.load_tasks().unwrap();
        let by_id = |id: &str| loaded.iter().find(|t| t.id == id).unwrap().clone();

        assert_eq!(by_id("legacy-idle").status, TaskStatus::Waiting);
        assert_eq!(by_id("legacy-review").status, TaskStatus::Waiting);
        // The distinction the old pair encoded survives as the field it always
        // really was.
        assert_eq!(by_id("legacy-idle").files_changed, 0);
        assert_eq!(by_id("legacy-review").files_changed, 3);
    }

    #[test]
    fn waiting_status_roundtrips_under_its_new_spelling() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let mut task = Task::new("demo", "do a thing", "claude", vec![]);
        task.set_status(TaskStatus::Waiting);
        assert_eq!(task.status.to_string(), "waiting");
        store.upsert_task(&task).unwrap();

        let loaded = store.load_tasks().unwrap();
        assert_eq!(loaded[0].status, TaskStatus::Waiting);
    }
}

#[cfg(test)]
mod backlog_query_tests {
    use super::*;

    fn item(id: &str, n: u64, title: &str, status: &str, priority: &str) -> wire::BacklogItem {
        wire::BacklogItem {
            id: id.into(),
            number: n,
            project: "p".into(),
            title: title.into(),
            body: String::new(),
            status: status.into(),
            priority: priority.into(),
            source: "local".into(),
            external_id: None,
            url: None,
            remote_status: None,
            assignee: None,
            created_at: 1000 + n,
            updated_at: 1000 + n,
            task_id: None,
        }
    }

    fn query(page: u32) -> crate::daemon::backlog::Query {
        crate::daemon::backlog::Query {
            page,
            page_size: 2,
            sort_by: "updatedAt".into(),
            sort_desc: true,
            search: String::new(),
            status: None,
            source: None,
            priority: None,
            assignee: None,
        }
    }

    #[test]
    fn backlog_pages_both_directions_and_filters() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        for n in 1..=5 {
            let status = if n == 2 { "done" } else { "todo" };
            store
                .upsert_backlog_item(&item(
                    &format!("i{n}"),
                    n,
                    &format!("Issue {n}"),
                    status,
                    "none",
                ))
                .unwrap();
        }

        // Page 0 (newest first): items 5, 4.
        let page0 = store.list_backlog("p", &query(0)).unwrap();
        assert_eq!(page0.total, 5);
        let nums: Vec<u64> = page0.items.iter().map(|i| i.number).collect();
        assert_eq!(nums, vec![5, 4]);
        assert!(page0.has_next_page);

        // Page 1 (back from page 1 to 0 must be symmetric).
        let page1 = store.list_backlog("p", &query(1)).unwrap();
        let nums1: Vec<u64> = page1.items.iter().map(|i| i.number).collect();
        assert_eq!(nums1, vec![3, 2]);

        // Back to page 0 again — same result as the first visit.
        let again = store.list_backlog("p", &query(0)).unwrap();
        let nums_again: Vec<u64> = again.items.iter().map(|i| i.number).collect();
        assert_eq!(nums_again, vec![5, 4]);

        // Filter by status.
        let mut q = query(0);
        q.status = Some("done".into());
        let done = store.list_backlog("p", &q).unwrap();
        assert_eq!(done.total, 1);
        assert_eq!(done.items[0].number, 2);

        // Search.
        let mut q = query(0);
        q.search = "issue 3".into();
        let found = store.list_backlog("p", &q).unwrap();
        assert_eq!(found.total, 1);
        assert_eq!(found.items[0].number, 3);
    }
}
