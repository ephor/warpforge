//! Run lifecycle: the scheduler tick, precheck gating, dispatch into real
//! daemon tasks, and the turn-end path that closes a run out. Row-level
//! bookkeeping lives in [`super::bookkeeping`].

use tokio::sync::oneshot;

use warpforge_protocol as wire;

use super::bookkeeping::TICK_SECS;
use super::now_secs;
use crate::daemon::actor::{Command, Daemon};
use crate::daemon::automations as sched;
use crate::daemon::runtime::Write as PersistWrite;

const RUN_OUTPUT_EXCERPT: usize = 4096;

/// Prefix every dispatched prompt with the run's context. A `reuse_session`
/// automation sends the same text into the same conversation forever, and
/// without this the agent reads the repeat as a person asking again — it
/// answers with clarifying questions nobody is there to read.
fn marked_prompt(a: &wire::Automation, run_number: u64) -> String {
    format!(
        "[scheduled automation \"{}\", run #{run_number} — unattended: nobody will \
answer follow-ups; deliver the result in your final message, do not ask questions]\n\n{}",
        a.name, a.prompt
    )
}

impl Daemon {
    pub(super) fn automation_run_linked(
        &mut self,
        a: wire::Automation,
        run_id: &str,
        reused: bool,
        result: Result<String, String>,
    ) {
        let Some(mut run) = self.load_run(run_id) else {
            self.automation_active.remove(&a.id);
            self.automation_run_owner.remove(run_id);
            return;
        };
        match result {
            Ok(task_id) => {
                // start_session reports prompt-preparation and spawn failures
                // by blocking the task and inserting no handle — the same
                // shape a workflow stage child fails on. Without a session
                // there is no turn end to close the run, so fail it here
                // instead of leaving it Running forever. A reused dispatch
                // skips this: SessionPrompt may resume an on-disk session
                // whose handle lands in the map only after the reply, and
                // the existing session is what guarantees a turn end.
                if !reused && !self.sessions.contains_key(&task_id) {
                    let reason = self
                        .tasks
                        .get(&task_id)
                        .and_then(|t| t.blocked_reason.clone())
                        .unwrap_or_else(|| "the agent session could not be started".to_string());
                    let mut run = self.load_run(run_id);
                    if let Some(run) = run.as_mut() {
                        run.status = wire::AutomationRunStatus::Failed;
                        run.finished_at = Some(now_secs());
                        run.task_id = Some(task_id);
                        run.error = Some(reason);
                        self.persist_run(run);
                        self.record_last_run(&a, run);
                    }
                    self.automation_active.remove(&a.id);
                    self.automation_run_owner.remove(run_id);
                    return;
                }
                run.status = wire::AutomationRunStatus::Running;
                run.task_id = Some(task_id.clone());
                self.automation_run_tasks
                    .insert(task_id.clone(), run.id.clone());
                self.persist_run(&run);
                let mut automation = a;
                automation.last_task_id = Some(task_id);
                self.record_last_run(&automation, &run);
            }
            Err(error) => {
                run.status = wire::AutomationRunStatus::Failed;
                run.finished_at = Some(now_secs());
                run.error = Some(error);
                self.persist_run(&run);
                self.record_last_run(&a, &run);
                self.automation_active.remove(&a.id);
                self.automation_run_owner.remove(run_id);
            }
        }
    }

