use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon, GitEffect};

impl Daemon {
    pub(crate) async fn handle_files_command(&mut self, cmd: Command) {
        match cmd {
            Command::GetDiff { task_id, reply } => {
                // Resolve the repo path from actor state, then run git off the
                // loop. The diff panel polls this, so awaiting it here put a
                // pair of git processes between every poll and the next
                // command — a tool approval included (ADR 0002).
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::spawn(async move {
                    let (files, branch) = match repo {
                        Some(path) => (
                            crate::daemon::diff::working_diff(&path)
                                .await
                                .unwrap_or_default(),
                            crate::daemon::diff::current_branch(&path).await,
                        ),
                        None => (Vec::new(), None),
                    };
                    let _ = reply.send(wire::TaskDiff {
                        task_id,
                        files,
                        branch,
                    });
                });
            }
            Command::GetFileContents {
                task_id,
                path,
                project,
                reply,
            } => {
                // Same fallback as `ListFiles`: no task means read the
                // project's own checkout, so a tree and its preview agree.
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
                tokio::spawn(async move {
                    let doc = match repo {
                        Some(p) => crate::daemon::diff::file_doc(&p, &path).await.ok(),
                        None => None,
                    };
                    let _ = reply.send(doc);
                });
            }
            Command::ListFiles {
                task_id,
                project,
                include_ignored,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
                tokio::spawn(async move {
                    let files = match repo {
                        Some(p) => crate::daemon::diff::list_files(&p, include_ignored)
                            .await
                            .unwrap_or_default(),
                        None => Vec::new(),
                    };
                    let _ = reply.send(files);
                });
            }
            Command::SearchFiles {
                task_id,
                query,
                limit,
                project,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
                match repo {
                    // A synchronous walk that reads every file in the project.
                    // Run inline it freezes the whole daemon for the length of
                    // the search — on a large repo, seconds (ADR 0002).
                    Some(p) => {
                        tokio::task::spawn_blocking(move || {
                            let matches = crate::daemon::search::search_files(&p, &query, limit)
                                .unwrap_or_default();
                            let _ = reply.send(matches);
                        });
                    }
                    None => {
                        let _ = reply.send(Vec::new());
                    }
                }
            }
            Command::SaveFile {
                task_id,
                path,
                content,
                project,
            } => {
                let repo: Option<std::path::PathBuf> = if let Some(proj) = project.clone() {
                    self.projects
                        .iter()
                        .find(|p| p.name == proj)
                        .map(|p| std::path::PathBuf::from(&p.path))
                } else {
                    self.tasks
                        .get(&task_id)
                        .and_then(|_| self.task_repo_path(&task_id).map(std::path::PathBuf::from))
                };
                let cmd_tx = self.cmd_tx.clone();
                let is_project = project.is_some();
                tokio::task::spawn_blocking(move || {
                    let Some(p) = repo else { return };
                    if crate::daemon::diff::save_file(&p.to_string_lossy(), &path, &content).is_ok()
                        && !is_project
                    {
                        // Nudge clients so the diff/file list refetches.
                        let _ = cmd_tx.blocking_send(Command::GitOpFinished {
                            task_id,
                            effect: GitEffect::Bump,
                        });
                    }
                });
            }
            Command::CreateFile {
                task_id,
                path,
                directory,
                reply,
            } => {
                // Filesystem work: resolve the path here, touch the disk on the
                // blocking pool (ADR 0002 invariant 1).
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::task::spawn_blocking(move || {
                    let result = repo
                        .ok_or_else(|| format!("no repo for task {task_id}"))
                        .and_then(|repo| {
                            crate::daemon::diff::create_file(&repo, &path, directory)
                                .map_err(|e| e.to_string())
                        });
                    let _ = reply.send(result);
                });
            }
            Command::RenameFile {
                task_id,
                path,
                new_path,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::task::spawn_blocking(move || {
                    let result = repo
                        .ok_or_else(|| format!("no repo for task {task_id}"))
                        .and_then(|repo| {
                            crate::daemon::diff::rename_file(&repo, &path, &new_path)
                                .map_err(|e| e.to_string())
                        });
                    let _ = reply.send(result);
                });
            }
            Command::DeleteFile {
                task_id,
                path,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::task::spawn_blocking(move || {
                    let result = repo
                        .ok_or_else(|| format!("no repo for task {task_id}"))
                        .and_then(|repo| {
                            crate::daemon::diff::delete_file(&repo, &path)
                                .map_err(|e| e.to_string())
                        });
                    let _ = reply.send(result);
                });
            }
            Command::ResolveHunk {
                task_id,
                file,
                hunk_index,
                resolution,
            } => {
                // accept keeps the change (no-op); only reject touches the tree.
                if resolution == wire::HunkResolution::Reject {
                    let repo = self.task_repo_path(&task_id);
                    let cmd_tx = self.cmd_tx.clone();
                    tokio::spawn(async move {
                        let Some(path) = repo else { return };
                        if crate::daemon::diff::reject_hunk(&path, &file, hunk_index)
                            .await
                            .is_ok()
                        {
                            let _ = cmd_tx
                                .send(Command::GitOpFinished {
                                    task_id,
                                    effect: GitEffect::HunkRejected,
                                })
                                .await;
                        }
                    });
                }
            }

            other => self.handle_workflow_command(other).await,
        }
    }
}
