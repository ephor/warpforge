//! Automation lifecycle over the real actor: the scheduler tick's skip paths
//! (precheck, missed-run grace) and a full manual run that dispatches a real
//! daemon task and closes the run out when the agent's turn ends.

use std::time::Duration;

use tokio::sync::oneshot;
use tokio::time::timeout;

use warpforge_protocol as wire;

use crate::daemon::actor::*;
use crate::daemon::store::Store;

fn test_projects() -> Vec<crate::registry::ProjectEntry> {
    vec![crate::registry::ProjectEntry {
        name: "demo".into(),
        path: ".".into(),
        added_at: "0".into(),
        port_range: None,
        port_range_override: None,
    }]
}

fn base_automation(id: &str, precheck: Option<String>) -> wire::Automation {
    wire::Automation {
        id: id.into(),
        project: "demo".into(),
        name: "Nightly sweep".into(),
        prompt: "check the build".into(),
        agent: "claude".into(),
        model: None,
        config_overrides: Default::default(),
        trigger: wire::AutomationTrigger {
            preset: wire::AutomationPreset::Daily,
            cron: "0 9 * * *".into(),
        },
        timezone: String::new(),
        precheck,
        enabled: true,
        missed_run_grace_minutes: wire::DEFAULT_MISSED_RUN_GRACE_MINUTES,
        reuse_session: false,
        worktree: false,
        created_at: 0,
        updated_at: 0,
        next_run_at: None,
        last_run_at: None,
        last_status: None,
        last_task_id: None,
    }
}

async fn create(daemon: &DaemonHandle, automation: wire::Automation) -> wire::Automation {
    let (tx, rx) = oneshot::channel();
    daemon
        .send(Command::AutomationCreate {
            automation: Box::new(automation),
            reply: tx,
        })
        .await;
    rx.await.unwrap().expect("automation create")
}

async fn tick(daemon: &DaemonHandle) {
    daemon.send(Command::AutomationTick).await;
}

async fn wait_run(
    events: &mut tokio::sync::broadcast::Receiver<Event>,
    id: &str,
    status: wire::AutomationRunStatus,
) -> wire::AutomationRun {
    timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await {
                Ok(Event::AutomationRunUpdated(run)) => {
                    if run.automation_id == id && run.status == status {
                        break *run;
                    }
                }
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(e) => panic!("event stream closed: {e}"),
            }
        }
    })
    .await
    .expect("run reaches the expected status")
}

/// A precheck that exits non-zero (or cannot run) skips the run — it never
/// gets dispatched as a task.
#[tokio::test]
async fn failed_precheck_skips_the_run() {
    let store = Store::open_at(std::path::Path::new(":memory:")).ok();
    let daemon = Daemon::spawn(test_projects(), store);
    let mut events = daemon.subscribe();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut automation = base_automation("a-precheck", Some("exit 3".into()));
    automation.next_run_at = Some(now - 30);
    let created = create(&daemon, automation).await;
    assert_eq!(created.next_run_at, Some(now - 30));

    tick(&daemon).await;
    let run = wait_run(
        &mut events,
        "a-precheck",
        wire::AutomationRunStatus::SkippedPrecheck,
    )
    .await;
    assert_eq!(run.automation_id, "a-precheck");
    assert!(run.error.as_deref().unwrap().contains("3"));
    assert!(run.task_id.is_none(), "a skipped run never spawns a task");

    // The schedule advanced past the missed occurrence instead of re-firing.
    let (tx, rx) = oneshot::channel();
    daemon
        .send(Command::AutomationShow {
            id: "a-precheck".into(),
            reply: tx,
        })
        .await;
    let shown = rx.await.unwrap().unwrap();
    assert!(shown.next_run_at.unwrap() > now, "next occurrence moved on");

    daemon.shutdown().await;
}

