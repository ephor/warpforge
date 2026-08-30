use std::time::Duration;

use anyhow::Result;

use warpforge_protocol as wire;

use crate::config::load_workspace_config;

use crate::daemon::actor::{Daemon, Event};
use crate::daemon::runtime::Ask as PersistAsk;

impl Daemon {
    /// Enabled agent ids the orchestrator may delegate to (from the registry).
    pub(crate) fn available_agent_ids(&self) -> Vec<String> {
        self.configured_agents
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect()
    }

    /// Valid workflow ids the orchestrator may pass to `spawn_workflow`: a
    /// project's `.warpforge/workflows/*.yaml` plus built-ins not overridden
    /// by one — the same set `workflow.list` shows the New Task picker.
    pub(crate) fn available_workflow_ids(&self, project: &str) -> Vec<String> {
        let Some(path) = self.project_path(project) else {
            return Vec::new();
        };
        crate::workflow_config::list_workflows(std::path::Path::new(&path))
            .into_iter()
            .filter_map(|w| {
                let spec = w.spec.ok()?;
                Some(format!("{} ({})", w.id, spec.name))
            })
            .collect()
    }

    /// Resolve a task's `agent` to a spawnable ACP command.
    /// Priority: global agent registry → project agentTemplates → raw command.
    pub(crate) fn resolve_agent_command(&self, project: &str, agent: &str) -> String {
        // 1. Global registry (configured via setup wizard / settings).
        if let Some(cfg) = self
            .configured_agents
            .iter()
            .find(|a| a.id == agent || a.display_name == agent)
        {
            return cfg.acp_command.clone();
        }
        // 2. Per-project agentTemplates override (legacy / power-user).
        if let Some(path) = self.project_path(project) {
            if let Some(config) = load_workspace_config(std::path::Path::new(&path)) {
                if let Some(tmpl) = config.agent_templates.and_then(|m| m.get(agent).cloned()) {
                    return tmpl.command;
                }
            }
        }
        // 3. Treat as raw ACP command.
        agent.to_string()
    }

