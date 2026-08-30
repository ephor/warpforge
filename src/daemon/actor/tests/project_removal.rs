use crate::daemon::actor::event::*;
use crate::daemon::actor::*;
use crate::registry::ProjectEntry;

fn demo_project() -> ProjectEntry {
    ProjectEntry {
        name: "project-removal-test".into(),
        path: ".".into(),
        added_at: "0".into(),
    }
}

#[test]
fn resource_guard_message_is_actionable_and_reports_live_counts() {
    let live = ProjectLiveResources {
        services: 2,
        portforwards: 1,
        terminals: 3,
    };

    assert!(live.any());
    assert_eq!(
            live.conflict_message("demo"),
            "Project \"demo\" has 2 live services, 1 live port-forward, 3 live terminals; retry project.remove with stop_resources=true to stop them and remove the registration"
        );
}

#[test]
fn stopped_project_state_does_not_require_force() {
    assert!(!ProjectLiveResources::default().any());
}

#[tokio::test]
async fn live_terminal_blocks_unforced_project_removal() {
    let handle = Daemon::spawn(vec![demo_project()], None);
    let terminal_id = handle
        .spawn_agent("project-removal-test", "sleep 30", "guard test", 80, 24)
        .await
        .unwrap();

    let error = handle
        .remove_project("project-removal-test", false)
        .await
        .unwrap_err();

    assert!(matches!(error, ProjectRemovalError::Conflict(_)));
    assert!(handle
        .snapshot()
        .await
        .terminals
        .iter()
        .any(|terminal| terminal.id == terminal_id));
    handle.shutdown().await;
}

#[tokio::test]
async fn task_archive_and_delete_do_not_kill_project_terminal() {
    let handle = Daemon::spawn(vec![demo_project()], None);
    let terminal_id = handle
        .spawn_agent(
            "project-removal-test",
            "sleep 30",
            "task lifecycle test",
            80,
            24,
        )
        .await
        .unwrap();
    let archived_task = handle
        .create_task(
            "project-removal-test",
            "archive me",
            "codex",
            Vec::new(),
            false,
            false,
            None,
            Vec::new(),
            None,
            HashMap::new(),
            None,
        )
        .await;
    let deleted_task = handle
        .create_task(
            "project-removal-test",
            "delete me",
            "codex",
            Vec::new(),
            false,
            false,
            None,
            Vec::new(),
            None,
            HashMap::new(),
            None,
        )
        .await;

    handle
        .send(Command::ArchiveTask { id: archived_task })
        .await;
    handle
        .delete_task(&deleted_task)
        .await
        .expect("task deletion should complete");

    assert!(handle
        .snapshot()
        .await
        .terminals
        .iter()
        .any(|terminal| terminal.id == terminal_id));
    handle.shutdown().await;
}
