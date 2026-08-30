use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon, Event, GitEffect};

impl Daemon {
    pub(crate) async fn handle_git_command(&mut self, cmd: Command) {
        match cmd {
            Command::GitOpFinished { task_id, effect } => match effect {
                GitEffect::Bump => self.bump_task(&task_id),
                GitEffect::Committed => {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        task.updated_at = crate::daemon::task::now_secs();
                        task.files_changed = 0;
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
                GitEffect::HunkRejected => {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        task.updated_at = crate::daemon::task::now_secs();
                        task.files_changed = task.files_changed.saturating_sub(1);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
            },

            Command::GitCommit {
                task_id,
                message,
                files,
                amend,
                project,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off the loop,
                // reporting what changed back as GitOpFinished (ADR 0002).
                let repo: Option<String> = if let Some(proj) = project.clone() {
                    self.projects
                        .iter()
                        .find(|p| p.name == proj)
                        .map(|p| p.path.clone())
                } else {
                    self.task_repo_path(&task_id)
                };
                let cmd_tx = self.cmd_tx.clone();
                let is_project = project.is_some();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => {
                            crate::daemon::diff::commit(&p, &message, files.as_deref(), amend)
                                .await
                                .map_err(|e| e.to_string())
                        }
                        None => Err(if is_project {
                            format!("no repo for project {}", project.unwrap_or_default())
                        } else {
                            format!("no repo for task {task_id}")
                        }),
                    };
                    if result.is_ok() {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Committed,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitLastCommitMessage { task_id, reply } => {
                // Read-only, but still shells out — resolve here, run off the loop.
                let repo = self.task_repo_path(&task_id);
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::last_commit_message(&p)
                            .await
                            .map_err(|e| e.to_string()),
                        None => Err(format!("no repo for task {task_id}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::GitUpdate { task_id, reply } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::update_project(&p)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    // A clean update changed HEAD/tree — nudge clients to refetch.
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranches {
                task_id,
                project,
                reply,
            } => {
                // A task pins its own project; without one, New Task passes the
                // project directly because no task exists yet.
                let repo = match task_id {
                    Some(id) => self.task_repo_path(&id),
                    None => project.as_deref().and_then(|p| self.project_path(p)),
                };
                tokio::spawn(async move {
                    let list = match repo {
                        Some(p) => crate::daemon::diff::list_branches(&p)
                            .await
                            .unwrap_or_default(),
                        None => wire::GitBranchList::default(),
                    };
                    let _ = reply.send(list);
                });
            }
            Command::GitSwitchBranch {
                task_id,
                branch,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::switch_branch(&p, &branch)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    // Switching branches changes the whole working tree — refetch.
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranchRename {
                task_id,
                branch,
                new_name,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::rename_branch(&p, &branch, &new_name)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranchDelete {
                task_id,
                branch,
                force,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::delete_branch(&p, &branch, force)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranchCreate {
                task_id,
                name,
                from,
                checkout,
                overwrite,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::branch_create(
                            &p,
                            &name,
                            from.as_deref(),
                            checkout,
                            overwrite,
                        )
                        .await
                        .unwrap_or_else(|e| wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: e.to_string(),
                            conflicts: Vec::new(),
                            branch: None,
                        }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitRebase {
                task_id,
                branch,
                target,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::rebase(&p, &branch, &target)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitMerge {
                task_id,
                target,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => crate::daemon::diff::merge(&p, &target)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitPushInfo { task_id, reply } => {
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                tokio::spawn(async move {
                    let result = match repo {
                        Some(path) => crate::daemon::diff::push_info(&path)
                            .await
                            .map_err(|e| e.to_string()),
                        None => Err(format!("no repo for task {task_id}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::GitPush {
                task_id,
                force,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(path) => crate::daemon::diff::push(&path, force)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitCreatePr {
                task_id,
                title,
                body,
                base,
                reply,
            } => {
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                // Creating a PR shells out to the forge's CLI over the network;
                // it changes nothing the actor holds, so it just answers from a
                // task of its own (ADR 0002).
                tokio::spawn(async move {
                    let result = match repo {
                        Some(path) => {
                            crate::daemon::diff::create_pr(&path, &title, &body, base.as_deref())
                                .await
                                .map_err(|e| e.to_string())
                        }
                        None => Err(format!("no repo for task {task_id}")),
                    };
                    let _ = reply.send(result);
                });
            }

            other => self.handle_files_command(other).await,
        }
    }
}