/// An occurrence older than the automation's grace window is recorded as
/// skipped, not fired — a laptop reopened after a week must not run a
/// week-old job the moment it comes back.
#[tokio::test]
async fn occurrence_past_grace_is_skipped() {
    let store = Store::open_at(std::path::Path::new(":memory:")).ok();
    let daemon = Daemon::spawn(test_projects(), store);
    let mut events = daemon.subscribe();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut automation = base_automation("a-grace", None);
    automation.missed_run_grace_minutes = 5;
    automation.next_run_at = Some(now - 6 * 60);
    create(&daemon, automation).await;

    tick(&daemon).await;
    let run = wait_run(
        &mut events,
        "a-grace",
        wire::AutomationRunStatus::SkippedMissed,
    )
    .await;
    assert_eq!(run.automation_id, "a-grace");
    assert!(run.error.as_deref().unwrap().contains("grace"));

    daemon.shutdown().await;
}

/// runNow dispatches a real task (skipping the precheck), links it into the
/// run row, and the run completes when the agent's turn ends.
#[tokio::test]
async fn run_now_creates_a_task_and_completes_the_run() {
    let store = Store::open_at(std::path::Path::new(":memory:")).ok();
    let daemon = Daemon::spawn(test_projects(), store);
    let mut events = daemon.subscribe();

    let mock = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mock-acp-agent-noedit.mjs"
    );
    let mut automation = base_automation("a-manual", Some("exit 0".into()));
    automation.agent = format!("node {mock}");
    automation.next_run_at = Some(i64::MAX / 2); // never due on its own
    create(&daemon, automation).await;

    let (tx, rx) = oneshot::channel();
    daemon
        .send(Command::AutomationRunNow {
            id: "a-manual".into(),
            reply: tx,
        })
        .await;
    let dispatched = rx.await.unwrap().expect("runNow accepts the run");
    assert_eq!(dispatched.status, wire::AutomationRunStatus::Pending);

    let mut seen = Vec::new();
    let run = timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await {
                Ok(Event::AutomationRunUpdated(r)) => {
                    seen.push(format!("{}:{:?}", r.id, r.status));
                    if r.automation_id == "a-manual"
                        && r.status == wire::AutomationRunStatus::Completed
                    {
                        break *r;
                    }
                }
                Ok(Event::TaskUpdated(t)) => seen.push(format!("task {} {:?}", t.id, t.status)),
                Ok(Event::TaskCreated(t)) => seen.push(format!("created {} {:?}", t.id, t.status)),
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(e) => panic!("event stream closed: {e}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out; saw: {seen:?}"));
    let task_id = run.task_id.expect("run links its task");

    let (tx, rx) = oneshot::channel();
    daemon
        .send(Command::AutomationShow {
            id: "a-manual".into(),
            reply: tx,
        })
        .await;
    let shown = rx.await.unwrap().unwrap();
    assert_eq!(shown.last_task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(
        shown.last_status,
        Some(wire::AutomationRunStatus::Completed)
    );
    assert!(run.output.as_deref().unwrap().contains("4000"));
    // runNow must not move the next scheduled occurrence.
    assert_eq!(shown.next_run_at, Some(i64::MAX / 2));

    // The agent is told the turn is a scheduled, unattended run — otherwise a
    // reused session reads the repeated prompt as a person asking again.
    let (tx, rx) = oneshot::channel();
    daemon
        .send(Command::SessionHistory {
            task_id: task_id.clone(),
            reply: tx,
        })
        .await;
    let updates = rx.await.unwrap().expect("session history");
    let sent = updates
        .iter()
        .find_map(|u| match u {
            wire::SessionUpdate::UserMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .expect("the dispatched prompt is in the transcript");
    assert!(
        sent.starts_with("[scheduled automation \"Nightly sweep\", run #1 —"),
        "prompt carries the run marker: {sent}"
    );
    assert!(sent.contains("unattended"));
    assert!(
        sent.ends_with("\n\ncheck the build"),
        "the raw prompt stays verbatim below the marker: {sent}"
    );

    daemon.shutdown().await;
}