    pub(super) fn automation_tick(&mut self) {
        let now = now_secs();
        self.age_out_stale_runs(now);
        let automations: Vec<wire::Automation> = self.automations.values().cloned().collect();
        for a in automations {
            if !a.enabled {
                continue;
            }
            let Some(due) = a.next_run_at else {
                // Never scheduled (fresh row or a schedule that failed to
                // parse once): seed the next occurrence without firing. Write
                // the seed into the mirror too, or every tick re-seeds and
                // re-persists the same row.
                let mut a = a;
                a.next_run_at = sched::next_occurrence(&a.trigger, &a.timezone, now);
                if a.next_run_at.is_some() {
                    self.automations.insert(a.id.clone(), a.clone());
                    self.persist.write(PersistWrite::Automation(Box::new(a)));
                }
                continue;
            };
            if due > now {
                continue;
            }
            let mut a = a;
            // Advance before dispatching: a slow precheck or task spawn must
            // never let the next tick re-fire the same occurrence.
            self.advance_next_run(&mut a, now);
            // A grace of 0 would make `now - due > 0` always true: nothing
            // would ever run. Floor it at one tick interval.
            let grace = (a.missed_run_grace_minutes as i64 * 60).max(TICK_SECS);
            if now - due > grace {
                self.record_skip(
                    &a,
                    due,
                    wire::AutomationRunStatus::SkippedMissed,
                    Some(format!(
                        "occurrence was {} minutes old, past the {} minute grace window",
                        (now - due) / 60,
                        a.missed_run_grace_minutes
                    )),
                );
                continue;
            }
            if self.automation_active.contains_key(&a.id) {
                self.record_skip(
                    &a,
                    due,
                    wire::AutomationRunStatus::SkippedRunning,
                    Some("the previous run has not finished yet".into()),
                );
                continue;
            }
            let run = self.create_run(&a, due, wire::AutomationRunTrigger::Scheduled);
            self.spawn_precheck(a, &run.id, run.trigger);
        }
    }

    pub(super) async fn automation_precheck_done(
        &mut self,
        a: wire::Automation,
        run_id: &str,
        ok: bool,
        detail: Option<String>,
    ) {
        if ok {
            self.dispatch_run(&a, run_id);
            return;
        }
        let mut run = self.load_run(run_id);
        match run.as_mut() {
            Some(run) => {
                // The precheck said no — or could not be run. Either way the
                // run was never authorized, so it is skipped, not failed.
                run.status = wire::AutomationRunStatus::SkippedPrecheck;
                run.finished_at = Some(now_secs());
                run.error = detail;
                self.persist_run(run);
                self.record_last_run(&a, run);
                self.automation_active.remove(&a.id);
                self.automation_run_owner.remove(run_id);
            }
            None => {
                self.automation_active.remove(&a.id);
                self.automation_run_owner.remove(run_id);
            }
        }
    }

    pub(super) fn spawn_precheck(
        &mut self,
        a: wire::Automation,
        run_id: &str,
        trigger: wire::AutomationRunTrigger,
    ) {
        let precheck = match a.precheck.as_deref().filter(|p| !p.trim().is_empty()) {
            Some(precheck) => precheck.to_string(),
            None => {
                // No gate to pass: hand the run straight to the dispatcher.
                let cmd_tx = self.cmd_tx.clone();
                let a = Box::new(a);
                let run_id = run_id.to_string();
                tokio::spawn(async move {
                    let _ = cmd_tx
                        .send(Command::AutomationPrecheckDone {
                            automation: a,
                            run_id,
                            trigger,
                            ok: true,
                            detail: None,
                        })
                        .await;
                });
                return;
            }
        };
        let dir = self.project_path(&a.project).unwrap_or_default();
        let cmd_tx = self.cmd_tx.clone();
        let a = Box::new(a);
        let run_id = run_id.to_string();
        tokio::spawn(async move {
            let (ok, detail) = match sched::run_precheck(&precheck, &dir).await {
                Ok(()) => (true, None),
                Err(error) => (false, Some(error)),
            };
            let _ = cmd_tx
                .send(Command::AutomationPrecheckDone {
                    automation: a,
                    run_id,
                    trigger,
                    ok,
                    detail,
                })
                .await;
        });
    }

