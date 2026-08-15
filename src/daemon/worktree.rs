//! Git worktree isolation: each task can optionally run in its own worktree so
//! parallel tasks don't conflict on the same working tree.
//!
//! A worktree is created under `<project>/.worktrees/<task_id>` on a branch
//! `warpforge/task/<task_id>` (derived from the current HEAD). When the task
//! completes the worktree can be merged back and removed, or left for manual
//! inspection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Metadata about one worktree.
#[derive(Debug, Clone)]
pub struct Worktree {
    pub task_id: String,
    pub path: PathBuf,
    pub branch: String,
    pub base_branch: String,
}

/// Manages git worktrees for a single project repo.
pub struct WorktreeManager {
    base_repo: PathBuf,
    worktrees: HashMap<String, Worktree>,
}

impl WorktreeManager {
    pub fn new(base_repo: PathBuf) -> Self {
        Self {
            base_repo,
            worktrees: HashMap::new(),
        }
    }

    /// Create a worktree for `task_id`. If `base_branch` is provided, branch
    /// from that; otherwise branch from the current HEAD.
    pub async fn create(&mut self, task_id: &str, base_branch: Option<&str>) -> Result<Worktree> {
        let wt = create_detached(&self.base_repo, task_id, base_branch).await?;
        self.adopt(wt.clone());
        Ok(wt)
    }

    /// The repo this manager tracks worktrees for.
    pub fn base_repo(&self) -> &Path {
        &self.base_repo
    }

    /// Record a worktree created outside the manager (see [`create_detached`]).
    pub fn adopt(&mut self, wt: Worktree) {
        self.worktrees.insert(wt.task_id.clone(), wt);
    }

    /// The branch and path a branched worktree would inherit from, if the
    /// source task has a worktree here.
    pub fn source_state(&self, source_task_id: &str) -> Option<(String, PathBuf)> {
        self.worktrees
            .get(source_task_id)
            .map(|wt| (wt.branch.clone(), wt.path.clone()))
    }

    /// Create a worktree for `task_id` that inherits the state of a source
    /// worktree (used for conversation branches). Branches from the source
    /// worktree's branch and copies its uncommitted changes so the new task
    /// starts exactly where the source left off, rather than from a clean HEAD.
    pub async fn create_branched(
        &mut self,
        task_id: &str,
        source_task_id: &str,
    ) -> Result<Worktree> {
        let source = self
            .worktrees
            .get(source_task_id)
            .with_context(|| format!("no worktree for source task {source_task_id}"))?;
        let base_branch = source.branch.clone();
        let source_path = source.path.clone();
        let wt = self.create(task_id, Some(&base_branch)).await?;
        copy_working_state(&source_path, &wt.path)
            .await
            .with_context(|| {
                format!("failed to copy working state into branched worktree {task_id}")
            })?;
        Ok(wt)
    }

    /// Remove a worktree and its branch.
    pub async fn remove(&mut self, task_id: &str) -> Result<()> {
        let wt = self
            .worktrees
            .remove(task_id)
            .with_context(|| format!("no worktree for task {task_id}"))?;

        // Remove the worktree (git cleans up the dir).
        let status = tokio::process::Command::new("git")
            .args([
                "worktree",
                "remove",
                "--force",
                wt.path.to_str().unwrap_or(""),
            ])
            .current_dir(&self.base_repo)
            .status()
            .await
            .context("failed to run git worktree remove")?;

        if !status.success() {
            anyhow::bail!("git worktree remove failed (exit {status})");
        }

        // Delete the branch.
        let _ = tokio::process::Command::new("git")
            .args(["branch", "-D", &wt.branch])
            .current_dir(&self.base_repo)
            .status()
            .await;

        Ok(())
    }

