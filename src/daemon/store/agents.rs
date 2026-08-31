//! Agent configuration, agent accounts, orchestrator config, and workflow-run
//! snapshots — the daemon's "how do I run things" state.

use anyhow::Result;

use warpforge_protocol as wire;

use super::{Store, StoredAccount};

impl Store {
    /// Returns true if the agents table has at least one row.
    pub fn agents_configured(&self) -> bool {
        self.conn
            .query_row("SELECT COUNT(*) FROM agents", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    pub fn load_agents(&self) -> Result<Vec<wire::AgentConfig>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, display_name, acp_command, enabled, models, last_model FROM agents ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            let models_json: String = row.get(4)?;
            let models: Vec<wire::ConfigOption> =
                serde_json::from_str(&models_json).unwrap_or_default();
            Ok(wire::AgentConfig {
                id: row.get(0)?,
                display_name: row.get(1)?,
                acp_command: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                models,
                last_model: row.get::<_, Option<String>>(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Every registered agent account, with the active flag resolved from
    /// `active_account`. Usage is not persisted — it is a live readout.
    pub fn load_accounts(&self) -> Result<Vec<StoredAccount>> {
        let mut stmt = self.conn.prepare(
            "SELECT a.id, a.agent_id, a.label, a.email, a.plan, a.home_dir, a.created_at, \
             (SELECT account_id FROM active_account WHERE agent_id = a.agent_id) \
             FROM agent_accounts a ORDER BY a.agent_id, a.created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let active_id: Option<String> = row.get(7)?;
            Ok(StoredAccount {
                active: active_id.as_deref() == Some(id.as_str()),
                id,
                agent_id: row.get(1)?,
                label: row.get(2)?,
                email: row.get(3)?,
                plan: row.get(4)?,
                home_dir: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn upsert_account(&self, account: &StoredAccount) -> Result<()> {
        self.conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, label, email, plan, home_dir, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7) \
             ON CONFLICT(id) DO UPDATE SET \
                label=excluded.label, email=excluded.email, plan=excluded.plan, \
                home_dir=excluded.home_dir",
            rusqlite::params![
                account.id,
                account.agent_id,
                account.label,
                account.email,
                account.plan,
                account.home_dir,
                account.created_at,
            ],
        )?;
        Ok(())
    }

    /// Delete an account row and, when it was the active one, clear the
    /// selection for its agent. Leaving a dangling active id would resolve to
    /// "no account" on every later lookup with no way to notice.
    pub fn delete_account(&self, account_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM active_account WHERE account_id = ?1",
            [account_id],
        )?;
        self.conn
            .execute("DELETE FROM agent_accounts WHERE id = ?1", [account_id])?;
        Ok(())
    }

    pub fn set_active_account(&self, agent_id: &str, account_id: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO active_account (agent_id, account_id) VALUES (?1,?2) \
             ON CONFLICT(agent_id) DO UPDATE SET account_id=excluded.account_id",
            [agent_id, account_id],
        )?;
        Ok(())
    }

    pub fn save_agents(&self, agents: &[wire::AgentConfig]) -> Result<()> {
        self.conn.execute("DELETE FROM agents", [])?;
        for a in agents {
            let models_json = serde_json::to_string(&a.models)?;
            self.conn.execute(
                "INSERT INTO agents (id, display_name, acp_command, enabled, models, last_model) \
                 VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    a.id,
                    a.display_name,
                    a.acp_command,
                    a.enabled as i64,
                    models_json,
                    a.last_model,
                ],
            )?;
        }
        Ok(())
    }

    /// Update only the probed model selectors and the last-used model for one
    /// agent, without touching the rest of the row.
    pub fn update_agent_models(
        &self,
        id: &str,
        models: &[wire::ConfigOption],
        last_model: Option<&str>,
    ) -> Result<()> {
        let models_json = serde_json::to_string(models)?;
        self.conn.execute(
            "UPDATE agents SET models = ?1, last_model = ?2 WHERE id = ?3",
            rusqlite::params![models_json, last_model, id],
        )?;
        Ok(())
    }

    pub fn load_orchestrator_config(
        &self,
    ) -> Result<Option<crate::orchestration::config::OrchestratorConfig>> {
        let mut stmt = self
            .conn
            .prepare("SELECT config_json FROM orchestrator_config WHERE id = 1")?;
        let mut rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        if let Some(Ok(json)) = rows.next() {
            Ok(serde_json::from_str(&json).ok())
        } else {
            Ok(None)
        }
    }

    pub fn save_orchestrator_config(
        &self,
        config: &crate::orchestration::config::OrchestratorConfig,
    ) -> Result<()> {
        let json = serde_json::to_string(config)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO orchestrator_config (id, config_json) VALUES (1, ?1)",
            rusqlite::params![json],
        )?;
        Ok(())
    }

    /// Persist a workflow pipeline's full state (spec snapshot included) as
    /// one JSON blob, replacing any previous snapshot for the task.
    pub fn save_workflow_run(&self, task_id: &str, run_json: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO workflow_runs (task_id, run_json, updated_at) \
             VALUES (?1, ?2, strftime('%s','now'))",
            rusqlite::params![task_id, run_json],
        )?;
        Ok(())
    }

    /// All persisted workflow runs as (task_id, run_json) pairs.
    pub fn load_workflow_runs(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, run_json FROM workflow_runs")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_workflow_run(&self, task_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM workflow_runs WHERE task_id = ?1",
            rusqlite::params![task_id],
        )?;
        Ok(())
    }
}
