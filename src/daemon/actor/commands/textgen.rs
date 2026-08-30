use warpforge_protocol as wire;

use crate::daemon::actor::prompt::build_textgen_prompt;
use crate::daemon::actor::{Command, Daemon};

impl Daemon {
    pub(crate) async fn handle_textgen_command(&mut self, cmd: Command) {
        match cmd {
            Command::GenerateText {
                task_id,
                agent_id,
                kind,
                model,
                account_id,
                input,
                reply,
            } => {
                // Resolve everything that needs actor state up front, then run
                // the (slow) git + agent work off the actor loop.
                let account = match account_id.as_deref() {
                    Some(id) => crate::daemon::accounts::SpawnAccount::Pinned(id),
                    None => crate::daemon::accounts::SpawnAccount::Active,
                };
                let resolved = self.tasks.get(&task_id).map(|task| {
                    let repo = task
                        .worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                        .unwrap_or_else(|| ".".to_string());
                    let command = self.resolve_agent_command(&task.project, &agent_id);
                    let env = self.resolve_agent_env(&agent_id, account);
                    let prompt = task.prompt.clone();
                    (repo, command, prompt, env)
                });
                match resolved {
                    Some((repo, command, prompt, env)) => {
                        tokio::spawn(async move {
                            let message = match kind {
                                wire::TextGenKind::TaskTitle => Some(prompt.as_str()),
                                // A handoff summarises the conversation, and
                                // the client is what knows where to cut it.
                                wire::TextGenKind::Handoff => input.as_deref(),
                                _ => None,
                            };
                            let result = match build_textgen_prompt(&repo, kind, message).await {
                                Ok(prompt) => {
                                    crate::daemon::acp::generate_text(
                                        command, repo, prompt, model, env,
                                    )
                                    .await
                                }
                                Err(e) => Err(e),
                            };
                            let _ = reply.send(result);
                        });
                    }
                    None => {
                        let _ = reply.send(Err(format!("no task {task_id}")));
                    }
                }
            }
            Command::EnhanceText {
                project,
                agent_id,
                prompt,
                model,
                reply,
            } => {
                let resolved = self.project_path(&project).map(|repo| {
                    let command = self.resolve_agent_command(&project, &agent_id);
                    let env = self.resolve_agent_env(
                        &agent_id,
                        crate::daemon::accounts::SpawnAccount::Active,
                    );
                    (repo, command, env)
                });
                match resolved {
                    Some((repo, command, env)) => {
                        let prompt = prompt.clone();
                        tokio::spawn(async move {
                            let result = match build_textgen_prompt(
                                &repo,
                                wire::TextGenKind::EnhancePrompt,
                                Some(&prompt),
                            )
                            .await
                            {
                                Ok(prompt) => {
                                    crate::daemon::acp::generate_text(
                                        command, repo, prompt, model, env,
                                    )
                                    .await
                                }
                                Err(e) => Err(e),
                            };
                            let _ = reply.send(result);
                        });
                    }
                    None => {
                        let _ = reply.send(Err(format!("no project {project}")));
                    }
                }
            }

            other => self.handle_tracker_command(other).await,
        }
    }
}
