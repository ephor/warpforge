//! Store round-trip and schema-migration tests.

use rusqlite::Connection;

use warpforge_protocol as wire;

use super::snapshot::MAX_SESSION_SNAPSHOT_UPDATES;
use super::{Store, StoredAccount};
use crate::daemon::task::{Task, TaskStatus};

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
