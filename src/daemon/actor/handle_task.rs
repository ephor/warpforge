use anyhow::Result;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::daemon::actor::{Command, DaemonHandle};

impl DaemonHandle {
    pub async fn session_prompt(
        &self,
        task_id: &str,
        text: &str,
        attachments: Vec<wire::PromptAttachment>,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SessionPrompt {
            task_id: task_id.into(),
            text: text.into(),
            attachments,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the prompt request".into()))
    }

    pub async fn list_sessions(&self, project: &str) -> Vec<wire::ExternalSession> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListSessions {
            project: project.into(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn resume_task(
        &self,
        project: &str,
        agent: &str,
        session_id: &str,
        title: &str,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ResumeTask {
            project: project.into(),
            agent: agent.into(),
            session_id: session_id.into(),
            title: title.into(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn detect_agents(&self) -> Vec<wire::DetectedAgent> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::DetectAgents { reply: tx }).await;
        rx.await.unwrap_or_default()
    }

    pub async fn update_agents(&self, agents: Vec<wire::AgentConfig>) {
        self.send(Command::UpdateAgents { agents }).await;
    }

    pub async fn list_accounts(&self) -> Vec<wire::AccountInfo> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListAccounts { reply: tx }).await;
        rx.await.unwrap_or_default()
    }

    pub async fn list_agent_limits(&self, refresh: bool) -> Vec<wire::AgentAccountLimits> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListAgentLimits { reply: tx, refresh })
            .await;
        rx.await.unwrap_or_default()
    }

    pub async fn list_agent_spend(&self) -> Vec<wire::AgentSpend> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListAgentSpend { reply: tx }).await;
        rx.await.unwrap_or_default()
    }

    pub async fn import_account(
        &self,
        agent_id: String,
        label: String,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ImportAccount {
            agent_id,
            label,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    pub async fn rename_account(
        &self,
        account_id: String,
        label: String,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::RenameAccount {
            account_id,
            label,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    pub async fn remove_account(
        &self,
        account_id: String,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::RemoveAccount {
            account_id,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    pub async fn set_active_account(
        &self,
        agent_id: String,
        account_id: String,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SetActiveAccount {
            agent_id,
            account_id,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    /// Re-read an agent's selectors from the harness. Resolves when the probe
    /// finishes so the caller can report a failure instead of silently keeping
    /// the old list.
    pub async fn probe_agent(&self, id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ProbeAgent {
            id: id.into(),
            reply: Some(tx),
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    pub async fn session_set_config_option(
        &self,
        task_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SessionSetConfigOption {
            task_id: task_id.into(),
            config_id: config_id.into(),
            value: value.into(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    pub async fn session_permission(&self, task_id: &str, request_id: &str, outcome: &str) {
        self.send(Command::SessionPermission {
            task_id: task_id.into(),
            request_id: request_id.into(),
            outcome: outcome.into(),
        })
        .await;
    }

    pub async fn spawn_agent(
        &self,
        project: &str,
        command: &str,
        description: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SpawnAgent {
            project: project.to_string(),
            command: command.to_string(),
            description: description.to_string(),
            cols,
            rows,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("daemon closed")))
    }

    pub async fn merge_worktree(&self, task_id: &str) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MergeWorktree {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon closed".into()))
    }

    pub async fn list_worktrees(&self, project: &str) -> Vec<wire::WorktreeInfo> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListWorktrees {
            project: project.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn settle_task(&self, task_id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SettleTask {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon closed".into()))
    }

    pub async fn unsettle_task(&self, task_id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::UnsettleTask {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon closed".into()))
    }

    pub async fn snooze_task(&self, task_id: &str, until: u64) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SnoozeTask {
            task_id: task_id.to_string(),
            until,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon closed".into()))
    }

    pub async fn unsnooze_task(&self, task_id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::UnsnoozeTask {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon closed".into()))
    }
}
