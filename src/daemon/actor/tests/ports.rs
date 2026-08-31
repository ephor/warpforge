//! Resolved port ranges on the daemon actor (ADR 0006): migration freezes,
//! declared ranges relocate sticky ones, and everything is persisted.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tokio::sync::{Mutex, MutexGuard};

use crate::daemon::actor::ports::PortRangeSink;
use crate::daemon::actor::Daemon;
use crate::registry::{self, PortRange, ProjectEntry};

/// The registry reads its home directory from a process-global env var, and
/// cargo runs tests in parallel threads — serialize the tests that touch it.
/// A tokio mutex because the guard is deliberately held across `.await`s.
async fn registry_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

fn temp_home(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("warpforge-stage2a-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn register(tag: &str, name: &str) -> ProjectEntry {
    let path = temp_home(tag).join(name);
    std::fs::create_dir_all(&path).unwrap();
    registry::add_project(path.to_str().unwrap(), Some(name), None).unwrap()
}

/// Point the registry at a throwaway directory for the duration of a test.
async fn with_registry(tag: &str) -> MutexGuard<'static, ()> {
    let guard = registry_lock().await;
    std::env::set_var("WARPFORGE_HOME", temp_home(tag));
    guard
}

fn stored_range(name: &str) -> Option<PortRange> {
    registry::list_projects()
        .unwrap()
        .into_iter()
        .find(|p| p.name == name)
        .and_then(|p| p.port_range)
}

fn declare_range(dir: &Path, range: &str) {
    let config = dir.join(".warpforge/workspace.yaml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(config, format!("name: x\nports:\n  range: \"{range}\"\n")).unwrap();
}

/// A registry entry with no stored range gets its positional range on first
/// daemon boot, and the assignment is frozen into projects.json.
#[tokio::test]
async fn recompute_migrates_positional_range_and_persists() {
    let _guard = with_registry("migrate").await;
    let entry = register("migrate", "migrating");
    assert!(entry.port_range.is_none());

    let handle = Daemon::spawn_with_sink(vec![entry], None, PortRangeSink::Registry);
    handle.snapshot().await; // barrier: startup recompute has run
    let stored = stored_range("migrating");
    handle.shutdown().await;

    assert_eq!(
        stored,
        Some(PortRange {
            start: 4000,
            size: 100
        }),
        "the migrated range must be persisted"
    );
}

/// A newly declared config range beats another project's sticky range, and
/// both resolved ranges are persisted.
#[tokio::test]
async fn declared_range_relocates_sticky_range_and_persists_both() {
    let _guard = with_registry("relocate").await;
    let relocating = register("relocate", "relocating");
    let declaring = register("relocate", "declaring");
    declare_range(&temp_home("relocate").join("declaring"), "4000-4099");

    let handle =
        Daemon::spawn_with_sink(vec![relocating, declaring], None, PortRangeSink::Registry);
    handle.snapshot().await;
    let relocating_range = stored_range("relocating");
    let declaring_range = stored_range("declaring");
    handle.shutdown().await;

    assert_eq!(
        declaring_range.map(|r| (r.start, r.start + r.size - 1)),
        Some((4000, 4099)),
        "the declared range keeps its ports"
    );
    assert_eq!(
        relocating_range.map(|r| (r.start, r.start + r.size - 1)),
        Some((4100, 4199)),
        "the sticky range relocates and is persisted"
    );
}

/// Persistence goes to the injected sink: the default test sink records the
/// sticky range instead of touching `~/.warpforge/projects.json`.
#[tokio::test]
async fn sticky_range_persists_to_the_injected_sink() {
    let sink = PortRangeSink::memory();
    let entry = ProjectEntry {
        name: "sink-test".into(),
        path: ".".into(),
        added_at: "0".into(),
        port_range: None,
        port_range_override: None,
    };

    let handle = Daemon::spawn_with_sink(vec![entry], None, sink.clone());
    handle.snapshot().await; // barrier: startup recompute has run
    handle.shutdown().await;

    let writes = match &sink {
        PortRangeSink::Memory(log) => log.lock().unwrap().clone(),
        PortRangeSink::Registry => panic!("expected the memory sink"),
    };
    assert_eq!(
        writes,
        vec![(
            "sink-test".to_string(),
            PortRange {
                start: 4000,
                size: 100
            }
        )],
        "the resolved range must be persisted to the injected target"
    );
}

