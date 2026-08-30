use warpforge_protocol as wire;

use crate::daemon::actor::lifecycle::apply_lifecycle_action;
use crate::daemon::actor::lifecycle::LifecycleAction;
use crate::daemon::actor::{Command, Daemon, Event};

impl Daemon {
    pub(crate) async fn handle_worktree_command(&mut self, cmd: Command) {
        match cmd {
            Command::MergeWorktree { task_id, reply } => {
                // Merging runs two git commands and removes a checkout. Resolve
                // what they need here, run them off the loop, and record the
                // outcome through Command::WorktreeMerged (ADR 0002).
                let resolved = self
                    .tasks
                    .get(&task_id)
                    .map(|t| t.project.clone())
                    .and_then(|project| {
                        let mgr = self.worktrees.get(&project)?;
                        let wt = mgr.get(&task_id)?;
                        Some((
                            project,
                            mgr.base_repo().to_path_buf(),
                            wt.path.clone(),
                            wt.branch.clone(),
                            wt.base_branch.clone(),
                        ))
                    });
                let Some((project, base_repo, path, branch, base_branch)) = resolved else {
                    let _ = reply.send(Err(format!("no worktree for task {task_id}")));
                    return;
                };
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let merged =
                        crate::daemon::worktree::merge_detached(&base_repo, &branch, &base_branch)
                            .await;
                    let result = match merged {
                        Ok(crate::daemon::worktree::MergeResult::Ok { branch }) => {
                            let _ = crate::daemon::worktree::remove_detached(
                                &base_repo, &path, &branch,
                            )
                            .await;
                            let _ = cmd_tx
                                .send(Command::WorktreeMerged { task_id, project })
                                .await;
                            Ok(branch)
                        }
                        Ok(crate::daemon::worktree::MergeResult::Conflict { message, branch }) => {
                            Err(format!("merge conflict on {branch}: {message}"))
                        }
                        Ok(crate::daemon::worktree::MergeResult::Error(msg)) => Err(msg),
                        Err(e) => Err(format!("{e:#}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::WorktreeMerged { task_id, project } => {
                if let Some(mgr) = self.worktrees.get_mut(&project) {
                    mgr.forget(&task_id);
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.worktree = None;
                    task.updated_at = crate::daemon::task::now_secs();
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            Command::ListWorktrees { project, reply } => {
                let wts = if let Some(wt_mgr) = self.worktrees.get(&project) {
                    wt_mgr
                        .list()
                        .into_iter()
                        .map(|wt| wire::WorktreeInfo {
                            task_id: wt.task_id.clone(),
                            path: wt.path.to_string_lossy().to_string(),
                            branch: wt.branch.clone(),
                            base_branch: wt.base_branch.clone(),
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let _ = reply.send(wts);
            }
            Command::SettleTask { task_id, reply } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = crate::daemon::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Settle,
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::UnsettleTask { task_id, reply } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = crate::daemon::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Unsettle,
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::SnoozeTask {
                task_id,
                until,
                reply,
            } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = crate::daemon::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Snooze { until },
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::UnsnoozeTask { task_id, reply } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = crate::daemon::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Unsnooze,
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }

            other => self.handle_git_command(other).await,
        }
    }
}
