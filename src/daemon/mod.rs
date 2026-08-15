//! The warpforge daemon: the source of truth for all runtime state, driven by
//! commands and emitting events. See [`actor`] for the boundary rationale.
//!
//! Parts of this API surface are not yet called: the TUI still runs on the
//! managers in-process (its cutover to consume the daemon is the next
//! increment), and the WebSocket server that will drive most commands lands in
//! Stage 2. The allow below keeps the build clean until then; remove it once
//! the TUI and socket consume the actor.
#![allow(dead_code)]

pub mod accounts;
pub mod acp;
pub mod acp_server;
pub mod actor;
pub mod agent_probe;
pub mod agents;
pub mod claude_auth;
pub mod diff;
pub mod lsp;
pub mod lsp_servers;
pub mod prompt;
pub mod runtime;
pub mod server;
pub mod sessions;
pub mod store;
pub mod task;
pub mod wire;
pub mod workflow;
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
                None,
                std::collections::HashMap::new(),
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
    async fn successful_update_safety_check_stops_commands_queued_behind_it() {
        let daemon = Daemon::spawn(Vec::new(), None);
        let (safety_tx, safety_rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::UpdateSafety { reply: safety_tx })
            .await;

        let (task_tx, task_rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::CreateTask {
                project: "demo".into(),
                prompt: "must not start".into(),
                agent: "claude".into(),
                tags: Vec::new(),
                include_runtime_context: false,
                worktree: false,
                parent_task_id: None,
                attachments: Vec::new(),
                default_model: None,
                config_overrides: std::collections::HashMap::new(),
                reply: task_tx,
            })
            .await;

        assert!(safety_rx.await.unwrap().is_empty());
        assert!(
            task_rx.await.is_err(),
            "the actor must drop mutations queued after an accepted handoff"
        );
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
                None,
                std::collections::HashMap::new(),
            )
            .await;

        let mut saw_running = false;
        let mut saw_agent_text = false;
        let mut saw_file_edit = false;
        let mut saw_detailed_file_edit = false;
        let mut permission_request_id: Option<String> = None;
        let mut saw_turn_ended = false;
        let mut saw_waiting = false;
        let mut waiting_files_changed = 0u32;
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
                    if t.status == TaskStatus::Waiting {
                        saw_waiting = true;
                        waiting_files_changed = t.files_changed;
                    }
                }
                Event::SessionUpdate {
                    task_id: tid,
                    update,
                } if tid == task_id => match update {
                    wire::SessionUpdate::AgentText { .. } => saw_agent_text = true,
                    wire::SessionUpdate::FileEdit { path, hunks, .. } => {
                        assert_eq!(path, "src/main.rs");
                        saw_file_edit = true;
                        saw_detailed_file_edit |= !hunks.is_empty();
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

            if saw_turn_ended && saw_waiting {
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
            saw_detailed_file_edit,
            "should preserve ACP diff hunks in the session stream"
        );
        assert!(
            permission_request_id.is_some(),
            "should surface a permission request"
        );
        assert!(answered, "should have answered the permission");
        assert!(
            saw_turn_ended,
            "turn should end after the permission is answered"
        );
        assert!(saw_waiting, "task should land in Waiting after the turn");
        // "There is something to review" is a fact about the diff, not a
        // separate lifecycle state — this turn edited a file, so it shows up
        // here rather than as a distinct status.
        assert!(
            waiting_files_changed > 0,
            "an editing turn should park in Waiting with changes recorded"
        );
    }

    #[tokio::test]
    async fn no_edit_turn_lands_in_waiting_with_no_changes() {
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
                None,
                std::collections::HashMap::new(),
            )
            .await;

        let mut saw_running = false;
        let mut final_status: Option<TaskStatus> = None;
        let mut final_files_changed = 0u32;
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
                    if matches!(t.status, TaskStatus::Waiting | TaskStatus::Blocked) {
                        final_files_changed = t.files_changed;
                        final_status = Some(t.status.clone());
                        break;
                    }
                }
            }
        }

        assert!(saw_running, "task should go Running during the turn");
        assert_eq!(
            final_status,
            Some(TaskStatus::Waiting),
            "a finished turn parks in Waiting whether or not it edited anything"
        );
        assert_eq!(
            final_files_changed, 0,
            "a pure Q&A turn has nothing to review, and that is a field, not a status"
        );
    }

    #[tokio::test]
    async fn cancel_task_marks_waiting() {
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(test_projects(), store);
        let id = daemon
            .create_task(
                "demo",
                "p",
                "claude",
                vec![],
                false,
                false,
                None,
                vec![],
                None,
                std::collections::HashMap::new(),
            )
            .await;
        let mut events = daemon.subscribe();

        daemon.cancel_task(&id).await.expect("cancel accepted");

        timeout(Duration::from_secs(1), async {
            loop {
                match events.recv().await.expect("event") {
                    Event::TaskUpdated(task)
                        if task.id == id && task.status == TaskStatus::Waiting =>
                    {
                        break;
                    }
                    _ => continue,
                }
            }
        })
        .await
        .expect("TaskUpdated with Idle status");
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
                        range: None,
                    },
                    PromptAttachment::Image {
                        name: "tiny.png".into(),
                        mime_type: "image/png".into(),
                        data: "iVBORw0KGgpyZXN0".into(),
                    },
                ],
                None,
                std::collections::HashMap::new(),
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
                    range: None,
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
                    range: None,
                }],
                None,
                std::collections::HashMap::new(),
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
                None,
                std::collections::HashMap::new(),
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

    /// Regression: child command-not-found exits before initialize. The task
    /// must go Blocked with an actionable error (not hang in Queued).
    #[tokio::test]
    async fn child_command_not_found_surfaces_error() {
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(test_projects(), store);
        let mut events = daemon.subscribe();

        let task_id = daemon
            .create_task(
                "demo",
                "fix the bug",
                "nonexistent-acp-agent-test-xyz-$$",
                vec![],
                false,
                false,
                None,
                vec![],
                None,
                std::collections::HashMap::new(),
            )
            .await;

        let blocked_reason = timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(Event::TaskUpdated(task)) = events.recv().await {
                    if task.id == task_id && task.status == TaskStatus::Blocked {
                        break task.blocked_reason.unwrap_or_default();
                    }
                }
            }
        })
        .await
        .expect("command-not-found should block promptly");
        assert!(blocked_reason.contains("nonexistent-acp-agent-test-xyz-$$"));
        assert!(blocked_reason.contains("127"), "{blocked_reason}");
        assert!(blocked_reason.to_ascii_lowercase().contains("not found"));
        assert!(!blocked_reason.contains('\x1b'));

        let mut duplicate_failures = 0;
        while let Ok(Ok(event)) = timeout(Duration::from_millis(200), events.recv()).await {
            if matches!(event, Event::TaskUpdated(ref task) if task.id == task_id && task.status == TaskStatus::Blocked)
            {
                duplicate_failures += 1;
            }
        }
        assert_eq!(
            duplicate_failures, 0,
            "failure must be notified exactly once"
        );
    }

    // ── Workflow pipeline engine ──

    const WF_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mock-acp-workflow.mjs"
    );

    /// A tempdir project with one workflow file at
    /// `.warpforge/workflows/test.yaml` and a registered `demo` project entry.
    fn workflow_project(yaml: &str) -> (tempfile::TempDir, Vec<ProjectEntry>) {
        let dir = tempfile::tempdir().unwrap();
        let wf_dir = dir.path().join(".warpforge/workflows");
        std::fs::create_dir_all(&wf_dir).unwrap();
        std::fs::write(wf_dir.join("test.yaml"), yaml).unwrap();
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: dir.path().to_string_lossy().into_owned(),
            added_at: "0".into(),
        }];
        (dir, projects)
    }

    /// Scripted mock-agent command sharing `state` across stage processes.
    fn wf_agent(dir: &tempfile::TempDir, state: &str, script: &str) -> String {
        format!(
            "node {WF_FIXTURE} {} {script}",
            dir.path().join(state).display()
        )
    }

    async fn create_workflow_task(daemon: &DaemonHandle, agent: &str) -> String {
        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::CreateWorkflowTask {
                project: "demo".into(),
                prompt: "do the thing".into(),
                agent: agent.into(),
                tags: vec![],
                worktree: false,
                workflow: "test".into(),
                attachments: vec![],
                default_model: None,
                include_runtime_context: false,
                config_overrides: std::collections::HashMap::new(),
                parent_task_id: None,
                reply: tx,
            })
            .await;
        rx.await.unwrap().expect("workflow task created")
    }

    /// Drive the event stream until the parent task satisfies `pred`.
    async fn wait_for_parent(
        events: &mut tokio::sync::broadcast::Receiver<Event>,
        parent_id: &str,
        what: &str,
        pred: impl Fn(&Task) -> bool,
    ) -> Task {
        timeout(Duration::from_secs(20), async {
            loop {
                if let Ok(Event::TaskUpdated(task)) = events.recv().await {
                    if task.id == parent_id && pred(&task) {
                        break task;
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for: {what}"))
    }

    #[tokio::test]
    async fn workflow_full_loop_reject_fix_approve() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        // Round 1 rejects with one high finding, round 2 approves.
        let reviewer = wf_agent(&dir, "rev.state", "reject approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!(
                "name: Test flow\nreview:\n  max_rounds: 2\n  reviewers:\n    - agent: {reviewer}\n"
            ),
        )
        .unwrap();
        let lead = wf_agent(&dir, "impl.state", "impl fix");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;

        assert_eq!(done.status, TaskStatus::Waiting);
        let run = done.workflow_run.unwrap();
        assert_eq!(run.round, 2, "reject → fix → approve takes two rounds");
        assert_eq!(run.verdict, Some(wire::WorkflowVerdict::Approve));
        assert!(run.waiting.is_none());
        // Graph: implement, review r1, fix, review r2 — all with task ids.
        let graph = done.orchestration_graph.unwrap();
        assert_eq!(graph.nodes.len(), 4, "{:?}", graph.nodes);
        assert!(graph.nodes.iter().all(|n| n.task_id.is_some()));
        assert_eq!(graph.nodes[0].kind, wire::OrchNodeKind::Implement);
        assert_eq!(graph.nodes[2].kind, wire::OrchNodeKind::Fix);
        // Default reask mode: round 2 follows up in the SAME reviewer session,
        // so both review nodes point at one task.
        assert_eq!(graph.nodes[1].kind, wire::OrchNodeKind::Review);
        assert_eq!(graph.nodes[3].kind, wire::OrchNodeKind::Review);
        assert_eq!(
            graph.nodes[1].task_id, graph.nodes[3].task_id,
            "same_session re-review must continue the round-1 reviewer session"
        );

        // The parent conversation is a useful workflow narrative, not just a
        // sequence of opaque/coalesced stage transitions. Agent cards and
        // results remain independent, ordered history entries.
        let snapshot = daemon.snapshot().await;
        let workflow_events: Vec<_> = snapshot.session_history[&parent_id]
            .iter()
            .filter(|update| matches!(update, wire::SessionUpdate::WorkflowEvent { .. }))
            .collect();
        assert!(matches!(
            workflow_events.first(),
            Some(wire::SessionUpdate::WorkflowEvent {
                event: wire::WorkflowEventKind::WorkflowStarted,
                ..
            })
        ));
        let implement_started = workflow_events
            .iter()
            .position(|update| {
                matches!(
                    update,
                    wire::SessionUpdate::WorkflowEvent {
                        event: wire::WorkflowEventKind::StageStarted,
                        stage: Some(wire::WorkflowStage::Implement),
                        agents,
                        ..
                    } if agents.len() == 1
                )
            })
            .unwrap();
        let implement_summary = workflow_events
            .iter()
            .position(|update| {
                matches!(
                    update,
                    wire::SessionUpdate::WorkflowEvent {
                        event: wire::WorkflowEventKind::AgentOutput,
                        detail: Some(detail),
                        ..
                    } if detail.contains("IMPL-DONE: implemented the change.")
                )
            })
            .unwrap();
        let first_review = workflow_events
            .iter()
            .position(|update| {
                matches!(
                    update,
                    wire::SessionUpdate::WorkflowEvent {
                        event: wire::WorkflowEventKind::StageStarted,
                        stage: Some(wire::WorkflowStage::Review),
                        ..
                    }
                )
            })
            .unwrap();
        // The finding reaches the timeline through the round's merged-verdict
        // entry. The reviewer's own card shows its prose, NOT the raw protocol
        // JSON it was asked to emit — that is stripped for display.
        let finding = workflow_events
            .iter()
            .position(|update| {
                matches!(
                    update,
                    wire::SessionUpdate::WorkflowEvent { detail: Some(detail), .. }
                        if detail.contains("bug here")
                )
            })
            .expect("the merged verdict lists the finding");
        assert!(
            workflow_events.iter().all(|update| !matches!(
                update,
                wire::SessionUpdate::WorkflowEvent { detail: Some(detail), .. }
                    if detail.contains("\"verdict\"")
            )),
            "the machine protocol block must not leak into the parent's timeline"
        );
        let fix_summary = workflow_events
            .iter()
            .position(|update| {
                matches!(
                    update,
                    wire::SessionUpdate::WorkflowEvent {
                        event: wire::WorkflowEventKind::AgentOutput,
                        detail: Some(detail),
                        ..
                    } if detail.contains("FIX-DONE: addressed the findings.")
                )
            })
            .unwrap();
        assert!(implement_started < implement_summary);
        assert!(implement_summary < first_review);
        assert!(first_review < finding);
        assert!(finding < fix_summary);
        assert!(workflow_events.iter().any(|update| matches!(
            update,
            wire::SessionUpdate::WorkflowEvent {
                event: wire::WorkflowEventKind::ReviewResult,
                title,
                ..
            } if title.contains("approved")
        )));
        assert!(
            snapshot
                .tasks
                .iter()
                .filter(|task| task.parent_task_id.as_deref() == Some(&parent_id))
                .all(|task| task.status == wire::TaskStatus::Done),
            "consumed workflow stages should be terminal, not idle/needs-review"
        );
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .filter(|task| task.parent_task_id.as_deref() == Some(&parent_id))
                .count(),
            3,
            "implement, one reused reviewer session, fix"
        );
        // Finalize must sweep every stage session — completed ones included —
        // so no mock agent processes outlive the pipeline.
        assert_no_stage_processes(&dir).await;
    }

    /// Poll until no mock agent process whose command line references this
    /// test's tempdir remains alive. Stage sessions are kept alive during a
    /// run (same-session re-review follows up in them) and must all be killed
    /// at finalize.
    async fn assert_no_stage_processes(dir: &tempfile::TempDir) {
        let needle = dir.path().to_string_lossy().into_owned();
        for _ in 0..50 {
            let alive = std::process::Command::new("pgrep")
                .args(["-f", &needle])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false);
            if !alive {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("stage agent processes still alive after the pipeline finished");
    }

    /// Reviewers must receive the implementer's closing message, not the
    /// whole turn's tool narration.
    #[tokio::test]
    async fn workflow_carries_the_closing_message_not_the_narration() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!("name: Closing flow\nreview:\n  reviewers:\n    - agent: {reviewer}\n"),
        )
        .unwrap();
        let lead = wf_agent(&dir, "impl.state", "noisy-impl");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;

        // The reviewer child's prompt is its task prompt.
        let snapshot = daemon.snapshot().await;
        let reviewer_prompt = snapshot
            .tasks
            .iter()
            .find(|t| {
                t.parent_task_id.as_deref() == Some(&parent_id) && t.title.starts_with("review")
            })
            .map(|t| t.prompt.clone())
            .expect("a reviewer stage ran");
        assert!(
            reviewer_prompt.contains("CLOSING: implemented the change"),
            "the reviewer must see the closing message"
        );
        assert!(
            !reviewer_prompt.contains("NARRATION:"),
            "tool narration must not be passed off as the implementer's summary"
        );

        // The parent's timeline shows the same closing text as the stage result.
        let events: Vec<_> = snapshot.session_history[&parent_id]
            .iter()
            .filter_map(|update| match update {
                wire::SessionUpdate::WorkflowEvent { detail, .. } => detail.clone(),
                _ => None,
            })
            .collect();
        assert!(
            events.iter().any(|detail| detail.contains("CLOSING:")),
            "{events:?}"
        );
        assert!(
            events.iter().all(|detail| !detail.contains("NARRATION:")),
            "{events:?}"
        );
    }

    /// A workflow spawned with a `parent_task_id` (the `spawn_workflow` MCP
    /// tool's path) reports its finish to that parent's inbox exactly like a
    /// plain `spawn_agent` sub-agent — this is what `read_inbox` surfaces back
    /// to an orchestrator session.
    #[tokio::test]
    async fn workflow_spawned_with_a_parent_reports_to_its_inbox() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!("name: Closing flow\nreview:\n  reviewers:\n    - agent: {reviewer}\n"),
        )
        .unwrap();
        let lead = wf_agent(&dir, "impl.state", "noisy-impl");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();

        // Stand in for an orchestrator-chat task: only its id and inbox matter
        // here, so a session that fails to start is fine.
        let orch_id = daemon
            .create_task(
                "demo",
                "orchestrate",
                "no-such-agent",
                vec!["orchestrator-chat".into()],
                false,
                false,
                None,
                vec![],
                None,
                std::collections::HashMap::new(),
            )
            .await;

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::CreateWorkflowTask {
                project: "demo".into(),
                prompt: "do the thing".into(),
                agent: lead,
                tags: vec![],
                worktree: false,
                workflow: "test".into(),
                attachments: vec![],
                default_model: None,
                include_runtime_context: false,
                config_overrides: std::collections::HashMap::new(),
                parent_task_id: Some(orch_id.clone()),
                reply: tx,
            })
            .await;
        let parent_id = rx.await.unwrap().expect("workflow task created");

        wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;

        let inbox = daemon.read_inbox(&orch_id).await;
        assert_eq!(
            inbox.len(),
            1,
            "the finished pipeline should be in the inbox"
        );
        let result = &inbox[0];
        assert_eq!(result.child_id, parent_id);
        assert!(result.success);
        assert!(
            result.output.contains("Workflow **Closing flow** finished"),
            "{}",
            result.output
        );

        // Draining is one-shot, same as for a plain sub-agent.
        assert!(daemon.read_inbox(&orch_id).await.is_empty());
    }

    /// Archiving an orchestrator must stop a still-running workflow pipeline
    /// spawned under it, not just flip its status to Done. Before this was
    /// fixed, the direct-child cascade in `ArchiveTask` bypassed
    /// `workflow_finalize`, leaving the pipeline's `workflow_runs` entry and
    /// its stage session alive — the "archived" task would later flip back
    /// out of Done when that stage's turn ended.
    #[tokio::test]
    async fn archiving_the_orchestrator_stops_a_running_child_workflow() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!("name: Q flow\nplan: {{}}\nreview:\n  reviewers:\n    - agent: {reviewer}\n"),
        )
        .unwrap();
        // The plan stage asks a question and stalls there, mid-pipeline, with
        // a live (Idle) agent session — exactly the state that must not be
        // left running behind an "archived" task.
        let lead = wf_agent(&dir, "lead.state", "question plan impl");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();

        let orch_id = daemon
            .create_task(
                "demo",
                "orchestrate",
                "no-such-agent",
                vec!["orchestrator-chat".into()],
                false,
                false,
                None,
                vec![],
                None,
                std::collections::HashMap::new(),
            )
            .await;

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::CreateWorkflowTask {
                project: "demo".into(),
                prompt: "do the thing".into(),
                agent: lead,
                tags: vec![],
                worktree: false,
                workflow: "test".into(),
                attachments: vec![],
                default_model: None,
                include_runtime_context: false,
                config_overrides: std::collections::HashMap::new(),
                parent_task_id: Some(orch_id.clone()),
                reply: tx,
            })
            .await;
        let parent_id = rx.await.unwrap().expect("workflow task created");

        wait_for_parent(&mut events, &parent_id, "question", |t| {
            t.workflow_run
                .as_ref()
                .and_then(|w| w.waiting.as_ref())
                .is_some_and(|w| w.kind == wire::WorkflowWaitKind::Question)
        })
        .await;

        daemon
            .send(Command::ArchiveTask {
                id: orch_id.clone(),
            })
            .await;

        // Answering the stalled question must now fail: the pipeline was
        // stopped by the archive, not left waiting. `ArchiveTask` has no
        // reply, but the actor processes commands in order, so this
        // reply-awaiting command only completes once the archive has too.
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowReply {
                task: parent_id.clone(),
                message: "Postgres".into(),
                reply: reply_tx,
            })
            .await;
        assert!(
            reply_rx.await.unwrap().is_err(),
            "an archived pipeline must not still accept an answer"
        );

        let workflow_task = daemon
            .tasks()
            .await
            .into_iter()
            .find(|t| t.id == parent_id)
            .expect("workflow parent still exists");
        assert_eq!(workflow_task.status, TaskStatus::Done);
    }

    #[tokio::test]
    async fn workflow_fresh_reask_spawns_new_reviewers() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "reject approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!(
                "name: Fresh flow\nreview:\n  max_rounds: 2\n  reask: fresh\n  reviewers:\n    - agent: {reviewer}\n"
            ),
        )
        .unwrap();
        let lead = wf_agent(&dir, "impl.state", "impl fix");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;
        assert_eq!(done.status, TaskStatus::Waiting);
        let graph = done.orchestration_graph.unwrap();
        assert_eq!(graph.nodes.len(), 4, "{:?}", graph.nodes);
        assert_ne!(
            graph.nodes[1].task_id, graph.nodes[3].task_id,
            "reask: fresh must staff round 2 with a new reviewer session"
        );
    }

    /// With the default same_session reask, a reviewer whose session died
    /// between rounds falls back to a fresh session — whose prompt carries the
    /// previous round's findings for verification.
    #[tokio::test]
    async fn workflow_dead_reviewer_session_falls_back_to_fresh() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        // Round 1: reject, then the process exits. Round 2 (fresh fallback
        // process) pops the next behavior: approve.
        let reviewer = wf_agent(&dir, "rev.state", "reject-die approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!(
                "name: Fallback flow\nreview:\n  max_rounds: 2\n  reviewers:\n    - agent: {reviewer}\n"
            ),
        )
        .unwrap();
        // A slow fix keeps round 2 far enough away for the reviewer process
        // death (~100ms after its verdict) to be observed first.
        let lead = wf_agent(&dir, "impl.state", "impl slow-fix");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;
        assert_eq!(done.status, TaskStatus::Waiting);
        let run = done.workflow_run.unwrap();
        assert_eq!(run.verdict, Some(wire::WorkflowVerdict::Approve));
        let graph = done.orchestration_graph.unwrap();
        assert_eq!(graph.nodes.len(), 4, "{:?}", graph.nodes);
        assert_ne!(
            graph.nodes[1].task_id, graph.nodes[3].task_id,
            "a dead reviewer session must be replaced by a fresh one"
        );
    }

    #[tokio::test]
    async fn workflow_plan_question_reply_flow() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!("name: Q flow\nplan: {{}}\nreview:\n  reviewers:\n    - agent: {reviewer}\n"),
        )
        .unwrap();
        // Plan turn 1 asks, the answered turn plans, then implement runs.
        let lead = wf_agent(&dir, "lead.state", "question plan impl");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let waiting = wait_for_parent(&mut events, &parent_id, "question", |t| {
            t.workflow_run
                .as_ref()
                .and_then(|w| w.waiting.as_ref())
                .is_some_and(|w| w.kind == wire::WorkflowWaitKind::Question)
        })
        .await;
        assert_eq!(waiting.status, TaskStatus::Waiting);
        let question = waiting.workflow_run.unwrap().waiting.unwrap();
        assert_eq!(question.question.as_deref(), Some("Which database?"));
        assert_eq!(question.stage, Some(wire::WorkflowStage::Plan));
        let asking_child = daemon
            .tasks()
            .await
            .into_iter()
            .find(|task| task.parent_task_id.as_deref() == Some(&parent_id))
            .expect("asking plan stage");
        assert_eq!(asking_child.status, TaskStatus::Waiting);

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowReply {
                task: parent_id.clone(),
                message: "Postgres".into(),
                reply: tx,
            })
            .await;
        rx.await.unwrap().expect("reply accepted");

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;
        assert_eq!(done.status, TaskStatus::Waiting);
        assert_eq!(done.workflow_run.unwrap().round, 1);
    }

    #[tokio::test]
    async fn workflow_limit_asks_and_finishes_on_decision() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "reject");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!(
                "name: Limit flow\nreview:\n  max_rounds: 1\n  on_limit: ask\n  reviewers:\n    - agent: {reviewer}\n"
            ),
        )
        .unwrap();
        let lead = wf_agent(&dir, "impl.state", "impl fix");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let waiting = wait_for_parent(&mut events, &parent_id, "limit decision", |t| {
            t.workflow_run
                .as_ref()
                .and_then(|w| w.waiting.as_ref())
                .is_some_and(|w| w.kind == wire::WorkflowWaitKind::Limit)
        })
        .await;
        assert_eq!(waiting.status, TaskStatus::Waiting);
        assert!(
            daemon
                .tasks()
                .await
                .iter()
                .filter(|task| task.parent_task_id.as_deref() == Some(&parent_id))
                .all(|task| task.status == TaskStatus::Done),
            "every stage has completed when the review-limit decision is shown"
        );

        // A pause is invalid while waiting on a decision.
        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowPause {
                task: parent_id.clone(),
                reply: tx,
            })
            .await;
        assert!(rx.await.unwrap().is_err());

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowDecide {
                task: parent_id.clone(),
                decision: wire::WorkflowDecision::Finish,
                rounds: None,
                note: None,
                reply: tx,
            })
            .await;
        rx.await.unwrap().expect("decision accepted");

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;
        assert_eq!(done.status, TaskStatus::Waiting);
        assert_eq!(
            done.workflow_run.unwrap().verdict,
            Some(wire::WorkflowVerdict::RequestChanges)
        );
    }

    #[tokio::test]
    async fn workflow_pause_takes_effect_at_barrier_and_resumes() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!("name: Pause flow\nreview:\n  reviewers:\n    - agent: {reviewer}\n"),
        )
        .unwrap();
        // The implement turn takes ~600ms — enough for the pause to land.
        let lead = wf_agent(&dir, "impl.state", "slow-impl fix");

        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let daemon = Daemon::spawn(projects, store);
        let mut events = daemon.subscribe();
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowPause {
                task: parent_id.clone(),
                reply: tx,
            })
            .await;
        rx.await.unwrap().expect("pause accepted while running");

        let paused = wait_for_parent(&mut events, &parent_id, "paused at barrier", |t| {
            t.workflow_run
                .as_ref()
                .and_then(|w| w.waiting.as_ref())
                .is_some_and(|w| w.kind == wire::WorkflowWaitKind::Paused)
        })
        .await;
        assert_eq!(paused.status, TaskStatus::Waiting);

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowResume {
                task: parent_id.clone(),
                note: Some("carry on".into()),
                reply: tx,
            })
            .await;
        rx.await.unwrap().expect("resume accepted");

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;
        assert_eq!(done.status, TaskStatus::Waiting);
    }

    #[tokio::test]
    async fn workflow_parent_cancel_stops_the_active_stage_before_acknowledging() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: Cancel flow\n");
        let pid_path = dir.path().join("cancel.pid");
        let lead = format!(
            "echo $$ > {}; exec {}",
            pid_path.display(),
            wf_agent(&dir, "cancel.state", "slow-impl")
        );
        let daemon = Daemon::spawn(
            projects,
            Store::open_at(std::path::Path::new(":memory:")).ok(),
        );
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let pid = timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_path) {
                    let pid = pid.trim();
                    if pid.parse::<u32>().is_ok() {
                        break pid.to_string();
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("active stage should write its process id");

        daemon
            .cancel_task(&parent_id)
            .await
            .expect("workflow cancellation acknowledged");

        let process_alive = tokio::process::Command::new("kill")
            .args(["-0", &pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
        assert!(
            !process_alive,
            "task.cancel acknowledged before ACP process {pid} exited"
        );

        let tasks = daemon.tasks().await;
        let parent = tasks.iter().find(|task| task.id == parent_id).unwrap();
        assert_eq!(parent.status, TaskStatus::Interrupted);
        assert_eq!(
            parent.workflow_run.as_ref().map(|run| run.stage),
            Some(wire::WorkflowStage::Failed)
        );
        let child = tasks
            .iter()
            .find(|task| task.parent_task_id.as_deref() == Some(&parent_id))
            .expect("active workflow stage");
        assert_eq!(child.status, TaskStatus::Interrupted);
        assert_eq!(
            parent.orchestration_graph.as_ref().unwrap().nodes[0].status,
            wire::OrchNodeStatus::Skipped
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn task_delete_stops_the_active_process_before_removing_history() {
        let (dir, projects) = workflow_project("name: Delete flow\n");
        let pid_path = dir.path().join("delete.pid");
        let lead = format!(
            "echo $$ > {}; exec {}",
            pid_path.display(),
            wf_agent(&dir, "delete.state", "slow-impl")
        );
        let daemon = Daemon::spawn(
            projects,
            Store::open_at(std::path::Path::new(":memory:")).ok(),
        );
        let parent_id = create_workflow_task(&daemon, &lead).await;

        let pid = timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_path) {
                    let pid = pid.trim();
                    if pid.parse::<u32>().is_ok() {
                        break pid.to_string();
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("active stage should write its process id");

        daemon
            .delete_task(&parent_id)
            .await
            .expect("task deletion acknowledged");

        let process_alive = tokio::process::Command::new("kill")
            .args(["-0", &pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
        assert!(
            !process_alive,
            "task.delete acknowledged before ACP process {pid} exited"
        );
        assert!(
            daemon.tasks().await.iter().all(|task| task.id != parent_id),
            "deleted task remained in the daemon task list"
        );
    }

    /// A daemon restart mid-stage parks the pipeline at its last barrier as
    /// Paused; resume re-runs the interrupted stage and the run completes.
    #[tokio::test]
    async fn workflow_restart_converts_midstage_to_paused_and_resumes() {
        use warpforge_protocol as wire;
        let (dir, projects) = workflow_project("name: placeholder\n");
        let reviewer = wf_agent(&dir, "rev.state", "approve");
        std::fs::write(
            dir.path().join(".warpforge/workflows/test.yaml"),
            format!("name: Restart flow\nreview:\n  reviewers:\n    - agent: {reviewer}\n"),
        )
        .unwrap();
        // Attempt 1 of implement is slow and dies with the daemon; the re-run
        // after restart pops the next behavior and completes quickly.
        let lead = wf_agent(&dir, "impl.state", "slow-impl impl fix");
        let db_path = dir.path().join("warpforge.db");

        let daemon = Daemon::spawn(projects.clone(), Store::open_at(&db_path).ok());
        let parent_id = create_workflow_task(&daemon, &lead).await;
        // Shut down while the implement turn is still in flight (~600ms).
        daemon.shutdown().await;

        let daemon = Daemon::spawn(projects, Store::open_at(&db_path).ok());
        let mut events = daemon.subscribe();
        let restored = timeout(Duration::from_secs(5), async {
            loop {
                let tasks = daemon.tasks().await;
                if let Some(task) = tasks.iter().find(|t| t.id == parent_id) {
                    if task
                        .workflow_run
                        .as_ref()
                        .and_then(|w| w.waiting.as_ref())
                        .is_some_and(|w| w.kind == wire::WorkflowWaitKind::Paused)
                    {
                        break task.clone();
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("restored run should be paused at the implement barrier");
        assert_eq!(restored.status, TaskStatus::Waiting);
        assert_eq!(
            restored.workflow_run.unwrap().stage,
            wire::WorkflowStage::Implement
        );

        let (tx, rx) = tokio::sync::oneshot::channel();
        daemon
            .send(Command::WorkflowResume {
                task: parent_id.clone(),
                note: None,
                reply: tx,
            })
            .await;
        rx.await.unwrap().expect("resume accepted after restart");

        let done = wait_for_parent(&mut events, &parent_id, "pipeline done", |t| {
            t.workflow_run
                .as_ref()
                .is_some_and(|w| w.stage == wire::WorkflowStage::Done)
        })
        .await;
        assert_eq!(done.status, TaskStatus::Waiting);
    }

    /// Regression: when a stale ACP handle is in sessions and a prompt
    /// arrives, the daemon must detect the dead handle and trigger resume
    /// via the stored session_id rather than failing with "no live session".
    #[tokio::test]
    async fn stale_handle_prompt_triggers_resume() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("warpforge.db");
        let log_path = dir.path().join("acp.log");
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mock-acp-recovery.mjs"
        );
        let session_id = "persisted-session-42";
        let agent = format!("node {} {} {}", fixture, log_path.display(), session_id);
        let store = Store::open_at(&db_path).unwrap();
        let mut persisted = Task::new("demo", "original prompt", &agent, vec![]);
        persisted.attach_session(session_id.into());
        persisted.blocked_reason = Some("previous process exited".into());
        persisted.set_status(TaskStatus::Blocked);
        let task_id = persisted.id.clone();
        store.upsert_task(&persisted).unwrap();

        let daemon = Daemon::spawn(test_projects(), Some(store));
        let mut events = daemon.subscribe();
        daemon
            .session_prompt(&task_id, "follow up after recovery", vec![])
            .await
            .unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(Event::TaskUpdated(task)) = events.recv().await {
                    if task.id == task_id && task.status == TaskStatus::Waiting {
                        break;
                    }
                }
            }
        })
        .await
        .expect("resumed prompt should complete");

        let log = std::fs::read_to_string(&log_path).unwrap();
        let calls: Vec<serde_json::Value> = log
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let load = calls
            .iter()
            .find(|call| call["method"] == "session/load")
            .expect("recovery must call session/load");
        assert_eq!(load["params"]["sessionId"], session_id);
        let prompt = calls
            .iter()
            .find(|call| call["method"] == "session/prompt")
            .expect("follow-up must be delivered after load");
        assert_eq!(prompt["params"]["sessionId"], session_id);
        let tasks = daemon.tasks().await;
        assert_eq!(
            tasks
                .iter()
                .find(|task| task.id == task_id)
                .unwrap()
                .session_id
                .as_deref(),
            Some(session_id)
        );

        daemon.shutdown().await;
        let store = Store::open_at(&db_path).unwrap();
        let user_messages = store
            .load_session_updates(&task_id)
            .unwrap()
            .into_iter()
            .filter(|update| matches!(update, warpforge_protocol::SessionUpdate::UserMessage { text, .. } if text == "follow up after recovery"))
            .count();
        assert_eq!(user_messages, 1, "reconnect must persist the prompt once");
    }
}
