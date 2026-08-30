use warpforge_protocol as wire;

use crate::daemon::actor::Daemon;
use crate::daemon::task::TaskStatus;
use crate::daemon::workflow::{self, RunState, StageKind, Verdict, WorkflowOutcome, WorkflowRun};

impl Daemon {
    /// A non-review stage child failed, or a reviewer died. Reviewers are
    /// excluded from the verdict; any other stage failure fails the pipeline.
    /// Park a run whose stage lost its agent, instead of failing it outright.
    ///
    /// Losing the agent process is an infrastructure failure, not a verdict:
    /// the stage never got to say whether the work was good. Failing the run
    /// made that unrecoverable — the pipeline was finished, and a user whose
    /// agent died (or who revived the session by hand and watched it finish the
    /// work) had no way to continue and had to start over. Parking at the
    /// existing pause barrier leaves it resumable, and resume re-runs the stage.
    ///
    /// Mirrors the daemon-restart recovery in `restore_workflow_runs`, down to
    /// warning the re-run that the working copy may already hold partial work.
    pub(crate) fn workflow_park_after_failure(
        &mut self,
        parent_id: &str,
        mut run: WorkflowRun,
        stage: StageKind,
        reason: &str,
    ) {
        run.active_children.clear();
        if stage == StageKind::Review {
            run.review_pending.clear();
            run.review_collected.clear();
            run.reasked.clear();
            // Re-running a review re-increments `round` on spawn; give the
            // abandoned round back or the re-run reports "round 3/2".
            run.round = run.round.saturating_sub(1);
        }
        run.pause_requested = false;
        run.state = RunState::Paused { next: stage };
        run.pending_guidance = Some(format!(
            "The previous attempt of this stage ended before it finished: {reason}. The working \
             copy may already contain its partial changes — inspect the current diff before \
             assuming you are starting from scratch."
        ));
        self.workflow_sync(&run);
        self.workflow_runs.insert(parent_id.to_string(), run);
        self.workflow_timeline(
            parent_id,
            format!(
                "Stage **{}** lost its agent: {reason}. Paused — resume to run it again.",
                stage.label()
            ),
        );
    }

