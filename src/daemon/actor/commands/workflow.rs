use tokio::sync::oneshot;

use crate::daemon::actor::{Command, Daemon};
use crate::daemon::runtime::Write as PersistWrite;

impl Daemon {
    pub(crate) async fn handle_workflow_command(&mut self, cmd: Command) {
        match cmd {
            Command::CreateWorkflowTask {
                project,
                prompt,
                agent,
                tags,
                worktree,
                workflow,
                attachments,
                default_model,
                include_runtime_context,
                config_overrides,
                parent_task_id,
                reply,
            } => {
                let result = self
                    .workflow_create(
                        project,
                        prompt,
                        agent,
                        tags,
                        worktree,
                        workflow,
                        attachments,
                        default_model,
                        include_runtime_context,
                        config_overrides,
                        parent_task_id,
                    )
                    .await;
                let _ = reply.send(result);
            }
            Command::WorkflowPause { task, reply } => {
                let _ = reply.send(self.workflow_pause(&task));
            }
            Command::WorkflowResume { task, note, reply } => {
                let _ = reply.send(self.workflow_resume(&task, note).await);
            }
            Command::WorkflowReply {
                task,
                message,
                reply,
            } => {
                let _ = reply.send(self.workflow_reply(&task, message).await);
            }
            Command::WorkflowDecide {
                task,
                decision,
                rounds,
                note,
                reply,
            } => {
                let _ = reply.send(self.workflow_decide(&task, decision, rounds, note).await);
            }

            Command::StartOrchestration {
                project,
                goal,
                reply,
            } => {
                if let Some(orch_tx) = &self.orch_tx {
                    // Spawn — the orchestrator will call back into the daemon
                    // (create_task) which would deadlock if we blocked here.
                    let orch_tx = orch_tx.clone();
                    tokio::spawn(async move {
                        let (rtx, rrx) = oneshot::channel();
                        let _ = orch_tx
                            .send(crate::orchestration::OrchCommand::StartPlan {
                                project,
                                goal,
                                reply: rtx,
                            })
                            .await;
                        let result = rrx.await.unwrap_or_default();
                        let _ = reply.send(result);
                    });
                } else {
                    let _ = reply.send((String::new(), String::new()));
                }
            }
            Command::ListOrchestrations { reply } => {
                if let Some(orch_tx) = &self.orch_tx {
                    let (rtx, rrx) = oneshot::channel();
                    let _ = orch_tx
                        .send(crate::orchestration::OrchCommand::List(rtx))
                        .await;
                    let infos = rrx.await.unwrap_or_default();
                    let _ = reply.send(infos);
                } else {
                    let _ = reply.send(vec![]);
                }
            }
            Command::GetOrchestratorConfig { reply } => {
                let dto = self.orch_config.clone().into();
                let _ = reply.send(dto);
            }
            Command::SaveOrchestratorConfig { config, reply } => {
                self.orch_config = config.into();
                self.persist
                    .write(PersistWrite::OrchestratorConfig(Box::new(
                        self.orch_config.clone(),
                    )));
                let _ = reply.send(true);
            }

            other => self.handle_textgen_command(other).await,
        }
    }
}
