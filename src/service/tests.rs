// Service manager behaviour tests. Lives in a child module so it can
// still reach the manager's private fields.

use super::spawn::spawn_port_ready_probe;
use super::*;
use crate::ports;
use std::time::Duration;
use tokio::time::timeout;

/// A service whose process exits non-zero must be detected and reported as
/// Failed — previously the exit monitor was a no-op and it stayed "running".
#[tokio::test]
async fn crashed_service_reports_failed() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut mgr = ServiceManager::new(tx);
    mgr.start(
        "p",
        ".",
        (4000, 4099),
        ports::PortPin::Auto,
        "boom",
        "exit 7",
        0,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let mut saw_failed = false;
    while let Ok(Some(ev)) = timeout(Duration::from_secs(5), rx.recv()).await {
        if let ServiceEvent::StatusChange {
            status: ServiceStatus::Failed,
            ..
        } = ev
        {
            saw_failed = true;
            break;
        }
    }
    assert!(
        saw_failed,
        "expected a Failed status change for a crashed service"
    );
}

/// A clean exit (or an intentional stop) reports Stopped, not Failed.
#[tokio::test]
async fn clean_exit_reports_stopped() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut mgr = ServiceManager::new(tx);
    mgr.start(
        "p",
        ".",
        (4000, 4099),
        ports::PortPin::Auto,
        "ok",
        "true",
        0,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let mut saw_stopped = false;
    while let Ok(Some(ev)) = timeout(Duration::from_secs(5), rx.recv()).await {
        if let ServiceEvent::StatusChange { status, .. } = &ev {
            assert_ne!(
                *status,
                ServiceStatus::Failed,
                "clean exit must not be Failed"
            );
            if *status == ServiceStatus::Stopped {
                saw_stopped = true;
                break;
            }
        }
    }
    assert!(
        saw_stopped,
        "expected a Stopped status change for a clean exit"
    );
}

/// Readiness must not depend on framework-specific log text. If a declared
/// service port starts accepting TCP connections, the service is running.
#[tokio::test]
async fn open_port_reports_running_without_logs() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        let _ = listener.accept().await;
    });

    spawn_port_ready_probe(
        tx,
        "p/web".to_string(),
        1,
        port,
        Arc::new(AtomicBool::new(false)),
    );

    let mut saw_running = false;
    while let Ok(Some(ev)) = timeout(Duration::from_secs(5), rx.recv()).await {
        if let ServiceEvent::StatusChange {
            status: ServiceStatus::Running,
            ..
        } = ev
        {
            saw_running = true;
            break;
        }
    }
    assert!(
        saw_running,
        "expected a Running status change for an open port"
    );
}

/// A project whose declared range conflicts with another project's must
/// refuse to start services, with the reason recorded as a failure.
#[tokio::test]
async fn range_conflict_refuses_service_start() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut mgr = ServiceManager::new(tx);
    mgr.start(
        "p",
        ".",
        (4200, 4299),
        ports::PortPin::Auto,
        "web",
        "true",
        3000,
        None,
        None,
        Some("conflicts with project \"other\""),
    )
    .await
    .unwrap();

    assert_eq!(mgr.get("p", "web").unwrap().status, ServiceStatus::Failed);
    assert_eq!(mgr.get("p", "web").unwrap().allocated_port, 0);
    let (lines, ..) = mgr.log_window("p", "web", 0, None);
    assert!(
        lines
            .iter()
            .any(|l| l.contains("conflicts with project \"other\"")),
        "the reason must reach the log stream: {lines:?}"
    );
    while let Ok(Some(ev)) = timeout(Duration::from_secs(1), rx.recv()).await {
        if let ServiceEvent::StatusChange {
            status: ServiceStatus::Failed,
            ..
        } = ev
        {
            return;
        }
    }
    panic!("expected a Failed status change event");
}

/// A Strict port that is already bound must fail the service instead of
/// silently falling back to another port (ADR 0006 invariant 4).
#[tokio::test]
async fn strict_allocation_failure_fails_the_service() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let taken = listener.local_addr().unwrap().port();

    let mut mgr = ServiceManager::new(tx);
    mgr.start(
        "p",
        ".",
        (taken, taken),
        ports::PortPin::Strict,
        "web",
        "true",
        taken,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let svc = mgr.get("p", "web").unwrap();
    assert_eq!(svc.status, ServiceStatus::Failed);
    assert_eq!(svc.allocated_port, 0, "no fallback port may be handed out");
    let (lines, ..) = mgr.log_window("p", "web", 0, None);
    assert!(
        lines.iter().any(|l| l.contains(&taken.to_string())),
        "the failure must name the port: {lines:?}"
    );
    while let Ok(Some(ev)) = timeout(Duration::from_secs(1), rx.recv()).await {
        if let ServiceEvent::StatusChange {
            status: ServiceStatus::Failed,
            ..
        } = ev
        {
            return;
        }
    }
    panic!("expected a Failed status change event");
}

