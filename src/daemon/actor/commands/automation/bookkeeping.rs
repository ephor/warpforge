//! Run-row bookkeeping: numbering, the live-run mirror, persistence and the
//! last-run fields mirrored onto the automation itself.

use warpforge_protocol as wire;

use super::now_secs;
use crate::daemon::actor::{Daemon, Event};
use crate::daemon::automations as sched;
use crate::daemon::runtime::Write as PersistWrite;

/// The scheduler fires once a minute; the grace floor and stale-run windows
/// are multiples of this.
pub(super) const TICK_SECS: i64 = 60;

impl Daemon {
    /// Per-automation monotonic run counter, seeded from the store at spawn.
    /// In-memory: `MAX(run_number)` from the store would race the write-behind
    /// queue (two runs sharing a number) and cost a blocking SQLite read on
    /// the actor loop per run.
    pub(super) fn next_run_number(&mut self, automation_id: &str) -> u64 {
        let counter = self
            .automation_run_counters
            .entry(automation_id.to_string())
            .or_insert(0);
        *counter += 1;
        *counter
    }

    /// Write a fresh `pending` run row and register it as the automation's
    /// live run. Returns the row so callers can dispatch it.
    pub(super) fn create_run(
        &mut self,
        a: &wire::Automation,
        scheduled_for: i64,
        trigger: wire::AutomationRunTrigger,
    ) -> wire::AutomationRun {
        let run_number = self.next_run_number(&a.id);
        let run = wire::AutomationRun {
            id: uuid::Uuid::new_v4().to_string(),
            automation_id: a.id.clone(),
            run_number,
            trigger,
            status: wire::AutomationRunStatus::Pending,
            scheduled_for,
            started_at: now_secs(),
            finished_at: None,
            task_id: None,
            error: None,
            output: None,
        };
        self.automation_active.insert(a.id.clone(), run.id.clone());
        self.automation_run_owner
            .insert(run.id.clone(), a.id.clone());
        self.persist_run(&run);
        run
    }

    pub(super) fn record_last_run(&mut self, a: &wire::Automation, run: &wire::AutomationRun) {
        // Merge onto the automation as it exists now: `a` may be the snapshot
        // captured at dispatch time, and writing it back wholesale would
        // revert edits made while the run was in flight.
        let mut automation = self
            .automations
            .get(&a.id)
            .cloned()
            .unwrap_or_else(|| a.clone());
        automation.last_run_at = Some(run.started_at);
        automation.last_status = Some(run.status);
        automation.last_task_id = run.task_id.clone().or(automation.last_task_id);
        self.automations
            .insert(automation.id.clone(), automation.clone());
        self.persist
            .write(PersistWrite::Automation(Box::new(automation.clone())));
        self.emit(Event::AutomationUpdated(Box::new(automation)));
    }

    pub(super) fn record_skip(
        &mut self,
        a: &wire::Automation,
        scheduled_for: i64,
        status: wire::AutomationRunStatus,
        reason: Option<String>,
    ) {
        let run = wire::AutomationRun {
            id: uuid::Uuid::new_v4().to_string(),
            automation_id: a.id.clone(),
            run_number: self.next_run_number(&a.id),
            trigger: wire::AutomationRunTrigger::Scheduled,
            status,
            scheduled_for,
            started_at: now_secs(),
            finished_at: Some(now_secs()),
            task_id: None,
            error: reason,
            output: None,
        };
        self.persist_run(&run);
        self.record_last_run(a, &run);
    }

    pub(super) fn advance_next_run(&mut self, a: &mut wire::Automation, now: i64) {
        let next = sched::next_occurrence(&a.trigger, &a.timezone, now);
        a.next_run_at = next;
        // Write the cleared timestamp through as well: `None` means the
        // schedule could not produce a next occurrence (unschedulable), and
        // skipping the write would let every tick re-fire the same one.
        self.automations.insert(a.id.clone(), a.clone());
        self.persist
            .write(PersistWrite::Automation(Box::new(a.clone())));
        self.emit(Event::AutomationUpdated(Box::new(a.clone())));
    }

    /// Runs that can never finish on their own: a `Pending` run whose precheck
    /// never reported back, or a `Running` run whose task is gone (deleted
    /// underneath the automation). Fail them so the overlap guard does not
    /// wedge every future run as `SkippedRunning`.
    pub(super) fn age_out_stale_runs(&mut self, now: i64) {
        let stale: Vec<String> = self
            .automation_runs_live
            .values()
            .filter(|run| match run.status {
                wire::AutomationRunStatus::Pending => now - run.started_at > 5 * TICK_SECS,
                wire::AutomationRunStatus::Running => run
                    .task_id
                    .as_deref()
                    .is_some_and(|task_id| !self.tasks.contains_key(task_id)),
                _ => false,
            })
            .map(|run| run.id.clone())
            .collect();
        for run_id in stale {
            let Some(mut run) = self.automation_runs_live.get(&run_id).cloned() else {
                continue;
            };
            run.status = wire::AutomationRunStatus::Failed;
            run.finished_at = Some(now);
            if run.error.is_none() {
                run.error = Some(if run.task_id.is_some() {
                    "the run's task is gone".into()
                } else {
                    "the precheck never reported back".into()
                });
            }
            self.persist_run(&run);
            let owner = self.automation_run_owner.remove(&run_id);
            if let Some(automation_id) = owner {
                self.automation_active.remove(&automation_id);
                if let Some(a) = self.automations.get(&automation_id).cloned() {
                    self.record_last_run(&a, &run);
                }
            }
        }
    }

    /// A run row the actor just wrote is not yet visible through the store —
    /// persistence is a write-behind queue, and dispatching immediately after
    /// creating a row must not race that queue. Live runs are therefore
    /// mirrored in memory and consulted before the store.
    pub(super) fn load_run(&mut self, run_id: &str) -> Option<wire::AutomationRun> {
        if let Some(run) = self.automation_runs_live.get(run_id) {
            return Some(run.clone());
        }
        self.with_store(|store| store.load_automation_run(run_id))
            .and_then(|r| r.ok())
            .flatten()
    }

    pub(super) fn persist_run(&mut self, run: &wire::AutomationRun) {
        // An automation that was just deleted must not resurrect rows: its
        // store delete is already queued, and a queued run write after it
        // would land as an orphan.
        if !self.automations.contains_key(&run.automation_id) {
            return;
        }
        self.automation_runs_live
            .insert(run.id.clone(), run.clone());
        if run.status.is_final() {
            self.automation_runs_live.remove(&run.id);
        }
        self.persist
            .write(PersistWrite::AutomationRun(Box::new(run.clone())));
        self.emit(Event::AutomationRunUpdated(Box::new(run.clone())));
        // Retention is part of writing a final run; skip it for interim
        // writes (pending → running) — pruning on every write is wasted work.
        if run.status.is_final() {
            self.persist.write(PersistWrite::PruneAutomationRuns);
        }
    }
}
