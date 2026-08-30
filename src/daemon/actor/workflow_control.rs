use anyhow::Result;

use warpforge_protocol as wire;

use crate::daemon::actor::transcript::StageText;
use crate::daemon::actor::{Daemon, Event};
use crate::daemon::task::TaskStatus;
use crate::daemon::workflow::{self, RunState, StageKind, WorkflowOutcome, WorkflowRun};

impl Daemon {
    /// Stage barrier: honour a pending pause request, otherwise start `next`.
    pub(crate) async fn workflow_advance(&mut self, parent_id: &str, next: StageKind) {
        let paused = {
            let Some(run) = self.workflow_runs.get_mut(parent_id) else {
                return;
            };
            if run.pause_requested {
                run.pause_requested = false;
                run.state = RunState::Paused { next };
                true
            } else {
                false
            }
        };
        if paused {
            self.workflow_timeline(
                parent_id,
                format!(
                    "Paused before stage **{}**. Resume to continue; you can add guidance.",
                    next.label()
                ),
            );
            let run = self.workflow_runs.get(parent_id).cloned();
            if let Some(run) = run {
                self.workflow_sync(&run);
            }
        } else {
            self.workflow_spawn_stage(parent_id, next).await;
        }
    }

    /// Kill the run's stage sessions, wait until their processes have exited,
    /// and mark the still-active children Interrupted. Completed stages keep
    /// their sessions alive during the run (same-session re-review follows up
    /// in them), so the sweep covers every child the run ever spawned — not
    /// just the active ones.
    pub(crate) async fn workflow_stop_children(
        &mut self,
        run: &mut WorkflowRun,
    ) -> Result<(), String> {
        let active: Vec<String> = run.active_children.keys().cloned().collect();
        let mut handles = Vec::new();
        for child_id in run.all_children() {
            if let Some(handle) = self.sessions.remove(&child_id) {
                handle.cancel();
                handles.push(handle);
            }
            self.pending_permissions.cleanup_task(&child_id);
        }
        // Only in-flight stages get their record and task status rewritten;
        // completed ones keep their Done/Complete state.
        for child_id in active {
            run.set_record_status(&child_id, wire::OrchNodeStatus::Skipped);
            if let Some(task) = self.tasks.get_mut(&child_id) {
                if task.status == TaskStatus::Running || task.status == TaskStatus::Queued {
                    task.set_status(TaskStatus::Interrupted);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
        // Signal every parallel reviewer before awaiting any one of them.
        let mut stop_error = None;
        for handle in handles {
            if let Err(error) = handle
                .wait_for_exit_within(crate::daemon::acp::STOP_GRACE)
                .await
            {
                stop_error.get_or_insert(error);
            }
        }
        run.active_children.clear();
        run.review_pending.clear();
        match stop_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// End the pipeline: stop children, write the summary, set the parent's
    /// final status.
    pub(crate) async fn workflow_finalize(
        &mut self,
        parent_id: &str,
        outcome: WorkflowOutcome,
    ) -> Result<(), String> {
        let Some(mut run) = self.workflow_runs.remove(parent_id) else {
            return Ok(());
        };
        if !run.is_active() {
            self.workflow_runs.insert(parent_id.to_string(), run);
            return Ok(());
        }
        let stop_result = self.workflow_stop_children(&mut run).await;

        let mut summary = String::new();
        let rounds_used = run.round;
        match &outcome {
            WorkflowOutcome::Success { limit_hit } => {
                run.state = RunState::Done;
                summary.push_str(&format!(
                    "Workflow **{}** finished after {rounds_used} review round(s).",
                    run.spec.name
                ));
                if *limit_hit {
                    summary.push_str(&format!(
                        "\n\n⚠ Review limit reached with unresolved findings:\n{}",
                        workflow::format_findings(&run.open_findings)
                    ));
                }
                if !run.deferred_findings.is_empty() {
                    summary.push_str(&format!(
                        "\n\nLow-severity notes from review (not auto-fixed):\n{}",
                        workflow::format_findings(&run.deferred_findings)
                    ));
                }
                summary.push_str("\n\nReview the changes and commit when ready.");
            }
            WorkflowOutcome::Stopped => {
                run.state = RunState::Failed;
                summary.push_str(&format!("Workflow **{}** stopped.", run.spec.name));
            }
            WorkflowOutcome::Error(reason) => {
                run.state = RunState::Failed;
                summary.push_str(&format!(
                    "Workflow **{}** failed: {reason}. Changes made so far remain in the \
                     working copy.",
                    run.spec.name
                ));
            }
        }
        // A pipeline spawned via spawn_workflow (parent_task_id set) reports
        // to its orchestrator's inbox the same way a plain sub-agent does;
        // deliver_child_result no-ops when there is no parent.
        let success = matches!(outcome, WorkflowOutcome::Success { .. });
        self.deliver_child_result(parent_id, success, summary.clone());
        self.workflow_timeline(parent_id, summary);

        if let Some(task) = self.tasks.get_mut(parent_id) {
            match &outcome {
                WorkflowOutcome::Success { .. } => task.set_status(TaskStatus::Waiting),
                WorkflowOutcome::Stopped => task.set_status(TaskStatus::Interrupted),
                WorkflowOutcome::Error(reason) => {
                    task.blocked_reason = Some(reason.clone());
                    task.set_status(TaskStatus::Blocked);
                }
            }
        }
        self.workflow_sync(&run);
        self.workflow_runs.insert(parent_id.to_string(), run);
        // The state transition succeeded even if a stage process was slow to
        // die; surfacing teardown trouble as the RPC's error would make a
        // completed decision look rejected.
        if let Err(error) = stop_result {
            self.workflow_timeline(
                parent_id,
                format!("Note: a stage agent did not shut down cleanly ({error})."),
            );
        }
        Ok(())
    }

    /// A stage child task was cancelled or deleted out from under the run.
    pub(crate) async fn workflow_child_gone(&mut self, child_id: &str) {
        if self.workflow_child_of(child_id).is_some() {
            self.workflow_stage_finished(child_id, false, StageText::default())
                .await;
        }
    }

    // ── User-facing controls (workflow.pause / resume / reply / decide) ──

    pub(crate) fn workflow_pause(&mut self, parent_id: &str) -> Result<(), String> {
        let Some(run) = self.workflow_runs.get_mut(parent_id) else {
            return Err("no workflow pipeline on this task".to_string());
        };
        match run.state {
            RunState::Running { .. } => {
                if run.pause_requested {
                    return Err("pause already requested".to_string());
                }
                run.pause_requested = true;
                self.workflow_timeline(
                    parent_id,
                    "Pause requested — takes effect when the current stage finishes its turn.",
                );
                let run = self.workflow_runs.get(parent_id).cloned();
                if let Some(run) = run {
                    self.workflow_sync(&run);
                }
                Ok(())
            }
            RunState::Paused { .. } => Err("already paused".to_string()),
            RunState::AwaitingReply { .. } | RunState::AwaitingLimitDecision => {
                Err("the pipeline is already waiting for your input".to_string())
            }
            RunState::Done | RunState::Failed => Err("the pipeline has finished".to_string()),
        }
    }

    pub(crate) async fn workflow_resume(
        &mut self,
        parent_id: &str,
        note: Option<String>,
    ) -> Result<(), String> {
        let next = {
            let Some(run) = self.workflow_runs.get_mut(parent_id) else {
                return Err("no workflow pipeline on this task".to_string());
            };
            let RunState::Paused { next } = run.state else {
                return Err("the pipeline is not paused".to_string());
            };
            run.pause_requested = false;
            if let Some(note) = note.filter(|n| !n.trim().is_empty()) {
                self.emit_session(
                    parent_id,
                    wire::SessionUpdate::UserMessage {
                        text: note.clone(),
                        attachments: vec![],
                    },
                );
                let run = self.workflow_runs.get_mut(parent_id).unwrap();
                run.pending_guidance = Some(note);
            }
            next
        };
        self.workflow_timeline(parent_id, "Resumed.");
        self.workflow_spawn_stage(parent_id, next).await;
        Ok(())
    }

    pub(crate) async fn workflow_reply(
        &mut self,
        parent_id: &str,
        message: String,
    ) -> Result<(), String> {
        let (stage, child) = {
            let Some(run) = self.workflow_runs.get(parent_id) else {
                return Err("no workflow pipeline on this task".to_string());
            };
            match &run.state {
                RunState::AwaitingReply { stage, child, .. } => (*stage, child.clone()),
                _ => return Err("the pipeline is not waiting for an answer".to_string()),
            }
        };
        // Show the user's answer in the parent timeline either way.
        self.emit_session(
            parent_id,
            wire::SessionUpdate::UserMessage {
                text: message.clone(),
                attachments: vec![],
            },
        );
        if self.workflow_followup(&child, message.clone()) {
            self.mark_task_running(&child);
            if let Some(run) = self.workflow_runs.get_mut(parent_id) {
                run.state = RunState::Running { stage };
            }
            self.workflow_timeline(
                parent_id,
                format!("Answer delivered — stage **{}** continues.", stage.label()),
            );
            let run = self.workflow_runs.get(parent_id).cloned();
            if let Some(run) = run {
                self.workflow_sync(&run);
            }
        } else {
            // The asking session is gone (daemon restarted, agent died). Re-run
            // the stage with the question + answer as guidance instead.
            let question = {
                let run = self.workflow_runs.get_mut(parent_id).unwrap();
                let question = match &run.state {
                    RunState::AwaitingReply { question, .. } => question.clone(),
                    _ => String::new(),
                };
                run.active_children.remove(&child);
                run.set_record_status(&child, wire::OrchNodeStatus::Skipped);
                run.pending_guidance = Some(format!(
                    "The previous attempt of this stage asked:\n> {question}\n\nUser's answer:\n{message}"
                ));
                question
            };
            let _ = question;
            self.workflow_timeline(
                parent_id,
                format!(
                    "The asking session is no longer alive — re-running stage **{}** with your \
                     answer as guidance.",
                    stage.label()
                ),
            );
            self.workflow_spawn_stage(parent_id, stage).await;
        }
        Ok(())
    }

    pub(crate) async fn workflow_decide(
        &mut self,
        parent_id: &str,
        decision: wire::WorkflowDecision,
        rounds: Option<u32>,
        note: Option<String>,
    ) -> Result<(), String> {
        {
            let Some(run) = self.workflow_runs.get(parent_id) else {
                return Err("no workflow pipeline on this task".to_string());
            };
            if run.state != RunState::AwaitingLimitDecision {
                return Err("the pipeline is not waiting for a limit decision".to_string());
            }
        }
        match decision {
            wire::WorkflowDecision::Extend => {
                let granted = rounds.unwrap_or(1).clamp(1, workflow::MAX_EXTEND_ROUNDS);
                let guidance = note.filter(|note| !note.trim().is_empty());
                if let Some(message) = guidance.as_ref() {
                    self.emit_session(
                        parent_id,
                        wire::SessionUpdate::UserMessage {
                            text: message.clone(),
                            attachments: vec![],
                        },
                    );
                }
                {
                    let run = self.workflow_runs.get_mut(parent_id).unwrap();
                    run.extra_rounds += granted;
                    run.pending_guidance = guidance;
                    // Asking for more rounds supersedes a pause requested
                    // while the last review was still running; otherwise the
                    // next stage would park immediately after we just said
                    // "continuing with a fix".
                    run.pause_requested = false;
                }
                self.workflow_timeline(
                    parent_id,
                    format!("You granted {granted} more review round(s) — continuing with a fix."),
                );
                self.workflow_advance(parent_id, StageKind::Fix).await;
                Ok(())
            }
            wire::WorkflowDecision::Finish => {
                self.workflow_timeline(parent_id, "You chose to finish with the open findings.");
                self.workflow_finalize(parent_id, WorkflowOutcome::Success { limit_hit: true })
                    .await?;
                Ok(())
            }
            wire::WorkflowDecision::Stop => {
                self.workflow_finalize(parent_id, WorkflowOutcome::Stopped)
                    .await?;
                Ok(())
            }
        }
    }
}