#[test]
fn stale_run_events_do_not_overwrite_current_service() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut mgr = ServiceManager::new(tx);
    let key = "p/web".to_string();
    mgr.services.insert(
        key.clone(),
        ManagedService {
            name: "web".into(),
            project_name: "p".into(),
            command: "dev".into(),
            status: ServiceStatus::Starting,
            logs: Vec::new(),
            next_seq: 0,
            original_port: 4000,
            allocated_port: 4000,
            port_pinned: false,
            pgid: None,
            run_id: 2,
            stopping: Arc::new(AtomicBool::new(false)),
        },
    );

    mgr.apply_event(ServiceEvent::StatusChange {
        key: key.clone(),
        run_id: 1,
        status: ServiceStatus::Stopped,
        exit_code: None,
    });
    mgr.apply_event(ServiceEvent::Log {
        key: key.clone(),
        run_id: 1,
        line: "old process noise".into(),
    });

    let svc = mgr.services.get(&key).unwrap();
    assert_eq!(svc.status, ServiceStatus::Starting);
    assert!(svc.logs.is_empty());

    mgr.apply_event(ServiceEvent::StatusChange {
        key: key.clone(),
        run_id: 2,
        status: ServiceStatus::Running,
        exit_code: None,
    });
    assert_eq!(
        mgr.services.get(&key).unwrap().status,
        ServiceStatus::Running
    );
}

/// Seq cursor semantics + lifecycle markers: a status change injects a
/// marker into the log stream, sequences stay monotonic, and `log_window`
/// returns only lines newer than the cursor plus the next cursor to poll.
#[test]
fn log_window_cursor_and_lifecycle_markers() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut mgr = ServiceManager::new(tx);
    let key = "p/web".to_string();
    mgr.services.insert(
        key.clone(),
        ManagedService {
            name: "web".into(),
            project_name: "p".into(),
            command: "dev".into(),
            status: ServiceStatus::Starting,
            logs: Vec::new(),
            next_seq: 0,
            original_port: 4000,
            allocated_port: 4000,
            port_pinned: false,
            pgid: None,
            run_id: 1,
            stopping: Arc::new(AtomicBool::new(false)),
        },
    );

    mgr.apply_event(ServiceEvent::Log {
        key: key.clone(),
        run_id: 1,
        line: "boot".into(),
    });
    mgr.apply_event(ServiceEvent::StatusChange {
        key: key.clone(),
        run_id: 1,
        status: ServiceStatus::Running,
        exit_code: None,
    });
    mgr.apply_event(ServiceEvent::StatusChange {
        key: key.clone(),
        run_id: 1,
        status: ServiceStatus::Failed,
        exit_code: Some(7),
    });

    let svc = mgr.get("p", "web").unwrap();
    let (all, at, cursor) = svc.window(0, None);
    assert_eq!(
        all,
        vec!["boot", "[service running]", "[service failed: exit code=7]"]
    );
    assert_eq!(at.len(), 3, "timestamps must align with lines");
    assert_eq!(cursor, 3, "three lines => next seq 3");

    // Cursor reads only what is newer than it; a limit tails to the newest.
    let (newer, _, _) = svc.window(1, None);
    assert_eq!(
        newer,
        vec!["[service running]", "[service failed: exit code=7]"]
    );
    let (tail, _, _) = svc.window(0, Some(2));
    assert_eq!(
        tail,
        vec!["[service running]", "[service failed: exit code=7]"]
    );

    // Snapshot-visible newest_seq.
    assert_eq!(mgr.newest_seq("p", "web"), 2);
}

/// A dependency whose pinned port failed leaves its `${svc.port}` references
/// unresolved; the dependent must refuse to start with a literal placeholder
/// in its env (ADR 0006 invariant 4 — no silent wrong-port starts).
#[tokio::test]
async fn failed_pin_refuses_dependents_with_port_placeholders() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let taken = listener.local_addr().unwrap().port();

    let mut mgr = ServiceManager::new(tx);
    // db: pinned to a taken port — fails, so it has no allocated port.
    mgr.start(
        "p",
        ".",
        (taken, taken),
        ports::PortPin::Strict,
        "db",
        "true",
        taken,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // api: no declared port of its own (so allocation succeeds), but its env
    // references ${db.port}, which db never got.
    let env = HashMap::from([(
        "DATABASE_URL".to_string(),
        "postgres://localhost:${db.port}/app".to_string(),
    )]);
    mgr.start(
        "p",
        ".",
        (taken, taken),
        ports::PortPin::Auto,
        "api",
        "true",
        0,
        Some(&env),
        None,
        None,
    )
    .await
    .unwrap();

    let api = mgr.get("p", "api").unwrap();
    assert_eq!(api.status, ServiceStatus::Failed);
    assert_eq!(api.allocated_port, 0, "no process may start");
    let (lines, ..) = mgr.log_window("p", "api", 0, None);
    assert!(
        lines
            .iter()
            .any(|l| l.contains("db") && l.contains("no allocated port")),
        "the refusal must name the unresolved dependency: {lines:?}"
    );

    while let Ok(Some(ev)) = timeout(Duration::from_secs(1), rx.recv()).await {
        if let ServiceEvent::StatusChange {
            key,
            status: ServiceStatus::Failed,
            ..
        } = ev
        {
            if key == "p/api" {
                return;
            }
            // db's own Failed event may still be queued ahead of api's.
        }
    }
    panic!("expected a Failed status change event for api");
}