    /// Turn a passed run into real work: reuse the previous task's session when
    /// asked, otherwise create a fresh task via the ordinary task-create path.
    /// The dispatch goes through the command channel and its outcome lands back
    /// as [`Command::AutomationRunLinked`] — the actor must never await its own
    /// handlers here, that would recurse through the whole command chain.
    pub(super) fn dispatch_run(&mut self, a: &wire::Automation, run_id: &str) {
        let Some(run) = self.load_run(run_id) else {
            self.automation_active.remove(&a.id);
            self.automation_run_owner.remove(run_id);
            return;
        };
        let reused = a.reuse_session
            && a.last_task_id
                .as_deref()
                .is_some_and(|task_id| self.tasks.contains_key(task_id));
        let task_id = a.last_task_id.clone().unwrap_or_default();
        let prompt = marked_prompt(a, run.run_number);
        let a = Box::new(a.clone());
        let run_id = run_id.to_string();
        let cmd_tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            let result = if reused {
                let (tx, rx) = oneshot::channel();
                let sent = cmd_tx
                    .send(Command::SessionPrompt {
                        task_id: task_id.clone(),
                        text: prompt,
                        attachments: Vec::new(),
                        reply: tx,
                    })
                    .await
                    .is_ok();
                if sent {
                    match rx.await {
                        Ok(Ok(())) => Ok(task_id),
                        Ok(Err(error)) => Err(error),
                        Err(_) => Err("daemon dropped the dispatch reply".into()),
                    }
                } else {
                    Err("daemon command channel is gone".into())
                }
            } else {
                let (tx, rx) = oneshot::channel();
                let sent = cmd_tx
                    .send(Command::CreateTask {
                        project: a.project.clone(),
                        prompt,
                        agent: a.agent.clone(),
                        tags: vec!["automation".into()],
                        include_runtime_context: false,
                        worktree: a.worktree,
                        parent_task_id: None,
                        attachments: Vec::new(),
                        default_model: a.model.clone(),
                        config_overrides: a.config_overrides.clone(),
                        backlog_item_id: None,
                        start: true,
                        reply: tx,
                    })
                    .await
                    .is_ok();
                if sent {
                    match rx.await {
                        Ok(task_id) => Ok(task_id),
                        Err(_) => Err("daemon dropped the dispatch reply".into()),
                    }
                } else {
                    Err("daemon command channel is gone".into())
                }
            };
            let _ = cmd_tx
                .send(Command::AutomationRunLinked {
                    automation: a,
                    run_id,
                    reused,
                    result,
                })
                .await;
        });
    }

    /// The run's task was deleted: nothing will ever end its turn, so fail the
    /// run and clear the bookkeeping (the tick's stale-run sweep catches the
    /// cases this misses, e.g. a queued delete landing after the tick).
    pub(crate) fn automation_task_deleted(&mut self, task_id: &str) {
        let Some(run_id) = self.automation_run_tasks.remove(task_id) else {
            return;
        };
        let owner = self.automation_run_owner.remove(&run_id);
        let now = now_secs();
        if let Some(mut run) = self.load_run(&run_id) {
            run.status = wire::AutomationRunStatus::Failed;
            run.finished_at = Some(now);
            run.error = Some("the run's task was deleted".into());
            self.persist_run(&run);
            if let Some(automation_id) = owner {
                self.automation_active.remove(&automation_id);
                if let Some(a) = self.automations.get(&automation_id).cloned() {
                    self.record_last_run(&a, &run);
                }
            }
        }
    }

    /// A dispatched automation task finished a turn: the run is over.
    pub(crate) fn automation_task_finished(&mut self, task_id: &str, success: bool, output: &str) {
        let Some(run_id) = self.automation_run_tasks.remove(task_id) else {
            return;
        };
        let owner = self.automation_run_owner.remove(&run_id);
        let now = now_secs();
        let mut run = self.load_run(&run_id);
        if let Some(run) = run.as_mut() {
            run.status = if success {
                wire::AutomationRunStatus::Completed
            } else {
                wire::AutomationRunStatus::Failed
            };
            run.finished_at = Some(now);
            let mut excerpt: String = output.chars().take(RUN_OUTPUT_EXCERPT).collect();
            if excerpt.len() < output.len() {
                excerpt.push('…');
            }
            run.output = Some(excerpt);
            self.persist_run(run);
            if let Some(automation_id) = owner {
                self.automation_active.remove(&automation_id);
                if let Some(a) = self.automations.get(&automation_id).cloned() {
                    self.record_last_run(&a, run);
                }
            }
        }
    }
}