/// A project missing from the registry is skipped silently: no write, no
/// error, and the registry file is untouched.
#[tokio::test]
async fn range_persistence_skips_projects_missing_from_the_registry() {
    let _guard = with_registry("missing").await;
    let entry = ProjectEntry {
        name: "not-in-registry".into(),
        path: ".".into(),
        added_at: "0".into(),
        port_range: None,
        port_range_override: None,
    };

    let handle = Daemon::spawn_with_sink(vec![entry], None, PortRangeSink::Registry);
    handle.snapshot().await; // barrier: startup recompute has run
    handle.shutdown().await;

    let all = registry::list_projects().unwrap();
    assert!(
        all.iter().all(|p| p.name != "not-in-registry"),
        "a project missing from the registry must not be written to it"
    );
}

/// The `project.setPortRange` RPC drives the actor's `SetPortRange` command,
/// which writes the override to the registry (never the shared config) and
/// re-resolves every range.
#[tokio::test]
async fn set_port_range_command_writes_the_override() {
    let _guard = with_registry("override").await;
    let entry = register("override", "overridden");

    let handle = Daemon::spawn_with_sink(vec![entry], None, PortRangeSink::Registry);
    handle
        .set_port_range(
            "overridden",
            Some(PortRange {
                start: 4200,
                size: 100,
            }),
        )
        .await
        .expect("the override must be accepted");
    let stored = registry::list_projects()
        .unwrap()
        .into_iter()
        .find(|p| p.name == "overridden")
        .and_then(|p| p.port_range_override);
    handle.shutdown().await;

    assert_eq!(
        stored,
        Some(PortRange {
            start: 4200,
            size: 100
        }),
        "the override must be written to the registry"
    );
}

