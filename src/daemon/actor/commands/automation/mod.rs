//! Automation lifecycle: CRUD commands, the periodic scheduler tick, precheck
//! gating and run dispatch. Runs become real daemon tasks, so the transcript,
//! diff and runtime context of a scheduled run are the same objects a
//! hand-created task has; the run row is the bookkeeping that links the two.

mod bookkeeping;
mod runs;

use std::time::{SystemTime, UNIX_EPOCH};

use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon, Event};
use crate::daemon::automations as sched;
use crate::daemon::runtime::Write as PersistWrite;

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Daemon {
    pub(crate) async fn handle_automation_command(&mut self, cmd: Command) {
        match cmd {
            Command::AutomationList { project, reply } => {
                let mut all: Vec<wire::Automation> = self
                    .automations
                    .values()
                    .filter(|a| project.as_deref().is_none_or(|p| a.project == p))
                    .cloned()
                    .collect();
                all.sort_by_key(|a| std::cmp::Reverse(a.created_at));
                let _ = reply.send(Ok(all));
            }
            Command::AutomationShow { id, reply } => {
                let result = self
                    .automations
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| format!("unknown automation {id}"));
                let _ = reply.send(result);
            }
            Command::AutomationCreate { automation, reply } => {
                let result = self.automation_create(*automation);
                let _ = reply.send(result);
            }
            Command::AutomationUpdate { id, patch, reply } => {
                let result = self.automation_update(&id, *patch);
                let _ = reply.send(result);
            }
            Command::AutomationDelete { id, reply } => {
                self.automation_delete(&id).await;
                self.persist
                    .write(PersistWrite::AutomationDelete(id.clone()));
                self.emit(Event::AutomationRemoved { id });
                let _ = reply.send(Ok(()));
            }
            Command::AutomationRunNow { id, reply } => {
                let result = self.automation_run_now(&id).await;
                let _ = reply.send(result);
            }
            Command::AutomationRuns { id, limit, reply } => {
                let store = self.store.clone();
                let id = id.clone();
                let result = crate::daemon::runtime::store_read(store, move |store| {
                    store
                        .load_automation_runs(&id, limit)
                        .map_err(|e| format!("{e:#}"))
                })
                .await
                .unwrap_or_else(|| Err("daemon has no persistent store".into()));
                let _ = reply.send(result);
            }
            Command::AutomationRunLinked {
                automation,
                run_id,
                reused,
                result,
            } => self.automation_run_linked(*automation, &run_id, reused, result),
            Command::AutomationTick => self.automation_tick(),
            Command::AutomationPrecheckDone {
                automation,
                run_id,
                ok,
                detail,
                ..
            } => {
                self.automation_precheck_done(*automation, &run_id, ok, detail)
                    .await;
            }
            _ => {
                // Terminal arm of the command chain: anything reaching here is
                // dropped, so make the silence loud instead of a no-op.
                eprintln!("[daemon] unhandled command fell through to the automation dispatcher");
                debug_assert!(false, "unhandled command reached the automation dispatcher");
            }
        }
    }

    /// Remove an automation and all its live bookkeeping: the run-in-flight
    /// token, the run ownership entries and the per-task links. An in-flight
    /// run's task is cancelled too — its owner is gone, so its result would
    /// only land as an orphan run row.
    async fn automation_delete(&mut self, id: &str) {
        self.automations.remove(id);
        self.automation_active.remove(id);
        self.automation_runs_live
            .retain(|_, run| run.automation_id != id);
        let run_ids: Vec<String> = self
            .automation_run_owner
            .iter()
            .filter(|(_, automation)| automation.as_str() == id)
            .map(|(run, _)| run.clone())
            .collect();
        for run_id in run_ids {
            self.automation_run_owner.remove(&run_id);
            let task_ids: Vec<String> = self
                .automation_run_tasks
                .iter()
                .filter(|(_, run)| run.as_str() == run_id)
                .map(|(task, _)| task.clone())
                .collect();
            for task_id in task_ids {
                self.automation_run_tasks.remove(&task_id);
                if let Some(handle) = self.sessions.remove(&task_id) {
                    tokio::spawn(async move {
                        let _ = handle.cancel_and_wait().await;
                    });
                }
            }
        }
    }

    fn automation_create(&mut self, mut a: wire::Automation) -> Result<wire::Automation, String> {
        if a.name.trim().is_empty() {
            return Err("automation needs a name".into());
        }
        if a.prompt.trim().is_empty() {
            return Err("automation needs a prompt".into());
        }
        if self.project_path(&a.project).is_none() {
            return Err(format!("unknown project '{}'", a.project));
        }
        // An empty timezone means "the host's zone": resolve it here, once, so
        // the stored schedule never silently changes zone if the host's zone
        // moves or the row is read on another machine.
        if a.timezone.trim().is_empty() {
            a.timezone = sched::host_timezone();
        }
        sched::validate_trigger(&a.trigger, &a.timezone).map_err(|e| e.to_string())?;
        let now = now_secs();
        a.created_at = now;
        a.updated_at = now;
        // A caller that supplies `next_run_at` (tests, an import) keeps it;
        // everyone else gets the schedule's next occurrence from now.
        if a.next_run_at.is_none() && a.enabled {
            a.next_run_at = sched::next_occurrence(&a.trigger, &a.timezone, now);
        }
        self.automations.insert(a.id.clone(), a.clone());
        self.persist
            .write(PersistWrite::Automation(Box::new(a.clone())));
        self.emit(Event::AutomationUpdated(Box::new(a.clone())));
        Ok(a)
    }

    fn automation_update(
        &mut self,
        id: &str,
        patch: wire::AutomationPatch,
    ) -> Result<wire::Automation, String> {
        let mut a = self
            .automations
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown automation {id}"))?;
        let now = now_secs();
        let wire::AutomationPatch {
            name,
            prompt,
            project,
            agent,
            model,
            config_overrides,
            trigger,
            timezone,
            precheck,
            enabled,
            missed_run_grace_minutes,
            reuse_session,
            worktree,
        } = patch;
        let rescheduled = trigger.is_some() || timezone.is_some() || enabled == Some(true);
        if let Some(name) = name {
            a.name = name;
        }
        if let Some(prompt) = prompt {
            a.prompt = prompt;
        }
        if let Some(project) = project {
            a.project = project;
        }
        if let Some(agent) = agent {
            a.agent = agent;
        }
        if let Some(model) = model {
            a.model = model;
        }
        if let Some(config_overrides) = config_overrides {
            a.config_overrides = config_overrides;
        }
        if let Some(trigger) = trigger {
            a.trigger = trigger;
        }
        if let Some(timezone) = timezone {
            a.timezone = timezone;
        }
        if let Some(precheck) = precheck {
            a.precheck = precheck;
        }
        if let Some(enabled) = enabled {
            a.enabled = enabled;
        }
        if let Some(missed_run_grace_minutes) = missed_run_grace_minutes {
            a.missed_run_grace_minutes = missed_run_grace_minutes;
        }
        if let Some(reuse_session) = reuse_session {
            a.reuse_session = reuse_session;
        }
        if let Some(worktree) = worktree {
            a.worktree = worktree;
        }
        sched::validate_trigger(&a.trigger, &a.timezone).map_err(|e| e.to_string())?;
        a.updated_at = now;
        // Re-derive the next occurrence whenever the schedule moved or the
        // automation came back on: a stale timestamp from the old schedule
        // would fire immediately.
        a.next_run_at = if a.enabled {
            if rescheduled || a.next_run_at.is_none() {
                sched::next_occurrence(&a.trigger, &a.timezone, now)
            } else {
                a.next_run_at
            }
        } else {
            None
        };
        // Update the mirror before persisting: every read path (list, show,
        // tick, run-now) consults it, and the store write is behind a queue.
        self.automations.insert(id.to_string(), a.clone());
        self.persist
            .write(PersistWrite::Automation(Box::new(a.clone())));
        self.emit(Event::AutomationUpdated(Box::new(a.clone())));
        Ok(a)
    }

    async fn automation_run_now(&mut self, id: &str) -> Result<wire::AutomationRun, String> {
        let a = self
            .automations
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown automation {id}"))?;
        if self.automation_active.contains_key(id) {
            return Err("this automation already has a run in flight".into());
        }
        let now = now_secs();
        let run = self.create_run(&a, now, wire::AutomationRunTrigger::Manual);
        // An explicit click means run: no precheck, no grace check, and the
        // next scheduled occurrence does not move.
        self.dispatch_run(&a, &run.id);
        Ok(run)
    }
}