    pub(crate) async fn workflow_child_failed(
        &mut self,
        parent_id: &str,
        mut run: WorkflowRun,
        child_id: &str,
        stage: StageKind,
    ) {
        run.set_record_status(child_id, wire::OrchNodeStatus::Failed);
        if stage == StageKind::Review {
            let index = run.review_pending.remove(child_id);
            run.active_children.remove(child_id);
            run.reasked.remove(child_id);
            let label = index
                .map(|i| run.reviewer_label(i))
                .unwrap_or_else(|| "reviewer".to_string());
            let event_agent = run
                .history
                .iter()
                .rev()
                .find(|record| record.task_id == child_id)
                .map(|record| wire::WorkflowEventAgent {
                    task_id: record.task_id.clone(),
                    label: record.label.clone(),
                    agent: record.agent.clone(),
                    model: index.and_then(|i| run.stage_agent(StageKind::Review, Some(i)).1),
                });
            self.workflow_event(
                parent_id,
                wire::WorkflowEventKind::AgentOutput,
                format!("{label} failed"),
                Some("Excluded from this round's verdict.".to_string()),
                Some(stage),
                event_agent.into_iter().collect(),
                wire::WorkflowEventTone::Error,
            );
            if run.review_pending.is_empty() {
                if run.review_collected.is_empty() {
                    // Every reviewer lost its agent, so the round produced no
                    // verdict at all. That is the same infrastructure failure
                    // as a dead implement stage, not a rejection of the work.
                    self.workflow_park_after_failure(
                        parent_id,
                        run,
                        stage,
                        "every reviewer's agent ended before producing a verdict",
                    );
                } else {
                    self.workflow_merge_reviews(parent_id, run).await;
                }
            } else {
                self.workflow_sync(&run);
                self.workflow_runs.insert(parent_id.to_string(), run);
            }
            return;
        }
        let reason = self
            .tasks
            .get(child_id)
            .and_then(|t| t.blocked_reason.clone())
            .unwrap_or_else(|| "agent session ended unexpectedly".to_string());
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
            parent_id,
            wire::WorkflowEventKind::AgentOutput,
            format!("{} failed", stage.title()),
            Some(reason.clone()),
            Some(stage),
            event_agent.into_iter().collect(),
            wire::WorkflowEventTone::Error,
        );
        self.workflow_park_after_failure(parent_id, run, stage, &reason);
    }

    /// One reviewer's turn ended: parse its verdict, re-ask once on garbage,
    /// and merge the round when every reviewer has resolved.
    pub(crate) async fn workflow_review_finished(
        &mut self,
        parent_id: &str,
        mut run: WorkflowRun,
        child_id: &str,
        output: String,
    ) {
        let Some(index) = run.review_pending.get(child_id).copied() else {
            self.workflow_runs.insert(parent_id.to_string(), run);
            return;
        };
        let label = run.reviewer_label(index);
        match workflow::parse_review_verdict(&output, &label) {
            Ok((verdict, findings)) => {
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
                        model: run.stage_agent(StageKind::Review, Some(index)).1,
                    });
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::ReviewResult,
                    format!(
                        "{label}: {}",
                        match verdict {
                            Verdict::Approve => "approved",
                            Verdict::RequestChanges => "changes requested",
                        },
                    ),
                    Some(workflow::display_output(&output)),
                    Some(StageKind::Review),
                    event_agent.into_iter().collect(),
                    match verdict {
                        Verdict::Approve => wire::WorkflowEventTone::Success,
                        Verdict::RequestChanges => wire::WorkflowEventTone::Warning,
                    },
                );
                run.review_pending.remove(child_id);
                run.active_children.remove(child_id);
                run.set_record_status(child_id, wire::OrchNodeStatus::Complete);
                run.review_collected.push((index, verdict, findings));
                if run.review_pending.is_empty() {
                    self.workflow_merge_reviews(parent_id, run).await;
                } else {
                    self.workflow_sync(&run);
                    self.workflow_runs.insert(parent_id.to_string(), run);
                }
            }
            Err(reason) => {
                let event_agent = run
                    .history
                    .iter()
                    .rev()
                    .find(|record| record.task_id == child_id)
                    .map(|record| wire::WorkflowEventAgent {
                        task_id: record.task_id.clone(),
                        label: record.label.clone(),
                        agent: record.agent.clone(),
                        model: run.stage_agent(StageKind::Review, Some(index)).1,
                    });
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::AgentOutput,
                    format!("{label}: invalid review response"),
                    Some(workflow::display_output(&output)),
                    Some(StageKind::Review),
                    event_agent.into_iter().collect(),
                    wire::WorkflowEventTone::Warning,
                );
                let asked = run.reasked.entry(child_id.to_string()).or_insert(0);
                if *asked < workflow::MAX_VERDICT_REASKS {
                    *asked += 1;
                    let reask = workflow::reask_verdict_prompt(&reason);
                    if self.workflow_followup(child_id, reask) {
                        self.mark_task_running(child_id);
                        self.workflow_timeline(
                            parent_id,
                            format!("{label} returned no parseable verdict — asking again."),
                        );
                        self.workflow_runs.insert(parent_id.to_string(), run);
                        return;
                    }
                    // Dead session: fall through to the failure path.
                }
                self.workflow_runs.insert(parent_id.to_string(), run);
                // Treat a reviewer that cannot produce a parseable verdict the
                // same way as one whose process died: abstain from this round.
                // Failing the whole pipeline because one agent wrote prose
                // twice would throw away a complete implementation.
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::AgentOutput,
                    format!("{label} abstained"),
                    Some(format!(
                        "No parseable verdict after a retry ({reason}) — excluded from this \
                         round's verdict."
                    )),
                    Some(StageKind::Review),
                    Vec::new(),
                    wire::WorkflowEventTone::Warning,
                );
                let Some(mut run) = self.workflow_runs.remove(parent_id) else {
                    return;
                };
                run.review_pending.remove(child_id);
                run.active_children.remove(child_id);
                run.reasked.remove(child_id);
                run.set_record_status(child_id, wire::OrchNodeStatus::Failed);
                self.workflow_set_child_status(child_id, TaskStatus::Waiting);
                if run.review_pending.is_empty() {
                    if run.review_collected.is_empty() {
                        self.workflow_runs.insert(parent_id.to_string(), run);
                        let _ = self
                            .workflow_finalize(
                                parent_id,
                                WorkflowOutcome::Error(
                                    "no reviewer produced a usable verdict".to_string(),
                                ),
                            )
                            .await;
                    } else {
                        self.workflow_merge_reviews(parent_id, run).await;
                    }
                } else {
                    self.workflow_sync(&run);
                    self.workflow_runs.insert(parent_id.to_string(), run);
                }
            }
        }
    }

    /// All reviewers of a round resolved: merge, then approve / fix / limit.
    pub(crate) async fn workflow_merge_reviews(&mut self, parent_id: &str, mut run: WorkflowRun) {
        let (verdict, findings) = workflow::merge_reviews(&run.review_collected);
        run.review_collected.clear();
        run.last_verdict = Some(verdict);
        let (to_fix, low): (Vec<_>, Vec<_>) =
            findings.into_iter().partition(|f| f.severity.goes_to_fix());
        run.deferred_findings.extend(low);
        match verdict {
            Verdict::Approve => {
                self.workflow_timeline(
                    parent_id,
                    format!("Review round {}: **approved**.", run.round),
                );
                run.open_findings.clear();
                self.workflow_runs.insert(parent_id.to_string(), run);
                let _ = self
                    .workflow_finalize(parent_id, WorkflowOutcome::Success { limit_hit: false })
                    .await;
            }
            Verdict::RequestChanges if to_fix.is_empty() => {
                // Changes requested but every finding is low-severity — there
                // is nothing for the fixer to do. Finish with notes.
                self.workflow_timeline(
                    parent_id,
                    format!(
                        "Review round {}: changes requested, but only low-severity notes remain — finishing.",
                        run.round
                    ),
                );
                run.open_findings.clear();
                self.workflow_runs.insert(parent_id.to_string(), run);
                let _ = self
                    .workflow_finalize(parent_id, WorkflowOutcome::Success { limit_hit: false })
                    .await;
            }
            Verdict::RequestChanges => {
                run.open_findings = to_fix;
                self.workflow_timeline(
                    parent_id,
                    format!(
                        "Review round {}: **changes requested** — {}.\n\n{}",
                        run.round,
                        workflow::summarize_findings(&run.open_findings),
                        workflow::format_findings(&run.open_findings),
                    ),
                );
                if run.round < run.effective_max_rounds() {
                    self.workflow_runs.insert(parent_id.to_string(), run);
                    self.workflow_advance(parent_id, StageKind::Fix).await;
                } else {
                    match run.spec.review.on_limit {
                        crate::workflow_config::OnLimit::Ask => {
                            run.state = RunState::AwaitingLimitDecision;
                            self.workflow_timeline(
                                parent_id,
                                format!(
                                    "Review limit reached ({} rounds) with {}. What next — extend \
                                     the rounds, finish as is, or stop? You can add guidance for \
                                     the next fix attempt.",
                                    run.effective_max_rounds(),
                                    workflow::summarize_findings(&run.open_findings),
                                ),
                            );
                            self.workflow_sync(&run);
                            self.workflow_runs.insert(parent_id.to_string(), run);
                        }
                        crate::workflow_config::OnLimit::Finish => {
                            self.workflow_runs.insert(parent_id.to_string(), run);
                            let _ = self
                                .workflow_finalize(
                                    parent_id,
                                    WorkflowOutcome::Success { limit_hit: true },
                                )
                                .await;
                        }
                    }
                }
            }
        }
    }
}
