//! The warpforge daemon: the source of truth for all runtime state, driven by
//! commands and emitting events. See [`actor`] for the boundary rationale.
//!
//! Parts of this API surface are not yet called: the TUI still runs on the
//! managers in-process (its cutover to consume the daemon is the next
//! increment), and the WebSocket server that will drive most commands lands in
//! Stage 2. The allow below keeps the build clean until then; remove it once
//! the TUI and socket consume the actor.
#![allow(dead_code)]

pub mod acp;
pub mod acp_server;
pub mod actor;
pub mod agents;
pub mod diff;
pub mod prompt;
pub mod server;
pub mod sessions;
pub mod store;
pub mod task;
pub mod wire;
pub mod worktree;

#[allow(unused_imports)]
pub use actor::{Command, Daemon, DaemonHandle, Event};
#[allow(unused_imports)]
pub use store::Store;
#[allow(unused_imports)]
pub use task::{Task, TaskStatus};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::ProjectEntry;
    use std::time::Duration;
    use tokio::time::timeout;

    fn test_projects() -> Vec<ProjectEntry> {
        vec![ProjectEntry {
            name: "demo".to_string(),
            path: ".".to_string(),
            added_at: "0".to_string(),
        }]
    }

    #[tokio::test]
    async fn create_task_generates_distinct_id_and_no_session() {
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(test_projects(), store);
        let mut events = daemon.subscribe();

        let id = daemon
            .create_task(
                "demo",
                "fix the bug",
                "claude",
                vec!["bug".into()],
                false,
                false,
                None,
                vec![],
            )
            .await;

        assert!(id.starts_with("t_"), "task id looks like a task id: {id}");

        // The TaskCreated event carries a task whose session_id is None and
        // whose session identifier is NOT the task id — they are separate.
        let ev = timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("event within 1s")
            .expect("event");
        match ev {
            Event::TaskCreated(task) => {
                assert_eq!(task.id, id);
                assert_eq!(task.session_id, None);
                assert_eq!(task.status, TaskStatus::Queued);
                assert_eq!(task.prompt, "fix the bug");
            }
            _ => panic!("expected TaskCreated"),
        }

        let tasks = daemon.tasks().await;
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, id);
    }

    #[tokio::test]
    async fn session_id_stays_separate_from_task_id_when_attached() {
        // A task can attach a session without the two ids ever being unified —
        // this is what keeps multi-agent-per-task additive later.
        let mut task = Task::new("demo", "p", "claude", vec![]);
        let task_id = task.id.clone();
        task.attach_session("sess-xyz".to_string());
        assert_eq!(task.id, task_id);
        assert_eq!(task.session_id.as_deref(), Some("sess-xyz"));
        assert_ne!(task.session_id.as_deref(), Some(task_id.as_str()));
        assert_eq!(task.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn acp_session_streams_updates_and_permission_roundtrip() {
        use warpforge_protocol as wire;

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(test_projects(), store);
        let mut events = daemon.subscribe();

        // Agent is a raw command (not a template): our mock ACP agent.
        let mock = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mock-acp-agent.mjs"
        );
        let agent = format!("node {mock}");
        let task_id = daemon
            .create_task(
                "demo",
                "fix the thing",
                &agent,
                vec![],
                false,
                false,
                None,
                vec![],
            )
            .await;

        let mut saw_running = false;
        let mut saw_agent_text = false;
        let mut saw_file_edit = false;
        let mut permission_request_id: Option<String> = None;
        let mut saw_turn_ended = false;
        let mut saw_needs_review = false;
        let mut answered = false;

        // Drive the event stream to completion of one turn.
        for _ in 0..60 {
            let ev = match timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Ok(ev)) => ev,
                _ => break,
            };
            match ev {
                Event::TaskUpdated(t) if t.id == task_id => {
                    if t.status == TaskStatus::Running {
                        saw_running = true;
                    }
                    if t.status == TaskStatus::NeedsReview {
                        saw_needs_review = true;
                    }
                }
                Event::SessionUpdate {
                    task_id: tid,
                    update,
                } if tid == task_id => match update {
                    wire::SessionUpdate::AgentText { .. } => saw_agent_text = true,
                    wire::SessionUpdate::FileEdit { path } => {
                        assert_eq!(path, "src/main.rs");
                        saw_file_edit = true;
                    }
                    wire::SessionUpdate::PermissionRequest {
                        request_id,
                        options,
                        ..
                    } => {
                        assert!(options.contains(&"allow".to_string()));
                        permission_request_id = Some(request_id);
                    }
                    wire::SessionUpdate::TurnEnded { .. } => saw_turn_ended = true,
                    _ => {}
                },
                _ => {}
            }

            // Once the agent asks, answer "allow" so it can finish the turn.
            if !answered {
                if let Some(rid) = permission_request_id.clone() {
                    daemon.session_permission(&task_id, &rid, "allow").await;
                    answered = true;
                }
            }

            if saw_turn_ended && saw_needs_review {
                break;
            }
        }

        assert!(
            saw_running,
            "task should go Running when the session starts"
        );
        assert!(saw_agent_text, "should stream agent text");
        assert!(saw_file_edit, "should report the file edit");
        assert!(
            permission_request_id.is_some(),
            "should surface a permission request"
        );
        assert!(answered, "should have answered the permission");
        assert!(
            saw_turn_ended,
            "turn should end after the permission is answered"
        );
        assert!(
            saw_needs_review,
            "task should land in NeedsReview after the turn"
        );
    }

    #[tokio::test]
    async fn no_edit_turn_lands_in_idle_not_needs_review() {
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(test_projects(), store);
        let mut events = daemon.subscribe();

        let mock = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mock-acp-agent-noedit.mjs"
        );
        let agent = format!("node {mock}");
        let task_id = daemon
            .create_task(
                "demo",
                "what port is the api on?",
                &agent,
                vec![],
                false,
                false,
                None,
                vec![],
            )
            .await;

        let mut saw_running = false;
        let mut final_status: Option<TaskStatus> = None;
        for _ in 0..60 {
            let ev = match timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Ok(ev)) => ev,
                _ => break,
            };
            if let Event::TaskUpdated(t) = ev {
                if t.id == task_id {
                    if t.status == TaskStatus::Running {
                        saw_running = true;
                    }
                    // The turn settles into a non-running, non-queued status.
                    if matches!(
                        t.status,
                        TaskStatus::Idle | TaskStatus::NeedsReview | TaskStatus::Blocked
                    ) {
                        final_status = Some(t.status.clone());
                        break;
                    }
                }
            }
        }

        assert!(saw_running, "task should go Running during the turn");
        assert_eq!(
            final_status,
            Some(TaskStatus::Idle),
            "a turn with no file edits should park in Idle, not NeedsReview"
        );
    }

    #[tokio::test]
    async fn cancel_task_marks_done() {
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(test_projects(), store);
        let id = daemon
            .create_task("demo", "p", "claude", vec![], false, false, None, vec![])
            .await;
        let mut events = daemon.subscribe();

        daemon.send(Command::CancelTask { id: id.clone() }).await;

        let ev = timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("event")
            .expect("event");
        match ev {
            Event::TaskUpdated(task) => {
                assert_eq!(task.id, id);
                assert_eq!(task.status, TaskStatus::Done);
            }
            _ => panic!("expected TaskUpdated"),
        }
    }

    #[tokio::test]
    async fn acp_prompt_blocks_follow_capabilities_and_support_followups() {
        use warpforge_protocol::PromptAttachment;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.txt"), "attached text").unwrap();
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: dir.path().to_string_lossy().into(),
            added_at: "0".into(),
        }];
        let daemon = Daemon::spawn(
            projects,
            Store::open_at(std::path::Path::new(":memory:")).ok(),
        );
        let mut events = daemon.subscribe();
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mock-acp-inspect.mjs"
        );
        let task_id = daemon
            .create_task(
                "demo",
                "inspect",
                &format!("node {fixture} true true"),
                vec![],
                false,
                false,
                None,
                vec![
                    PromptAttachment::File {
                        path: "note.txt".into(),
                    },
                    PromptAttachment::Image {
                        name: "tiny.png".into(),
                        mime_type: "image/png".into(),
                        data: "iVBORw0KGgpyZXN0".into(),
                    },
                ],
            )
            .await;
        let mut initial = false;
        for _ in 0..20 {
            if let Ok(Ok(Event::SessionUpdate {
                task_id: id,
                update: warpforge_protocol::SessionUpdate::AgentText { text },
            })) = timeout(Duration::from_secs(2), events.recv()).await
            {
                if id == task_id && text == "blocks:text,resource,image" {
                    initial = true;
                    break;
                }
            }
        }
        assert!(
            initial,
            "initial prompt should use resource and image blocks"
        );
        daemon
            .session_prompt(
                &task_id,
                "follow up",
                vec![PromptAttachment::File {
                    path: "note.txt".into(),
                }],
            )
            .await
            .unwrap();
        let mut followup = false;
        for _ in 0..20 {
            if let Ok(Ok(Event::SessionUpdate {
                task_id: id,
                update: warpforge_protocol::SessionUpdate::AgentText { text },
            })) = timeout(Duration::from_secs(2), events.recv()).await
            {
                if id == task_id && text == "blocks:text,resource" {
                    followup = true;
                    break;
                }
            }
        }
        assert!(followup, "follow-up attachments should reach ACP");
    }

    #[tokio::test]
    async fn acp_resource_falls_back_to_text_and_unsupported_images_block() {
        use warpforge_protocol::PromptAttachment;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.txt"), "attached text").unwrap();
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: dir.path().to_string_lossy().into(),
            added_at: "0".into(),
        }];
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mock-acp-inspect.mjs"
        );

        let daemon = Daemon::spawn(
            projects.clone(),
            Store::open_at(std::path::Path::new(":memory:")).ok(),
        );
        let mut events = daemon.subscribe();
        let id = daemon
            .create_task(
                "demo",
                "inspect",
                &format!("node {fixture} true false"),
                vec![],
                false,
                false,
                None,
                vec![PromptAttachment::File {
                    path: "note.txt".into(),
                }],
            )
            .await;
        let mut fallback = false;
        for _ in 0..20 {
            if let Ok(Ok(Event::SessionUpdate {
                task_id,
                update: warpforge_protocol::SessionUpdate::AgentText { text },
            })) = timeout(Duration::from_secs(2), events.recv()).await
            {
                if task_id == id && text == "blocks:text,text" {
                    fallback = true;
                    break;
                }
            }
        }
        assert!(fallback, "resource should fall back to delimited text");

        let daemon = Daemon::spawn(
            projects,
            Store::open_at(std::path::Path::new(":memory:")).ok(),
        );
        let mut events = daemon.subscribe();
        let id = daemon
            .create_task(
                "demo",
                "inspect",
                &format!("node {fixture} false true"),
                vec![],
                false,
                false,
                None,
                vec![PromptAttachment::Image {
                    name: "tiny.png".into(),
                    mime_type: "image/png".into(),
                    data: "iVBORw0KGgpyZXN0".into(),
                }],
            )
            .await;
        let mut blocked = false;
        for _ in 0..20 {
            if let Ok(Ok(Event::TaskUpdated(task))) =
                timeout(Duration::from_secs(2), events.recv()).await
            {
                if task.id == id && task.status == TaskStatus::Blocked {
                    blocked = true;
                    break;
                }
            }
        }
        assert!(blocked, "unsupported images must be rejected by the daemon");
        assert!(daemon
            .session_prompt("missing", "not delivered", vec![])
            .await
            .is_err());
    }
}
