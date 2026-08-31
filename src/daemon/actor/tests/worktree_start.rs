use crate::daemon::actor::*;
use crate::daemon::task::Task;
use crate::registry::ProjectEntry;
use std::time::Duration;

const MOCK_AGENT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/mock-acp-inspect.mjs"
);

/// A git repo with one commit, so `git worktree add` has something to
/// branch from.
async fn repo_with_commit() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir.path())
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
    };
    git(&["init"]).await.unwrap();
    std::fs::write(dir.path().join("README.md"), "init\n").unwrap();
    git(&["add", "."]).await.unwrap();
    git(&["commit", "-m", "init"]).await.unwrap();
    dir
}

async fn spawn_with_repo(dir: &tempfile::TempDir) -> DaemonHandle {
    Daemon::spawn(
        vec![ProjectEntry {
            name: "demo".into(),
            path: dir.path().to_string_lossy().into_owned(),
            added_at: "0".into(),
            port_range: None,
            port_range_override: None,
        }],
        None,
    )
}

async fn create_worktree_task(handle: &DaemonHandle) -> String {
    handle
        .create_task(
            "demo",
            "do the thing",
            &format!("node {MOCK_AGENT}"),
            Vec::new(),
            false,
            true,
            None,
            Vec::new(),
            None,
            Default::default(),
            None,
        )
        .await
}

async fn task_now(handle: &DaemonHandle, id: &str) -> Task {
    handle
        .tasks()
        .await
        .into_iter()
        .find(|t| t.id == id)
        .expect("task on the board")
}

/// The task must reach the board before its checkout finishes. It used to
/// be created only after `git worktree add` returned, so starting a task
/// held up every other task's messages and approvals (ADR 0002).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_appears_before_its_worktree_is_ready() {
    let dir = repo_with_commit().await;
    let handle = spawn_with_repo(&dir).await;

    let id = create_worktree_task(&handle).await;
    assert!(!id.is_empty());
    assert_eq!(
        task_now(&handle, &id).await.worktree,
        None,
        "create must return before the checkout, not after it"
    );

    // The worktree is attached once the checkout lands.
    let mut path = None;
    for _ in 0..100 {
        if let Some(p) = task_now(&handle, &id).await.worktree {
            path = Some(p);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let path = path.expect("checkout should attach a worktree");
    assert!(std::path::Path::new(&path).exists(), "worktree on disk");

    handle.shutdown().await;
}

/// Branching a conversation whose source runs in the project checkout —
/// no worktree of its own — must still carry the uncommitted work over.
///
/// This regressed once: the lookup only knew how to find a source
/// *worktree*, so a source without one silently produced a branch on a
/// clean HEAD, and the change the user was continuing from was gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branching_from_the_project_checkout_carries_its_changes() {
    let dir = repo_with_commit().await;
    let handle = spawn_with_repo(&dir).await;

    // The source task has no worktree, and its checkout has uncommitted
    // work: one tracked edit and one new file.
    let source = handle
        .create_task(
            "demo",
            "source",
            &format!("node {MOCK_AGENT}"),
            Vec::new(),
            false,
            false,
            None,
            Vec::new(),
            None,
            Default::default(),
            None,
        )
        .await;
    std::fs::write(dir.path().join("README.md"), "edited\n").unwrap();
    std::fs::write(dir.path().join("NEW.md"), "new file\n").unwrap();

    let branch = handle
        .create_task(
            "demo",
            "branch",
            &format!("node {MOCK_AGENT}"),
            vec![format!("branched-from:{source}")],
            false,
            true,
            None,
            Vec::new(),
            None,
            Default::default(),
            None,
        )
        .await;

    let mut path = None;
    for _ in 0..100 {
        if let Some(p) = task_now(&handle, &branch).await.worktree {
            path = Some(p);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let path = std::path::PathBuf::from(path.expect("branch should get a worktree"));

    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "edited\n",
        "the tracked edit must carry over"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("NEW.md")).unwrap(),
        "new file\n",
        "the new untracked file must carry over"
    );

    handle.shutdown().await;
}

/// Cancelling while the checkout is still running must not start a session
/// when it lands — but the worktree still gets recorded, because it exists
/// on disk and something has to be able to clean it up.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_during_checkout_does_not_start_a_session() {
    let dir = repo_with_commit().await;
    let handle = spawn_with_repo(&dir).await;

    let id = create_worktree_task(&handle).await;
    handle.cancel_task(&id).await.ok();

    // Wait for the checkout to land, then give a session every chance to
    // start before concluding that none did.
    for _ in 0..100 {
        if task_now(&handle, &id).await.worktree.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let task = task_now(&handle, &id).await;
    assert!(
        task.worktree.is_some(),
        "the checkout must still be recorded so it can be cleaned up"
    );
    assert_eq!(
        task.session_id, None,
        "a cancelled task must not be started by its own checkout"
    );

    handle.shutdown().await;
}
