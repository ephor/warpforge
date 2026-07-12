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
        let wt_dir = self.base_repo.join(".worktrees").join(task_id);
        let branch = format!("warpforge/task/{task_id}");

        // Resolve the base branch.
        let base = match base_branch {
            Some(b) => b.to_string(),
            None => {
                let output = tokio::process::Command::new("git")
                    .args(["rev-parse", "--abbrev-ref", "HEAD"])
                    .current_dir(&self.base_repo)
                    .output()
                    .await
                    .context("failed to run git rev-parse")?;
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
        };

        // Create the worktree + branch.
        let status = tokio::process::Command::new("git")
            .args([
                "worktree",
                "add",
                "-b",
                &branch,
                wt_dir.to_str().unwrap_or(".worktrees/task"),
                &base,
            ])
            .current_dir(&self.base_repo)
            .status()
            .await
            .context("failed to run git worktree add")?;

        if !status.success() {
            anyhow::bail!("git worktree add failed (exit {status})");
        }

        let wt = Worktree {
            task_id: task_id.to_string(),
            path: wt_dir,
            branch,
            base_branch: base,
        };
        self.worktrees.insert(task_id.to_string(), wt.clone());
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
            .args(["worktree", "remove", "--force", wt.path.to_str().unwrap_or("")])
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
                        String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
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
}
