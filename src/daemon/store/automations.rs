//! Automation rows and their run history.
//!
//! An automation is persisted intent ("run this prompt on this schedule"); a
//! run is the record of one attempt to honour it. Runs are pruned to the most
//! recent final rows per automation — a `Running` row is never pruned because
//! its completion must still find it.

use anyhow::Result;
use rusqlite::OptionalExtension;

use warpforge_protocol as wire;

use super::Store;

const RETAINED_FINAL_RUNS: i64 = 100;

fn trigger_json(trigger: &wire::AutomationTrigger) -> String {
    serde_json::to_string(trigger).unwrap_or_default()
}

fn parse_trigger(json: &str) -> wire::AutomationTrigger {
    serde_json::from_str(json).unwrap_or_default()
}

fn overrides_json(overrides: &std::collections::HashMap<String, String>) -> String {
    serde_json::to_string(overrides).unwrap_or_default()
}

fn parse_overrides(json: &str) -> std::collections::HashMap<String, String> {
    serde_json::from_str(json).unwrap_or_default()
}

fn status_str(status: Option<wire::AutomationRunStatus>) -> Option<&'static str> {
    status.map(|s| s.as_str())
}

fn parse_status(s: Option<String>) -> Option<wire::AutomationRunStatus> {
    use wire::AutomationRunStatus as S;
    match s.as_deref() {
        Some("pending") => Some(S::Pending),
        Some("running") => Some(S::Running),
        Some("completed") => Some(S::Completed),
        Some("failed") => Some(S::Failed),
        Some("skipped_precheck") => Some(S::SkippedPrecheck),
        Some("skipped_missed") => Some(S::SkippedMissed),
        Some("skipped_running") => Some(S::SkippedRunning),
        _ => None,
    }
}

fn parse_run_trigger(s: String) -> wire::AutomationRunTrigger {
    match s.as_str() {
        "manual" => wire::AutomationRunTrigger::Manual,
        _ => wire::AutomationRunTrigger::Scheduled,
    }
}

