use crate::daemon::actor::PendingSessionStart;
use crate::daemon::actor::ResumeReplayGuard;
use crate::daemon::actor::{Command, Daemon, Event};
use crate::daemon::runtime::{Ask as PersistAsk, Write as PersistWrite};
use crate::daemon::task::{Task, TaskStatus};
use crate::daemon::workflow::WorkflowOutcome;

impl Daemon {
    pub(crate) async fn handle_task_command(&mut self, cmd: Command) {
        match cmd {
            Command::CreateTask {
                project,
                prompt,
                agent,
                tags,
                include_runtime_context,
                worktree: use_worktree,
                parent_task_id,
                attachments,
                default_model,
                config_overrides,
                backlog_item_id,
                start,
                reply,
            } => {
                // Conversation branches tag the source task they were forked
                // from, so the new worktree can inherit its state.
                let branched_from = tags
                    .iter()
                    .find_map(|t| t.strip_prefix("branched-from:"))
                    .map(str::to_string);
                let mut task = Task::new(&project, &prompt, &agent, tags);
                task.parent_task_id = parent_task_id;
                task.backlog_item_id = backlog_item_id;
                // Durable model intent: only an explicit pick counts. The
                // last_model fallback below is a default, not something the
                // user asked this task to run on, so it must not land here.
                task.model = default_model.clone();
                // Resolve the model the session should start with: an explicit
                // UI pick wins; otherwise fall back to the user's last choice
                // for this agent (so orchestrator-spawned sub-agents inherit it
                // without a UI). Update the persisted last-model whenever the
                // user made an explicit pick so the next task defaults to it.
                let resolved_model = default_model.clone().or_else(|| {
                    self.configured_agents
                        .iter()
                        .find(|a| a.id == agent)
                        .and_then(|a| a.last_model.clone())
                });
                if let Some(ref m) = default_model {
                    if let Some(agent_cfg) =
                        self.configured_agents.iter_mut().find(|a| a.id == agent)
                    {
                        if agent_cfg.last_model.as_deref() != Some(m.as_str()) {
                            agent_cfg.last_model = Some(m.clone());
                            self.persist.write(PersistWrite::AgentModels {
                                id: agent_cfg.id.clone(),
                                models: agent_cfg.models.clone(),
                                last_model: agent_cfg.last_model.clone(),
                            });
                            let agents = self.configured_agents.clone();
                            self.emit(Event::AgentsUpdated { agents });
                        }
                    }
                }
                let id = task.id.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());

                if start {
                    let start = PendingSessionStart {
                        project: project.clone(),
                        agent: agent.clone(),
                        prompt: prompt.clone(),
                        include_runtime_context,
                        attachments,
                        default_model: resolved_model,
                        config_overrides,
                    };
                    // A worktree checkout is git work, so it runs off the loop
                    // and the session starts when it lands. The task is on the
                    // board before then, which is also why a new task no longer
                    // delays every other task's messages (ADR 0002).
                    match use_worktree
                        .then(|| self.worktree_request(&id, &project, branched_from.as_deref()))
                        .flatten()
                    {
                        Some(request) => {
                            self.pending_session_starts.insert(id.clone(), start);
                            let cmd_tx = self.cmd_tx.clone();
                            tokio::spawn(async move {
                                let created = request.run().await;
                                let _ = cmd_tx
                                    .send(Command::WorktreeReady {
                                        task_id: id,
                                        created,
                                    })
                                    .await;
                            });
                        }
                        None => self.start_pending_session(&id, start),
                    }
                }
            }
            Command::WorktreeReady { task_id, created } => {
                // Record the checkout even if nobody is waiting for it any
                // more: the directory exists on disk either way, and a
                // worktree the manager does not know about is one nothing can
                // clean up later.
                match created {
                    Ok((project, wt)) => {
                        if let Some(task) = self.tasks.get_mut(&task_id) {
                            task.worktree = Some(wt.path.to_string_lossy().to_string());
                            let updated = task.clone();
                            self.persist(&updated);
                            self.emit(Event::TaskUpdated(updated));
                        }
                        if let Some(mgr) = self.worktrees.get_mut(&project) {
                            mgr.adopt(wt);
                        }
                    }
                    // Fall back to a non-isolated run, as before.
                    Err(error) => eprintln!("[daemon] worktree creation failed: {error}"),
                }
                // The pending entry is the token: cancelling or deleting the
                // task removes it, so a checkout that lands afterwards must not
                // start a session for it (ADR 0002 invariant 5).
                if let Some(start) = self.pending_session_starts.remove(&task_id) {
                    self.start_pending_session(&task_id, start);
                }
            }
            #[cfg(test)]
            Command::TurnOutputConsumerProbe {
                task_id,
                workflow_child,
                reply,
            } => {
                let _ = reply.send(self.turn_output_has_consumer(&task_id, workflow_child));
            }

            Command::ResumeReplayReady {
                task_id,
                mut replay,
            } => {
                // The pending entry is the token: cancelling or deleting the
                // task removes it, so a guard that lands afterwards must not
                // resurrect a cancelled task's session (ADR 0002 invariant 5).
                if let Some(pending) = self.pending_resume.remove(&task_id) {
                    if let Some(guard) = ResumeReplayGuard::from_updates(replay.make_contiguous()) {
                        self.resume_replay.insert(task_id.clone(), guard);
                    }
                    self.start_session(
                        &task_id,
                        &pending.project,
                        &pending.agent,
                        &pending.text,
                        false,
                        Some(pending.session_id),
                        pending.attachments,
                        pending.default_model,
                        std::collections::HashMap::new(),
                    );
                }
            }
            Command::TaskOutputReady {
                task_id,
                success,
                workflow_child,
                output,
            } => {
                // A finished turn's full text was assembled off the loop; now
                // deliver it the way TurnEnded used to. notify_orch_finished is
                // a no-op unless the task is an orchestrator child.
                self.notify_orch_finished(&task_id, success, output.clone());
                self.automation_task_finished(&task_id, success, &output);
                if !workflow_child {
                    self.deliver_child_result(&task_id, success, output);
                }
            }

            Command::ReadInbox {
                parent_task_id,
                reply,
            } => {
                let results = self
                    .orchestrator_inbox
                    .remove(&parent_task_id)
                    .unwrap_or_default();
                self.pending_wake.remove(&parent_task_id);
                let _ = reply.send(results);
            }

            Command::CancelTask { id, reply } => {
                let result = if self.workflow_is_active(&id) {
                    // Stopping a workflow parent stops the whole pipeline.
                    self.workflow_finalize(&id, WorkflowOutcome::Stopped).await
                } else {
                    let stop_result = match self.sessions.remove(&id) {
                        Some(handle) => handle.cancel_and_wait().await,
                        None => Ok(()),
                    };
                    // A worktree checkout may still be running for this task;
                    // dropping its token stops it from starting a session the
                    // user just cancelled. Same for a pending resume: its
                    // guard must not start a session the user cancelled.
                    self.pending_session_starts.remove(&id);
                    self.pending_resume.remove(&id);
                    self.resume_replay.remove(&id);
                    self.pending_permissions.cleanup_task(&id);
                    // A finished pipeline's parent keeps its terminal status:
                    // cancelling it must not rewrite that back to Waiting.
                    let finished_workflow = self
                        .workflow_runs
                        .get(&id)
                        .is_some_and(|run| !run.is_active());
                    if let Some(task) = self.tasks.get_mut(&id).filter(|_| !finished_workflow) {
                        task.set_status(TaskStatus::Waiting);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                    // Cancelling a stage child mid-run fails that stage.
                    self.workflow_child_gone(&id).await;
                    stop_result
                };
                let _ = reply.send(result);
            }
            Command::ArchiveTask { id } => {
                // Archiving a live workflow parent stops the pipeline first so
                // no orphaned stage sessions keep running behind a Done task.
                if self.workflow_is_active(&id) {
                    let _ = self.workflow_finalize(&id, WorkflowOutcome::Stopped).await;
                }
                // Collect children that reference this task as parent so we
                // can archive them together with the leader.
                let child_ids: Vec<String> = self
                    .tasks
                    .values()
                    .filter(|t| t.parent_task_id.as_deref() == Some(&id))
                    .map(|t| t.id.clone())
                    .collect();

                // Archive the leader itself.
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(TaskStatus::Done);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }

                // Archive every direct child so the whole group moves to history.
                // A child can itself be a live workflow pipeline (spawned via
                // spawn_workflow) — stop it the same way as a directly
                // archived one, or its stage session keeps running and
                // eventually flips this "archived" task back out of Done.
                for cid in child_ids {
                    if self.workflow_is_active(&cid) {
                        let _ = self.workflow_finalize(&cid, WorkflowOutcome::Stopped).await;
                    }
                    if let Some(child) = self.tasks.get_mut(&cid) {
                        child.set_status(TaskStatus::Done);
                        let updated = child.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
            }
            Command::DeleteTask { id, reply } => {
                let stop_result = if self.workflow_is_active(&id) {
                    self.workflow_finalize(&id, WorkflowOutcome::Stopped).await
                } else {
                    match self.sessions.remove(&id) {
                        Some(handle) => handle.cancel_and_wait().await,
                        None => Ok(()),
                    }
                };
                let mut delete_result = stop_result;
                if delete_result.is_ok() && self.workflow_runs.remove(&id).is_some() {
                    self.persist
                        .write(PersistWrite::DeleteWorkflowRun(id.clone()));
                }
                if delete_result.is_ok() {
                    self.pending_permissions.cleanup_task(&id);
                }
                // Capture project path before the task is removed so we can
                // clean up YAML backlog references afterwards.
                let project_path = self
                    .tasks
                    .get(&id)
                    .and_then(|t| self.project_path(&t.project));
                // Clean up worktree if the task had one.
                if let Some(task) = self.tasks.get(&id).filter(|_| delete_result.is_ok()) {
                    if task.worktree.is_some() {
                        if let Some(wt_mgr) = self.worktrees.get_mut(&task.project) {
                            if let Err(e) = wt_mgr.remove(&id).await {
                                eprintln!("[daemon] worktree cleanup failed for {id}: {e}");
                            }
                        }
                    }
                }
                if delete_result.is_ok() && self.tasks.remove(&id).is_some() {
                    self.tool_call_starts
                        .retain(|(task_id, _), _| task_id != &id);
                    self.last_session_update.remove(&id);
                    self.turn_updates.remove(&id);
                    self.resume_replay.remove(&id);
                    self.pending_resume.remove(&id);
                    self.pending_session_starts.remove(&id);
                    // The run's task is gone — fail the run so it does not sit
                    // in Running until the stale-run sweep finds it.
                    self.automation_task_deleted(&id);
                    // Awaited, not queued: a failed delete is reported to the
                    // user, and dropping the error would leave a task that
                    // reappears on the next start with no explanation.
                    if let Err(error) = self.persist.ask(PersistAsk::DeleteTask(id.clone())).await {
                        delete_result = Err(error);
                    }
                    // Clear stale task_id from YAML backlog files.
                    if let Some(ref path) = project_path {
                        if let Err(e) = crate::daemon::backlog::clear_task_refs(path, &id) {
                            eprintln!("[daemon] YAML backlog cleanup failed for {id}: {e}");
                        }
                    }
                    self.emit(Event::TaskRemoved { id: id.clone() });
                    // Deleting a stage child mid-run fails that stage.
                    self.workflow_child_gone(&id).await;
                }
                let _ = reply.send(delete_result);
            }
            Command::SetTaskTitle { id, title } => {
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.title = title;
                    task.updated_at = crate::daemon::task::now_secs();
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }

            Command::SetTaskStatus { id, status } => {
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(status);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }

            other => self.handle_worktree_command(other).await,
        }
    }
}
