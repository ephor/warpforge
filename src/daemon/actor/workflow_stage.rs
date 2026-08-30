use std::collections::HashMap;

use anyhow::Result;

use warpforge_protocol as wire;

use crate::daemon::actor::transcript::StageText;
use crate::daemon::actor::{Daemon, Event};
use crate::daemon::task::{Task, TaskStatus};
use crate::daemon::workflow::{self, RunState, StageKind, StageSignal, WorkflowOutcome};

impl Daemon {
    pub(crate) async fn workflow_spawn_stage(&mut self, parent_id: &str, stage: StageKind) {
        let Some(mut run) = self.workflow_runs.remove(parent_id) else {
            return;
        };
        let Some(parent) = self.tasks.get(parent_id) else {
            self.workflow_runs.insert(parent_id.to_string(), run);
            return;
        };
        let parent_prompt = parent.prompt.clone();
        let parent_title = parent.title.clone();
        let worktree = parent.worktree.clone();
        let project = run.project.clone();

        if stage == StageKind::Review {
            run.round += 1;
        }
        let guidance = match stage {
            StageKind::Review => None,
            _ => run.take_guidance(),
        };
        // Review and fix stages see the current working-copy diff.
        let diff = match stage {
            StageKind::Review | StageKind::Fix => {
                let dir = worktree.clone().or_else(|| self.project_path(&project));
                match dir {
                    Some(dir) => match crate::daemon::diff::working_diff(&dir).await {
                        Ok(files) => Some(workflow::format_diff(&files)),
                        Err(e) => Some(format!("(diff unavailable: {e})")),
                    },
                    None => None,
                }
            }
            _ => None,
        };
        let ctx = workflow::PromptCtx {
            task_prompt: parent_prompt,
            plan: run.plan_output.clone(),
            implementer_summary: run.last_summary.as_deref().map(workflow::clip_summary),
            diff,
            findings: match stage {
                StageKind::Fix => Some(workflow::format_findings(&run.open_findings)),
                _ => None,
            },
            prior_findings: match stage {
                // On a repeat round `open_findings` still holds what the last
                // review raised — the next reviewers must verify each item.
                StageKind::Review if run.round > 1 && !run.open_findings.is_empty() => {
                    Some(workflow::format_findings(&run.open_findings))
                }
                _ => None,
            },
            round: run.round,
            max_rounds: run.effective_max_rounds(),
            guidance,
        };
        // The dialog's attachments ride along with the very first stage only.
        let attachments = if run.history.is_empty() {
            std::mem::take(&mut run.attachments)
        } else {
            Vec::new()
        };

        run.state = RunState::Running { stage };
        match stage {
            StageKind::Review => {
                run.review_pending.clear();
                run.review_collected.clear();
                run.reasked.clear();
                let round_label = format!("round {}/{}", run.round, run.effective_max_rounds());
                // Repeat rounds follow up in the previous reviewers' live
                // sessions (review.reask: same_session, the default): the
                // reviewer remembers its own findings and verifies each one
                // instead of re-reviewing from scratch. A dead session falls
                // back to a fresh spawn whose prompt carries those findings.
                let reuse_sessions = run.round > 1
                    && run.spec.review.reask == crate::workflow_config::ReaskMode::SameSession;
                let mut event_agents = Vec::with_capacity(run.spec.review.reviewers.len());
                let mut reused = 0usize;
                for index in 0..run.spec.review.reviewers.len() {
                    let (agent, model) = run.stage_agent(stage, Some(index));
                    let label = run.reviewer_label(index);
                    if reuse_sessions {
                        if let Some(prior_id) = run.prior_review_children.get(&index).cloned() {
                            let followup = workflow::build_rereview_prompt(&ctx);
                            if self.workflow_followup(&prior_id, followup) {
                                // The child was parked Done after its verdict;
                                // the generic mark_task_running refuses Done
                                // tasks, so flip it explicitly.
                                self.workflow_set_child_status(&prior_id, TaskStatus::Running);
                                run.review_pending.insert(prior_id.clone(), index);
                                run.active_children.insert(prior_id.clone(), stage);
                                run.record_stage(
                                    stage,
                                    &prior_id,
                                    &agent,
                                    format!("{label}, {round_label}"),
                                );
                                event_agents.push(wire::WorkflowEventAgent {
                                    task_id: prior_id,
                                    label,
                                    agent,
                                    model,
                                });
                                reused += 1;
                                continue;
                            }
                        }
                    }
                    let prompt = workflow::build_reviewer_prompt(&run.spec, index, &ctx);
                    let spawned = self.workflow_spawn_child(
                        &run.project,
                        parent_id,
                        &agent,
                        model.clone(),
                        prompt,
                        worktree.clone(),
                        format!("review · {parent_title}"),
                        Vec::new(),
                        run.include_runtime_context,
                        run.config_overrides.clone(),
                    );
                    // A reviewer whose session never started is recorded as a
                    // failed node and excluded, exactly like one that dies
                    // mid-review — it must not sit in `review_pending` waiting
                    // for a TurnEnded that can never arrive.
                    let (child_id, started) = match spawned {
                        Ok(id) => (id, true),
                        Err(id) => (id, false),
                    };
                    run.record_stage(stage, &child_id, &agent, format!("{label}, {round_label}"));
                    if started {
                        run.review_pending.insert(child_id.clone(), index);
                        run.active_children.insert(child_id.clone(), stage);
                    } else {
                        run.set_record_status(&child_id, wire::OrchNodeStatus::Failed);
                    }
                    event_agents.push(wire::WorkflowEventAgent {
                        task_id: child_id,
                        label,
                        agent,
                        model,
                    });
                }
                // Remember this round's staffing for the next reask.
                run.prior_review_children = run
                    .review_pending
                    .iter()
                    .map(|(child, index)| (*index, child.clone()))
                    .collect();
                let detail = if reused > 0 {
                    format!(
                        "{} reviewer(s) running; {reused} continuing their previous session to \
                         verify their own findings.",
                        run.review_pending.len()
                    )
                } else {
                    format!("{} reviewer(s) running.", run.review_pending.len())
                };
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::StageStarted,
                    format!("Review {round_label} started"),
                    Some(detail),
                    Some(stage),
                    event_agents,
                    wire::WorkflowEventTone::Running,
                );
            }
            _ => {
                let (agent, model) = run.stage_agent(stage, None);
                let prompt = match stage {
                    StageKind::Plan => workflow::build_plan_prompt(&run.spec, &ctx),
                    StageKind::Implement => workflow::build_implement_prompt(&run.spec, &ctx),
                    StageKind::Fix => workflow::build_fix_prompt(&run.spec, &ctx),
                    StageKind::Review => unreachable!(),
                };
                let spawned = self.workflow_spawn_child(
                    &run.project,
                    parent_id,
                    &agent,
                    model.clone(),
                    prompt,
                    worktree.clone(),
                    format!("{} · {parent_title}", stage.label()),
                    attachments,
                    run.include_runtime_context,
                    run.config_overrides.clone(),
                );
                let label = match stage {
                    StageKind::Fix => format!("{} (round {})", stage.label(), run.round),
                    _ => stage.label().to_string(),
                };
                let child_id = match spawned {
                    Ok(id) => {
                        run.active_children.insert(id.clone(), stage);
                        run.record_stage(stage, &id, &agent, label.clone());
                        id
                    }
                    Err(id) => {
                        // No session means no TurnEnded will ever arrive, so
                        // fail the pipeline here instead of hanging in
                        // "running" until the user cancels.
                        run.record_stage(stage, &id, &agent, label.clone());
                        run.set_record_status(&id, wire::OrchNodeStatus::Failed);
                        let reason = self
                            .tasks
                            .get(&id)
                            .and_then(|t| t.blocked_reason.clone())
                            .unwrap_or_else(|| {
                                "the agent session could not be started".to_string()
                            });
                        self.workflow_runs.insert(parent_id.to_string(), run);
                        let _ = self
                            .workflow_finalize(
                                parent_id,
                                WorkflowOutcome::Error(format!(
                                    "stage {} could not start: {reason}",
                                    stage.label()
                                )),
                            )
                            .await;
                        return;
                    }
                };
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::StageStarted,
                    format!("{} started", stage.title()),
                    None,
                    Some(stage),
                    vec![wire::WorkflowEventAgent {
                        task_id: child_id,
                        label,
                        agent,
                        model,
                    }],
                    wire::WorkflowEventTone::Running,
                );
            }
        }
        self.workflow_sync(&run);
        self.workflow_runs.insert(parent_id.to_string(), run);
    }

    /// Create and start one stage child task. Children run in the parent's
    /// directory (its worktree when isolated) but are NOT registered in the
    /// worktree manager — the parent owns the worktree's lifecycle.
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::result_large_err)]
    pub(crate) fn workflow_spawn_child(
        &mut self,
        project: &str,
        parent_id: &str,
        agent: &str,
        model: Option<String>,
        prompt: String,
        worktree: Option<String>,
        title: String,
        attachments: Vec<wire::PromptAttachment>,
        include_runtime_context: bool,
        config_overrides: HashMap<String, String>,
    ) -> Result<String, String> {
        let mut task = Task::new(project, &prompt, agent, vec!["workflow-stage".to_string()]);
        task.parent_task_id = Some(parent_id.to_string());
        task.worktree = worktree;
        task.title = title;
        // The stage pin (or inherited lead model) is the child's model intent.
        task.model = model.clone();
        let child_id = task.id.clone();
        self.tasks.insert(child_id.clone(), task.clone());
        self.persist(&task);
        self.emit(Event::TaskCreated(task));
        self.start_session(
            &child_id,
            project,
            agent,
            &prompt,
            include_runtime_context,
            None,
            attachments,
            model,
            config_overrides,
        );
        // `start_session` reports prompt-preparation and spawn failures by
        // blocking the child task and inserting no handle. Without a session
        // there is no TurnEnded to advance the pipeline, so the caller must
        // learn about it here or the parent hangs in "running" forever.
        if self.sessions.contains_key(&child_id) {
            Ok(child_id)
        } else {
            Err(child_id)
        }
    }

    /// A stage child's turn ended (or its session died). Advance the pipeline.
    pub(crate) async fn workflow_stage_finished(
        &mut self,
        child_id: &str,
        success: bool,
        text: StageText,
    ) {
        // Prefer the closing message: it is the agent's actual result, and
        // reading it instead of the whole turn means a JSON block quoted
        // mid-turn (while browsing a config file, say) cannot be mistaken for
        // the protocol payload. Fall back to the full turn only when the
        // payload genuinely is not in the closing message — an agent that
        // emitted its block and then made one last tool call.
        let closing_is_usable = !text.closing.trim().is_empty()
            && (workflow::has_protocol_payload(&text.closing)
                || !workflow::has_protocol_payload(&text.full));
        let output = if closing_is_usable {
            text.closing.clone()
        } else {
            text.full.clone()
        };
        let Some(parent_id) = self.workflow_child_of(child_id) else {
            return;
        };
        let Some(mut run) = self.workflow_runs.remove(&parent_id) else {
            return;
        };
        let stage = match run.active_children.get(child_id) {
            Some(stage) => *stage,
            None => {
                self.workflow_runs.insert(parent_id.clone(), run);
                return;
            }
        };
        // Only a running stage advances the pipeline: a turn that ends while
        // we await a reply is the answered child continuing, handled below.
        let running_stage = matches!(run.state, RunState::Running { stage: s } if s == stage);
        let awaiting_this_child =
            matches!(&run.state, RunState::AwaitingReply { child, .. } if child == child_id);
        if !running_stage && !awaiting_this_child {
            self.workflow_runs.insert(parent_id.clone(), run);
            return;
        }

        if !success {
            self.workflow_child_failed(&parent_id, run, child_id, stage)
                .await;
            return;
        }

        match stage {
            StageKind::Review => {
                self.workflow_review_finished(&parent_id, run, child_id, output)
                    .await;
            }
            StageKind::Plan | StageKind::Implement | StageKind::Fix => {
                match workflow::parse_stage_signal(&output) {
                    StageSignal::Question(question) => {
                        run.state = RunState::AwaitingReply {
                            stage,
                            child: child_id.to_string(),
                            question: question.clone(),
                        };
                        self.workflow_set_child_status(child_id, TaskStatus::Waiting);
                        let event_agent = run
                            .history
                            .iter()
                            .rev()
                            .find(|record| record.task_id == child_id)
                            .map(|record| wire::WorkflowEventAgent {
                                task_id: record.task_id.clone(),
                                label: record.label.clone(),
                                agent: record.agent.clone(),
                                model: run.stage_agent(stage, None).1,
                            });
                        self.workflow_event(
                            &parent_id,
                            wire::WorkflowEventKind::AgentOutput,
                            format!("{} needs your input", stage.title()),
                            Some(workflow::display_output(&output)),
                            Some(stage),
                            event_agent.into_iter().collect(),
                            wire::WorkflowEventTone::Warning,
                        );
                        self.workflow_sync(&run);
                        self.workflow_runs.insert(parent_id.clone(), run);
                    }
                    StageSignal::Output => {
                        run.active_children.remove(child_id);
                        run.set_record_status(child_id, wire::OrchNodeStatus::Complete);
                        self.workflow_set_child_status(child_id, TaskStatus::Done);
                        let event_agent = run
                            .history
                            .iter()
                            .rev()
                            .find(|record| record.task_id == child_id)
                            .map(|record| wire::WorkflowEventAgent {
                                task_id: record.task_id.clone(),
                                label: record.label.clone(),
                                agent: record.agent.clone(),
                                model: run.stage_agent(stage, None).1,
                            });
                        match stage {
                            StageKind::Plan => run.plan_output = Some(output.clone()),
                            _ => run.last_summary = Some(output.clone()),
                        }
                        self.workflow_event(
                            &parent_id,
                            wire::WorkflowEventKind::AgentOutput,
                            format!("{} completed", stage.title()),
                            Some(workflow::display_output(&output)),
                            Some(stage),
                            event_agent.into_iter().collect(),
                            wire::WorkflowEventTone::Success,
                        );
                        let next = stage.successor().unwrap_or(StageKind::Review);
                        self.workflow_runs.insert(parent_id.clone(), run);
                        self.workflow_advance(&parent_id, next).await;
                    }
                }
            }
        }
    }
}