    /// Merge the worktree's branch back into its base branch.
    pub async fn merge(&self, task_id: &str) -> Result<MergeResult> {
        let wt = self
            .worktrees
            .get(task_id)
            .with_context(|| format!("no worktree for task {task_id}"))?;

        // Switch to base branch.
        let status = tokio::process::Command::new("git")
            .args(["checkout", &wt.base_branch])
            .current_dir(&self.base_repo)
            .status()
            .await
            .context("failed to checkout base branch")?;

        if !status.success() {
            return Ok(MergeResult::Error("failed to checkout base branch".into()));
        }

        // Merge the worktree branch.
        let output = tokio::process::Command::new("git")
            .args(["merge", &wt.branch, "--no-edit"])
            .current_dir(&self.base_repo)
            .output()
            .await
            .context("failed to run git merge")?;

        if output.status.success() {
            Ok(MergeResult::Ok {
                branch: wt.branch.clone(),
            })
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if stderr.contains("CONFLICT") || stderr.contains("conflict") {
                // Abort the failed merge.
                let _ = tokio::process::Command::new("git")
                    .args(["merge", "--abort"])
                    .current_dir(&self.base_repo)
                    .status()
                    .await;
                Ok(MergeResult::Conflict {
                    message: stderr,
                    branch: wt.branch.clone(),
                })
            } else {
                Ok(MergeResult::Error(stderr))
            }
        }
    }

    /// Get the working directory for a task (worktree path if it exists,
    /// otherwise the base repo).
    pub fn cwd(&self, task_id: &str) -> &Path {
        self.worktrees
            .get(task_id)
            .map(|wt| wt.path.as_path())
            .unwrap_or(&self.base_repo)
    }

    /// Check if a task has a worktree.
    pub fn has_worktree(&self, task_id: &str) -> bool {
        self.worktrees.contains_key(task_id)
    }

    /// List all active worktrees.
    pub fn list(&self) -> Vec<&Worktree> {
        self.worktrees.values().collect()
    }

    /// Discover existing warpforge worktrees on disk (for recovery after
    /// daemon restart).
    pub async fn discover(&mut self) -> Result<()> {
        let wt_root = self.base_repo.join(".worktrees");
        if !wt_root.exists() {
            return Ok(());
        }

        let mut entries = tokio::fs::read_dir(&wt_root)
            .await
            .context("reading .worktrees directory")?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let task_id = match path.file_name().and_then(|n| n.to_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };

            // Verify it's a valid git worktree.
            let head = path.join(".git");
            if !head.exists() {
                continue;
            }

            let branch = tokio::process::Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(&path)
                .output()
                .await
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        String::from_utf8(o.stdout)
                            .ok()
                            .map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "unknown".to_string());

            let wt = Worktree {
                task_id: task_id.clone(),
                path,
                branch: branch.clone(),
                base_branch: "main".to_string(), // best guess on discovery
            };
            self.worktrees.insert(task_id, wt);
        }
        Ok(())
    }
}

/// Create a worktree without a manager, so the git work can run off the daemon
/// actor. The caller records the result with [`WorktreeManager::adopt`].
///
/// `git worktree add` takes long enough to be felt: run inside a command
/// handler it delayed every other task's messages and approvals until the new
/// task's checkout finished (ADR 0002).
pub async fn create_detached(
    base_repo: &Path,
    task_id: &str,
    base_branch: Option<&str>,
) -> Result<Worktree> {
    let wt_dir = base_repo.join(".worktrees").join(task_id);
    let branch = format!("warpforge/task/{task_id}");

    let base = match base_branch {
        Some(b) => b.to_string(),
        None => {
            let output = tokio::process::Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(base_repo)
                .output()
                .await
                .context("failed to run git rev-parse")?;
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
    };

    let status = tokio::process::Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            &branch,
            wt_dir.to_str().unwrap_or(".worktrees/task"),
            &base,
        ])
        .current_dir(base_repo)
        .status()
        .await
        .context("failed to run git worktree add")?;

    if !status.success() {
        anyhow::bail!("git worktree add failed (exit {status})");
    }

    Ok(Worktree {
        task_id: task_id.to_string(),
        path: wt_dir,
        branch,
        base_branch: base,
    })
}

/// [`create_detached`] for a conversation branch: branch from `source_branch`
/// and carry over the source worktree's uncommitted changes.
pub async fn create_branched_detached(
    base_repo: &Path,
    task_id: &str,
    source_branch: &str,
    source_path: &Path,
) -> Result<Worktree> {
    let wt = create_detached(base_repo, task_id, Some(source_branch)).await?;
    copy_working_state(source_path, &wt.path)
        .await
        .with_context(|| {
            format!("failed to copy working state into branched worktree {task_id}")
        })?;
    Ok(wt)
}

