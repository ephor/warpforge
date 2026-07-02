//! The warpforge daemon: the source of truth for all runtime state, driven by
//! commands and emitting events. See [`actor`] for the boundary rationale.
//!
//! Parts of this API surface are not yet called: the TUI still runs on the
//! managers in-process (its cutover to consume the daemon is the next
//! increment), and the WebSocket server that will drive most commands lands in
//! Stage 2. The allow below keeps the build clean until then; remove it once
//! the TUI and socket consume the actor.
#![allow(dead_code)]

pub mod actor;
pub mod task;

#[allow(unused_imports)]
pub use actor::{Command, Daemon, DaemonHandle, Event};
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
        let daemon = Daemon::spawn(test_projects());
        let mut events = daemon.subscribe();

        let id = daemon
            .create_task("demo", "fix the bug", "claude", vec!["bug".into()])
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
    async fn cancel_task_marks_done() {
        let daemon = Daemon::spawn(test_projects());
        let id = daemon.create_task("demo", "p", "claude", vec![]).await;
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
}
