//! Table definitions and the additive `ALTER TABLE` migrations that carry
//! existing installs forward.
//!
//! Every migration here runs on every open and its error is deliberately
//! ignored: on a database that already has the column, `ALTER TABLE ... ADD
//! COLUMN` fails, and that failure is the expected steady state. Only ever add
//! columns — a rename or a drop would make a previous build unable to read a
//! store it shares with this one.

use anyhow::Result;
use rusqlite::Connection;

pub(super) fn init(conn: &Connection) -> Result<()> {
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
        CREATE TABLE IF NOT EXISTS automations (
            id             TEXT PRIMARY KEY,
            project        TEXT NOT NULL,
            name           TEXT NOT NULL,
            prompt         TEXT NOT NULL,
            agent          TEXT NOT NULL,
            model          TEXT,
            config_overrides TEXT NOT NULL DEFAULT '{}',
            trigger        TEXT NOT NULL,
            timezone       TEXT NOT NULL DEFAULT '',
            precheck       TEXT,
            enabled        INTEGER NOT NULL DEFAULT 1,
            missed_run_grace_minutes INTEGER NOT NULL DEFAULT 720,
            reuse_session  INTEGER NOT NULL DEFAULT 0,
            worktree       INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL,
            next_run_at    INTEGER,
            last_run_at    INTEGER,
            last_status    TEXT,
            last_task_id   TEXT
        );
        CREATE INDEX IF NOT EXISTS automations_project_idx ON automations(project);
        CREATE TABLE IF NOT EXISTS automation_runs (
            id             TEXT PRIMARY KEY,
            automation_id  TEXT NOT NULL,
            run_number     INTEGER NOT NULL,
            trigger        TEXT NOT NULL,
            status         TEXT NOT NULL,
            scheduled_for  INTEGER NOT NULL,
            started_at     INTEGER NOT NULL,
            finished_at    INTEGER,
            task_id        TEXT,
            error          TEXT,
            output         TEXT
        );
        CREATE INDEX IF NOT EXISTS automation_runs_automation_idx
            ON automation_runs(automation_id, run_number);
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
    let _ = conn.execute(
        "ALTER TABLE session_updates ADD COLUMN created_at INTEGER",
        [],
    );
    Ok(())
}