impl Store {
    pub fn upsert_automation(&self, a: &wire::Automation) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO automations
                (id, project, name, prompt, agent, model, config_overrides, trigger,
                 timezone, precheck, enabled, missed_run_grace_minutes, reuse_session,
                 worktree, created_at, updated_at, next_run_at, last_run_at, last_status,
                 last_task_id)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
            ON CONFLICT(id) DO UPDATE SET
                project=excluded.project,
                name=excluded.name,
                prompt=excluded.prompt,
                agent=excluded.agent,
                model=excluded.model,
                config_overrides=excluded.config_overrides,
                trigger=excluded.trigger,
                timezone=excluded.timezone,
                precheck=excluded.precheck,
                enabled=excluded.enabled,
                missed_run_grace_minutes=excluded.missed_run_grace_minutes,
                reuse_session=excluded.reuse_session,
                worktree=excluded.worktree,
                updated_at=excluded.updated_at,
                next_run_at=excluded.next_run_at,
                last_run_at=excluded.last_run_at,
                last_status=excluded.last_status,
                last_task_id=excluded.last_task_id
            "#,
            rusqlite::params![
                a.id,
                a.project,
                a.name,
                a.prompt,
                a.agent,
                a.model,
                overrides_json(&a.config_overrides),
                trigger_json(&a.trigger),
                a.timezone,
                a.precheck,
                a.enabled as i64,
                a.missed_run_grace_minutes,
                a.reuse_session as i64,
                a.worktree as i64,
                a.created_at,
                a.updated_at,
                a.next_run_at,
                a.last_run_at,
                status_str(a.last_status),
                a.last_task_id,
            ],
        )?;
        Ok(())
    }

    pub fn load_automations(&self) -> Result<Vec<wire::Automation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project, name, prompt, agent, model, config_overrides, trigger, \
             timezone, precheck, enabled, missed_run_grace_minutes, reuse_session, worktree, \
             created_at, updated_at, next_run_at, last_run_at, last_status, last_task_id \
             FROM automations",
        )?;
        let rows = stmt.query_map([], automation_from_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn load_automation(&self, id: &str) -> Result<Option<wire::Automation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project, name, prompt, agent, model, config_overrides, trigger, \
             timezone, precheck, enabled, missed_run_grace_minutes, reuse_session, worktree, \
             created_at, updated_at, next_run_at, last_run_at, last_status, last_task_id \
             FROM automations WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(rusqlite::params![id], automation_from_row)
            .optional()?;
        Ok(row)
    }

    pub fn delete_automation(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM automation_runs WHERE automation_id = ?1",
            rusqlite::params![id],
        )?;
        self.conn.execute(
            "DELETE FROM automations WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    pub fn upsert_automation_run(&self, run: &wire::AutomationRun) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO automation_runs
                (id, automation_id, run_number, trigger, status, scheduled_for, started_at,
                 finished_at, task_id, error, output)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
            ON CONFLICT(id) DO UPDATE SET
                status=excluded.status,
                finished_at=excluded.finished_at,
                task_id=excluded.task_id,
                error=excluded.error,
                output=excluded.output
            "#,
            rusqlite::params![
                run.id,
                run.automation_id,
                run.run_number as i64,
                run.trigger.as_str(),
                run.status.as_str(),
                run.scheduled_for,
                run.started_at,
                run.finished_at,
                run.task_id,
                run.error,
                run.output,
            ],
        )?;
        Ok(())
    }

    pub fn load_automation_run(&self, id: &str) -> Result<Option<wire::AutomationRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, automation_id, run_number, trigger, status, scheduled_for, started_at, \
             finished_at, task_id, error, output FROM automation_runs WHERE id = ?1",
        )?;
        Ok(stmt
            .query_row(rusqlite::params![id], run_from_row)
            .optional()?)
    }

    pub fn load_automation_runs(
        &self,
        automation_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<wire::AutomationRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, automation_id, run_number, trigger, status, scheduled_for, started_at, \
             finished_at, task_id, error, output FROM automation_runs \
             WHERE automation_id = ?1 ORDER BY run_number DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![automation_id, limit.unwrap_or(u32::MAX) as i64],
            run_from_row,
        )?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Any run of this automation that has not reached a final status yet.
    pub fn find_inflight_run(&self, automation_id: &str) -> Result<Option<wire::AutomationRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, automation_id, run_number, trigger, status, scheduled_for, started_at, \
             finished_at, task_id, error, output FROM automation_runs \
             WHERE automation_id = ?1 AND status IN ('pending', 'running') LIMIT 1",
        )?;
        Ok(stmt
            .query_row(rusqlite::params![automation_id], run_from_row)
            .optional()?)
    }

    /// Next monotonic run number: `MAX + 1`, never a row count — retention
    /// deletes rows and a count would reissue numbers.
    pub fn next_automation_run_number(&self, automation_id: &str) -> Result<u64> {
        let max: Option<i64> = self.conn.query_row(
            "SELECT MAX(run_number) FROM automation_runs WHERE automation_id = ?1",
            rusqlite::params![automation_id],
            |row| row.get(0),
        )?;
        Ok(max.unwrap_or(0).max(0) as u64 + 1)
    }

    /// Keep only the newest `RETAINED_FINAL_RUNS` final runs per automation.
    /// Returns the number of rows removed.
    pub fn prune_automation_runs(&self) -> Result<usize> {
        let removed = self.conn.execute(
            "DELETE FROM automation_runs WHERE id IN (\
                SELECT id FROM (\
                    SELECT id, ROW_NUMBER() OVER (\
                        PARTITION BY automation_id ORDER BY run_number DESC\
                    ) AS rn FROM automation_runs WHERE status NOT IN ('pending', 'running')\
                ) WHERE rn > ?1\
            )",
            rusqlite::params![RETAINED_FINAL_RUNS],
        )?;
        Ok(removed)
    }

    /// Runs that were mid-flight when the daemon last stopped cannot finish:
    /// the live session is gone. Mark them failed so the automation's last
    /// status reflects reality and the inflight check does not wedge.
    pub fn fail_inflight_automation_runs(&self) -> Result<u64> {
        let now = crate::daemon::task::now_secs();
        let affected = self.conn.execute(
            "UPDATE automation_runs SET status = 'failed', error = 'daemon restarted', \
             finished_at = ?1 WHERE status IN ('pending', 'running')",
            rusqlite::params![now],
        )?;
        Ok(affected as u64)
    }
}

fn automation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<wire::Automation> {
    Ok(wire::Automation {
        id: row.get(0)?,
        project: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        agent: row.get(4)?,
        model: row.get(5)?,
        config_overrides: parse_overrides(&row.get::<_, String>(6)?),
        trigger: parse_trigger(&row.get::<_, String>(7)?),
        timezone: row.get(8)?,
        precheck: row.get(9)?,
        enabled: row.get::<_, i64>(10)? != 0,
        missed_run_grace_minutes: row.get::<_, i64>(11)? as u32,
        reuse_session: row.get::<_, i64>(12)? != 0,
        worktree: row.get::<_, i64>(13)? != 0,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        next_run_at: row.get(16)?,
        last_run_at: row.get(17)?,
        last_status: parse_status(row.get(18)?),
        last_task_id: row.get(19)?,
    })
}

fn run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<wire::AutomationRun> {
    Ok(wire::AutomationRun {
        id: row.get(0)?,
        automation_id: row.get(1)?,
        run_number: row.get::<_, i64>(2)?.max(0) as u64,
        trigger: parse_run_trigger(row.get(3)?),
        status: parse_status(Some(row.get(4)?)).unwrap_or(wire::AutomationRunStatus::Failed),
        scheduled_for: row.get(5)?,
        started_at: row.get(6)?,
        finished_at: row.get(7)?,
        task_id: row.get(8)?,
        error: row.get(9)?,
        output: row.get(10)?,
    })
}
