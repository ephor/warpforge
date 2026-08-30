use warpforge_protocol as wire;

use crate::daemon::actor::PendingResume;
use crate::daemon::actor::{Command, Daemon, Event};
use crate::daemon::task::Task;

impl Daemon {
    pub(crate) async fn handle_session_command(&mut self, cmd: Command) {
        match cmd {
            Command::ListSessions { project, reply } => {
                let path = self.project_path(&project);
                let agents = self.configured_agents.clone();
                tokio::task::spawn_blocking(move || {
                    let sessions = match path {
                        Some(p) => crate::daemon::sessions::external_sessions(&p, &agents),
                        None => Vec::new(),
                    };
                    let _ = reply.send(sessions);
                });
            }
            Command::ResumeTask {
                project,
                agent,
                session_id,
                title,
                reply,
            } => {
                let prompt = if title.is_empty() {
                    format!("Resumed {agent} session")
                } else {
                    title
                };
                let task = Task::new(&project, &prompt, &agent, vec!["resumed".into()]);
                let id = task.id.clone();
                // A freshly resumed external session carries no model intent
                // yet; threaded so the resume path reads the task, not a
                // hardcoded None.
                let default_model = task.model.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());
                // Load history only (empty prompt); user continues via session.prompt.
                self.start_session(
                    &id,
                    &project,
                    &agent,
                    "",
                    false,
                    Some(session_id),
                    vec![],
                    default_model,
                    std::collections::HashMap::new(),
                );
            }
            Command::SessionPrompt {
                task_id,
                text,
                attachments,
                reply,
            } => {
                let root = self.tasks.get(&task_id).map(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                        .unwrap_or_else(|| ".".into())
                });
                let prepared = root
                    .ok_or_else(|| format!("unknown task {task_id}"))
                    .and_then(|root| {
                        crate::daemon::prompt::prepare_prompt(
                            std::path::Path::new(&root),
                            text.clone(),
                            &attachments,
                        )
                    });
                let prepared = match prepared {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let user_update = wire::SessionUpdate::UserMessage {
                    text: text.clone(),
                    attachments: prepared.summaries.clone(),
                };
                let live_delivery = self
                    .sessions
                    .get(&task_id)
                    .cloned()
                    .map(|handle| handle.prompt(prepared.clone()));
                match live_delivery {
                    Some(Ok(())) => {
                        self.mark_task_running(&task_id);
                        // Echo the developer's message through the same
                        // persisted stream as agent updates. If a reconnect
                        // retry submits the same text again after the first
                        // attempt was already recorded, keep the transcript
                        // readable by dropping only that exact consecutive
                        // duplicate.
                        self.emit_session_unless_last_duplicate(&task_id, user_update);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Err(_)) | None => {
                        // A closed command channel is a stale handle. Remove it
                        // before reconnecting so its last process guard can
                        // terminate/reap the old child.
                        self.sessions.remove(&task_id);
                        let resume = self.tasks.get(&task_id).and_then(|task| {
                            task.session_id.as_ref().map(|session_id| {
                                (
                                    task.project.clone(),
                                    task.agent.clone(),
                                    session_id.clone(),
                                    task.model.clone(),
                                )
                            })
                        });

                        if let Some((project, agent, session_id, default_model)) = resume {
                            self.mark_task_running(&task_id);
                            self.emit_session(
                                &task_id,
                                wire::SessionUpdate::AgentText {
                                    text: "Reconnecting to the saved agent session…".into(),
                                },
                            );
                            // The replay guard is built from the persisted
                            // transcript, which must be read off the loop
                            // (write-behind flush + store read). Start the
                            // session only once the guard has landed, mirroring
                            // WorktreeReady: starting before it would let the
                            // agent's replayed history through unfiltered and
                            // double the output.
                            self.pending_resume.insert(
                                task_id.clone(),
                                PendingResume {
                                    project,
                                    agent,
                                    text: text.clone(),
                                    session_id,
                                    attachments,
                                    default_model,
                                },
                            );
                            self.request_resume_replay_guard(&task_id);
                            let _ = reply.send(Ok(()));
                        } else {
                            // Reject without echoing a user message that was never delivered.
                            let _ = reply.send(Err("no live or resumable agent session".into()));
                        }
                    }
                }
            }
            Command::SessionPermission {
                task_id,
                request_id,
                outcome,
            } => {
                if let Some(handle) = self.sessions.get(&task_id) {
                    handle.answer(request_id.clone(), outcome.clone());
                }
                self.pending_permissions.resolve(&task_id, &request_id);
                self.emit_session(
                    &task_id,
                    wire::SessionUpdate::PermissionResolved {
                        request_id,
                        outcome,
                    },
                );
            }
            Command::SessionSetConfigOption {
                task_id,
                config_id,
                value,
                reply,
            } => {
                let cmd_tx = self.cmd_tx.clone();
                match self.sessions.get(&task_id).cloned() {
                    Some(handle) => {
                        // The agent round-trip can take seconds; don't hold the
                        // actor loop hostage waiting for it. The verdict is
                        // routed back as a command so the actor can record it.
                        tokio::spawn(async move {
                            let result = handle
                                .set_config_option(config_id.clone(), value.clone())
                                .await;
                            let _ = reply.send(result.clone());
                            let _ = cmd_tx
                                .send(Command::SessionConfigOptionResult {
                                    task_id,
                                    config_id,
                                    value,
                                    result,
                                })
                                .await;
                        });
                    }
                    None => {
                        let _ = reply.send(Err(
                            "this task has no running agent session to configure".into(),
                        ));
                    }
                }
            }
            Command::SessionConfigOptionResult {
                task_id,
                config_id,
                value,
                result,
            } => {
                let is_model = self.tasks.get(&task_id).is_some_and(|task| {
                    task.config_options
                        .iter()
                        .find(|o| o.id == config_id)
                        .is_some_and(crate::daemon::acp::is_model_selector)
                });
                let Some(task) = self.tasks.get_mut(&task_id) else {
                    return;
                };
                match (&result, is_model) {
                    (Ok(()), true) => {
                        // The agent accepted the switch to the model selector:
                        // that is the task's durable model intent, and any
                        // earlier mismatch no longer describes reality.
                        if task.model.as_deref() != Some(value.as_str()) {
                            task.model = Some(value);
                        }
                        task.blocked_reason = None;
                        task.blocked_kind = None;
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                    (Err(error), true) => {
                        // The user asked for a model and the agent said no (or
                        // never answered). Record it durably — the session
                        // keeps running on the old model, and the user must be
                        // able to see that later, not just in the toast.
                        task.blocked_reason =
                            Some(format!("Model '{value}' was not applied: {error}"));
                        task.blocked_kind = Some(wire::TaskBlockedKind::ModelMismatch);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                    _ => {}
                }
            }

            other => self.handle_accounts_command(other).await,
        }
    }
}