/// A service whose declared port sits outside the project's declared range
/// fails loudly, and the error names both remedies (ADR 0006 invariant 4).
#[tokio::test]
async fn out_of_range_pin_fails_with_named_remedies() {
    let _guard = with_registry("oor").await;
    let dir = temp_home("oor").join("outofrange");
    let config = dir.join(".warpforge/workspace.yaml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(
            &config,
            "name: outofrange\nports:\n  range: \"4500-4599\"\nservices:\n  web:\n    command: \"true\"\n    port: 3000\n",
        )
        .unwrap();
    let entry = ProjectEntry {
        name: "outofrange".into(),
        path: dir.to_string_lossy().to_string(),
        added_at: "0".into(),
        port_range: None,
        port_range_override: None,
    };

    let handle = Daemon::spawn_with_sink(vec![entry], None, PortRangeSink::Registry);
    handle
        .send(crate::daemon::actor::Command::StartService {
            project: "outofrange".into(),
            service: "web".into(),
        })
        .await;
    let mut failed = false;
    for _ in 0..50 {
        let snapshot = handle.snapshot().await;
        if let Some(web) = snapshot.services.iter().find(|s| s.name == "web") {
            if web.status == warpforge_protocol::ServiceStatus::Failed {
                failed = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let (lines, ..) = handle.service_logs("outofrange", "web", 0, None).await;
    handle.shutdown().await;

    assert!(failed, "web must fail: {:?}", lines);
    assert!(
        lines
            .iter()
            .any(|l| l.contains("4500-4599") && l.contains("portFallback: auto")),
        "the failure must name the range and both remedies: {lines:?}"
    );
}

/// A project registered after daemon boot gets a fresh scan from 4000 —
/// never `4000 + index*100` (ADR 0006 invariant 2).
#[tokio::test]
async fn newly_added_project_gets_a_fresh_scan_not_a_positional_range() {
    let _guard = with_registry("fresh-scan").await;
    let a = register("fresh-scan", "a-fresh");
    declare_range(&temp_home("fresh-scan").join("a-fresh"), "4500-4599");

    let handle = Daemon::spawn_with_sink(vec![a], None, PortRangeSink::Registry);
    handle.snapshot().await; // barrier: boot recompute has run

    let b_dir = temp_home("fresh-scan").join("b-fresh");
    std::fs::create_dir_all(&b_dir).unwrap();
    handle
        .add_project(b_dir.to_str().unwrap(), Some("b-fresh"), None)
        .await
        .expect("adding the second project must succeed");
    let stored = stored_range("b-fresh");
    handle.shutdown().await;

    assert_eq!(
        stored.map(|r| (r.start, r.start + r.size - 1)),
        Some((4000, 4099)),
        "a new project must get the first free block, not its list index"
    );
}

/// Adding a project that claims an existing project's sticky range
/// relocates that project — and the broadcast must include it, not just
/// the newly added one.
#[tokio::test]
async fn adding_a_project_broadcasts_every_relocated_project() {
    let _guard = with_registry("broadcast").await;
    let a = register("broadcast", "a-broadcast");

    let handle = Daemon::spawn_with_sink(vec![a], None, PortRangeSink::Registry);
    handle.snapshot().await; // barrier: a-broadcast holds 4000-4099 (boot migration)
    let mut events = handle.subscribe();

    let b_dir = temp_home("broadcast").join("b-broadcast");
    std::fs::create_dir_all(&b_dir).unwrap();
    declare_range(&b_dir, "4000-4099");
    handle
        .add_project(b_dir.to_str().unwrap(), Some("b-broadcast"), None)
        .await
        .expect("adding the second project must succeed");

    let mut saw_relocated = false;
    while let Ok(event) = events.try_recv() {
        if let crate::daemon::actor::Event::ProjectConfigChanged(state) = event {
            if state.project.name == "a-broadcast" && state.project.port_range == (4100, 4199) {
                saw_relocated = true;
            }
        }
    }
    handle.shutdown().await;

    assert!(
        saw_relocated,
        "a-broadcast moved to 4100-4199 and must have been broadcast"
    );
}

/// Adding a project with a range stores it as the registry's sticky range
/// (the same slot `warpforge add --ports` uses) — not as a local override.
#[tokio::test]
async fn add_with_a_range_stores_it_as_the_sticky_range() {
    let _guard = with_registry("add-sticky").await;
    let dir = temp_home("add-sticky").join("with-range");
    std::fs::create_dir_all(&dir).unwrap();

    let handle = Daemon::spawn_with_sink(vec![], None, PortRangeSink::Registry);
    handle
        .add_project(
            dir.to_str().unwrap(),
            Some("with-range"),
            Some(PortRange {
                start: 4200,
                size: 100,
            }),
        )
        .await
        .expect("adding with a range must succeed");
    let stored = stored_range("with-range");
    let entry = registry::list_projects()
        .unwrap()
        .into_iter()
        .find(|p| p.name == "with-range")
        .unwrap();
    handle.shutdown().await;

    assert_eq!(
        stored,
        Some(PortRange {
            start: 4200,
            size: 100
        }),
        "the range must land in the sticky slot"
    );
    assert!(
        entry.port_range_override.is_none(),
        "the add-dialog range must never become a local override"
    );
}

/// The whole point (ADR 0006 precedence): a range captured at add time is
/// sticky, so a `ports.range` the team later declares outranks and relocates
/// it — unlike a local override, which would have kept winning forever.
#[tokio::test]
async fn a_declared_range_later_outranks_the_range_captured_at_add_time() {
    let _guard = with_registry("add-declared").await;
    let dir = temp_home("add-declared").join("later-declared");
    std::fs::create_dir_all(&dir).unwrap();

    let handle = Daemon::spawn_with_sink(vec![], None, PortRangeSink::Registry);
    handle
        .add_project(
            dir.to_str().unwrap(),
            Some("later-declared"),
            Some(PortRange {
                start: 4200,
                size: 100,
            }),
        )
        .await
        .expect("adding with a range must succeed");
    let captured = stored_range("later-declared");
    handle.shutdown().await;

    assert_eq!(
        captured.map(|r| (r.start, r.start + r.size - 1)),
        Some((4200, 4299)),
        "the add-time range must be captured as the sticky assignment"
    );

    declare_range(&dir, "4000-4099");
    let entry = registry::list_projects()
        .unwrap()
        .into_iter()
        .find(|p| p.name == "later-declared")
        .unwrap();
    let handle = Daemon::spawn_with_sink(vec![entry], None, PortRangeSink::Registry);
    handle.snapshot().await; // barrier: the boot recompute has resolved
    let stored = stored_range("later-declared");
    handle.shutdown().await;

    assert_eq!(
        stored.map(|r| (r.start, r.start + r.size - 1)),
        Some((4000, 4099)),
        "the declared range must outrank the captured sticky range and be frozen as the stored assignment"
    );
}