    /// Which account a task's next spawn belongs to.
    ///
    /// A task that already has a session but no recorded account started before
    /// accounts existed, in the agent's own home. That is the migration: no rows
    /// are rewritten, the absence is simply read as "the shared home" instead of
    /// "whatever is active", which would send an old Codex thread looking for
    /// itself in an account database that has never heard of it.
    pub(crate) fn spawn_account<'a>(
        &'a self,
        task_id: &str,
    ) -> crate::daemon::accounts::SpawnAccount<'a> {
        let Some(task) = self.tasks.get(task_id) else {
            return crate::daemon::accounts::SpawnAccount::Active;
        };
        match (task.account_id.as_deref(), task.session_id.is_some()) {
            (Some(id), _) => crate::daemon::accounts::SpawnAccount::Pinned(id),
            (None, true) => crate::daemon::accounts::SpawnAccount::SharedHome,
            (None, false) => crate::daemon::accounts::SpawnAccount::Active,
        }
    }

    /// Extra environment for an agent process: the selected account's home and
    /// any auth env the agent must not inherit.
    ///
    /// Codex selects its account by `CODEX_HOME`; Claude does not (its account
    /// is swapped in place) but still needs conflicting auth env stripped.
    ///
    /// `agent` is whatever the caller recorded — a registry id or a display
    /// name — while accounts and the env rules are both keyed by id. Matching
    /// the raw field means a task recorded as `"Codex"` finds no account and
    /// gets no environment at all, silently running in the shared home.
    pub(crate) fn resolve_agent_env(
        &self,
        agent: &str,
        choice: crate::daemon::accounts::SpawnAccount<'_>,
    ) -> crate::daemon::accounts::AgentEnv {
        let agent = self.agent_id_of(agent);
        let selected = crate::daemon::accounts::select_for_spawn(&self.accounts, agent, choice);
        // Re-link the shared home before every spawn, not just at import: the
        // agent's own home grows entries over time, and a vault that missed
        // them starts the agent with no config and no session history.
        if let Some(account) = selected {
            if account.agent_id == "codex" {
                if let Some(home) = crate::daemon::accounts::agent_home("codex") {
                    if let Err(error) = crate::daemon::accounts::materialize_codex_home(
                        &home,
                        std::path::Path::new(&account.home_dir),
                    ) {
                        eprintln!("[accounts] codex home for '{}': {error}", account.label);
                    }
                }
            }
        }
        crate::daemon::accounts::env_for(agent, selected)
    }

    /// How the daemon reaches the Claude CLI's credential storage.
    pub(crate) fn claude_runtime(&self) -> crate::daemon::claude_auth::ClaudeRuntime {
        crate::daemon::claude_auth::ClaudeRuntime::detect()
    }

    /// File whatever the agent CLIs rotated since the last look.
    ///
    /// Called when a turn ends — the CLI that could have refreshed has just
    /// finished, so anything it rotated has settled — and again on the quota
    /// poll's timer, which is what catches a `codex` or `claude` the user ran
    /// in their own terminal. Both are edges the daemon already has; there is
    /// no loop watching credential files.
    ///
    /// Off the actor loop, because it reads credential files and shells out to
    /// the keychain, and rate-limited because a busy board ends turns far more
    /// often than a token rotates.
    pub(crate) fn capture_credentials(&mut self) {
        const MIN_INTERVAL: Duration = Duration::from_secs(30);
        if self
            .last_credential_capture
            .is_some_and(|at| at.elapsed() < MIN_INTERVAL)
        {
            return;
        }
        self.last_credential_capture = Some(std::time::Instant::now());
        let capture = self.credential_capture.clone();
        let accounts = self.accounts.clone();
        let runtime = self.claude_runtime();
        tokio::task::spawn_blocking(move || {
            if let Ok(mut capture) = capture.lock() {
                capture.run(&runtime, &accounts);
            }
        });
    }

    /// Wire view of the account list.
    pub(crate) fn account_infos(&self) -> Vec<wire::AccountInfo> {
        self.accounts
            .iter()
            .map(|a| wire::AccountInfo {
                id: a.id.clone(),
                agent_id: a.agent_id.clone(),
                label: a.label.clone(),
                email: a.email.clone(),
                plan: a.plan.clone(),
                active: a.active,
            })
            .collect()
    }

    /// Broadcast the current account list and return it for the caller's reply.
    pub(crate) fn emit_accounts(&mut self) -> Vec<wire::AccountInfo> {
        let accounts = self.account_infos();
        self.emit(Event::AccountsUpdated {
            accounts: accounts.clone(),
        });
        accounts
    }

    /// Register the agent's currently-authenticated login as a new account by
    /// copying its credentials into a fresh vault. The agent's own home is only
    /// ever read.
    pub(crate) async fn import_account(
        &mut self,
        agent_id: &str,
        label: &str,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let slug = crate::daemon::accounts::slugify(label);
        let id = crate::daemon::accounts::account_id(agent_id, &slug);
        if self.accounts.iter().any(|a| a.id == id) {
            return Err(format!("account '{label}' already exists for {agent_id}"));
        }
        let vault = crate::daemon::accounts::create_vault(agent_id, &slug, &id)
            .map_err(|e| e.to_string())?;
        let identity = match crate::daemon::accounts::import_agent_login(
            agent_id,
            &vault,
            &id,
            &self.claude_runtime(),
        ) {
            Ok(identity) => identity,
            Err(e) => {
                // Nothing usable was captured — drop the empty vault so a retry
                // starts clean instead of adopting a half-made one.
                let _ = crate::daemon::accounts::remove_vault(&vault, &id);
                return Err(e.to_string());
            }
        };
        let account = crate::daemon::store::StoredAccount {
            id,
            agent_id: agent_id.to_string(),
            label: label.trim().to_string(),
            email: identity.email,
            plan: identity.plan,
            home_dir: vault.to_string_lossy().into_owned(),
            created_at: crate::daemon::task::now_secs(),
            // First account for an agent becomes the active one; later ones
            // wait to be picked, so importing never moves live sessions.
            active: !self.accounts.iter().any(|a| a.agent_id == agent_id),
        };
        let active = account.active;
        let account_id = account.id.clone();
        self.persist
            .ask(PersistAsk::Account(Box::new(account.clone())))
            .await?;
        if active {
            let _ = self
                .persist
                .ask(PersistAsk::SetActiveAccount {
                    agent_id: agent_id.to_string(),
                    account_id,
                })
                .await;
        }
        self.accounts.push(account);
        Ok(self.emit_accounts())
    }

    /// Point an agent at one of its accounts.
    ///
    /// For Codex this only records the choice — the account travels to the next
    /// process in `CODEX_HOME`. For Claude it performs the credential swap, and
    /// the selection is only recorded if that succeeded: a stored "active"
    /// account the CLI is not actually using would misreport which login every
    /// session runs under.
    pub(crate) async fn set_active_account(
        &mut self,
        agent_id: &str,
        account_id: &str,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let Some(target) = self
            .accounts
            .iter()
            .find(|a| a.id == account_id && a.agent_id == agent_id)
            .cloned()
        else {
            return Err(format!("no account {account_id} for agent {agent_id}"));
        };
        if agent_id == "claude" {
            let outgoing = self
                .accounts
                .iter()
                .find(|a| a.agent_id == agent_id && a.active)
                .cloned();
            let capture = self.credential_capture.clone();
            let mut capture = capture.lock().map_err(|_| "credential state poisoned")?;
            crate::daemon::accounts::activate_claude_account(
                &mut capture,
                &self.claude_runtime(),
                outgoing.as_ref(),
                &target,
            )
            .map_err(|e| e.to_string())?;
        }
        self.persist
            .ask(PersistAsk::SetActiveAccount {
                agent_id: agent_id.to_string(),
                account_id: account_id.to_string(),
            })
            .await?;
        for account in &mut self.accounts {
            if account.agent_id == agent_id {
                account.active = account.id == account_id;
            }
        }
        self.retire_sessions_for_agent(agent_id);
        Ok(self.emit_accounts())
    }

    /// Drop the live agent processes for an agent after its account changed, so
    /// the next message starts a fresh one on the new account.
    ///
    /// A running process cannot be moved to another account. Codex reads its
    /// account from `CODEX_HOME` once, at spawn. Claude caches the credentials
    /// it authenticated with for the life of the process, so swapping the store
    /// underneath it does not switch the account — it makes the next request
    /// fail with "OAuth session expired and could not be refreshed", which
    /// reads like a broken login rather than a stale process.
    ///
    /// Killing the handle is enough: `SessionPrompt` sees a dead session and
    /// resumes it (`session/load`) in a new process, so history is preserved.
    pub(crate) fn retire_sessions_for_agent(&mut self, agent_id: &str) {
        let stale: Vec<String> = self
            .sessions
            .keys()
            .filter(|task_id| {
                self.tasks
                    .get(*task_id)
                    .is_some_and(|task| self.agent_id_of(&task.agent) == agent_id)
            })
            .cloned()
            .collect();
        for task_id in stale {
            if let Some(handle) = self.sessions.remove(&task_id) {
                handle.cancel();
            }
        }
    }

    /// Resolve a task's agent field (an id or a display name) to a registry id.
    pub(crate) fn agent_id_of<'a>(&'a self, agent: &'a str) -> &'a str {
        Self::agent_id_in(&self.configured_agents, agent)
    }

    /// `agent_id_of` against an explicit agent list, so the normalisation can
    /// be exercised without a live daemon.
    pub(crate) fn agent_id_in<'a>(agents: &'a [wire::AgentConfig], agent: &'a str) -> &'a str {
        agents
            .iter()
            .find(|a| a.id == agent || a.display_name == agent)
            .map(|a| a.id.as_str())
            .unwrap_or(agent)
    }

    pub(crate) async fn remove_account(
        &mut self,
        account_id: &str,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let Some(index) = self.accounts.iter().position(|a| a.id == account_id) else {
            return Err(format!("no account {account_id}"));
        };
        let account = self.accounts[index].clone();
        crate::daemon::accounts::remove_vault(std::path::Path::new(&account.home_dir), &account.id)
            .map_err(|e| e.to_string())?;
        self.persist
            .ask(PersistAsk::DeleteAccount(account_id.to_string()))
            .await?;
        self.accounts.remove(index);
        if account.agent_id == "claude" {
            let _ = self
                .claude_runtime()
                .delete_managed_credentials(&account.id);
        }
        // Promote a sibling so the agent is never left with accounts but no
        // active one — that state resolves to "no account" everywhere. For
        // Claude that also has to perform the swap, or the CLI would keep using
        // the deleted account's credentials.
        if account.active {
            if let Some(next_id) = self
                .accounts
                .iter()
                .find(|a| a.agent_id == account.agent_id)
                .map(|a| a.id.clone())
            {
                self.set_active_account(&account.agent_id, &next_id).await?;
            }
        }
        Ok(self.emit_accounts())
    }
}