/// Copy the uncommitted working-tree state of `source` into `target` so a
/// branched worktree starts from the exact files the source left behind.
/// Handles tracked modifications/deletions (via a binary diff applied with
/// `git apply`) and new untracked files (copied directly).
async fn copy_working_state(source: &Path, target: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    // 1) Apply tracked changes (modified + deleted) from the source HEAD.
    let diff = tokio::process::Command::new("git")
        .args(["diff", "--binary", "HEAD"])
        .current_dir(source)
        .output()
        .await
        .context("failed to run git diff in source worktree")?;
    if !diff.status.success() {
        anyhow::bail!("git diff failed in source worktree");
    }
    if !diff.stdout.is_empty() {
        let mut apply = tokio::process::Command::new("git")
            .args(["apply", "-"])
            .current_dir(target)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .context("failed to spawn git apply")?;
        apply
            .stdin
            .take()
            .expect("git apply stdin should be piped")
            .write_all(&diff.stdout)
            .await
            .context("failed to write diff into git apply")?;
        let out = apply
            .wait_with_output()
            .await
            .context("git apply did not finish")?;
        if !out.status.success() {
            anyhow::bail!("git apply failed: {}", String::from_utf8_lossy(&out.stderr));
        }
    }

    // 2) Copy new (untracked) files, preserving directory structure.
    let untracked = tokio::process::Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(source)
        .output()
        .await
        .context("failed to list untracked files")?;
    if !untracked.status.success() {
        anyhow::bail!("git ls-files failed in source worktree");
    }
    for line in String::from_utf8_lossy(&untracked.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        let src = source.join(line);
        let dst = target.join(line);
        if let Some(parent) = dst.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        tokio::fs::copy(&src, &dst)
            .await
            .with_context(|| format!("copying {}", line))?;
    }

    Ok(())
}

#[derive(Debug)]
pub enum MergeResult {
    Ok { branch: String },
    Conflict { message: String, branch: String },
    Error(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_and_remove_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().to_path_buf();

        // Init a git repo.
        tokio::process::Command::new("git")
            .args(["init"])
            .current_dir(&repo)
            .status()
            .await
            .unwrap();

        // Create an initial commit (worktree needs at least one commit).
        std::fs::write(repo.join("README.md"), "init").unwrap();
        tokio::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&repo)
            .status()
            .await
            .unwrap();
        tokio::process::Command::new("git")
            .args(["commit", "-m", "init", "--author", "test <t@t>"])
            .current_dir(&repo)
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .await
            .unwrap();

        let mut mgr = WorktreeManager::new(repo.clone());
        let wt = mgr.create("t_abc123", None).await.unwrap();
        assert!(wt.path.exists());
        assert!(wt.branch.contains("t_abc123"));
        assert!(mgr.has_worktree("t_abc123"));

        let list = mgr.list();
        assert_eq!(list.len(), 1);

        mgr.remove("t_abc123").await.unwrap();
        assert!(!mgr.has_worktree("t_abc123"));
        assert_eq!(mgr.list().len(), 0);
    }

    #[tokio::test]
    async fn branched_worktree_inherits_source_state() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().to_path_buf();
        let git = |args: &[&str], dir: &std::path::Path| {
            tokio::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .status()
        };

        // Init a repo with an initial commit.
        git(&["init"], &repo).await.unwrap();
        std::fs::write(repo.join("README.md"), "init\n").unwrap();
        git(&["add", "."], &repo).await.unwrap();
        git(&["commit", "-m", "init"], &repo).await.unwrap();

        let mut mgr = WorktreeManager::new(repo.clone());
        let src = mgr.create("t_source", None).await.unwrap();

        // The source agent edits a tracked file and adds a new file, without committing.
        tokio::fs::write(src.path.join("README.md"), "edited\n")
            .await
            .unwrap();
        tokio::fs::write(src.path.join("NEW.md"), "new file\n")
            .await
            .unwrap();

        let branch = mgr.create_branched("t_branch", "t_source").await.unwrap();
        assert_ne!(branch.path, src.path);
        assert_eq!(branch.base_branch, src.branch);

        // The tracked edit and the new untracked file must carry over.
        let readme = tokio::fs::read_to_string(branch.path.join("README.md"))
            .await
            .unwrap();
        assert_eq!(readme, "edited\n");
        let new = tokio::fs::read_to_string(branch.path.join("NEW.md"))
            .await
            .unwrap();
        assert_eq!(new, "new file\n");
    }
}
