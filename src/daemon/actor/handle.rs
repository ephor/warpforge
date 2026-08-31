use anyhow::Result;
use tokio::sync::{broadcast, mpsc, oneshot};

use warpforge_protocol as wire;

use crate::registry::ProjectEntry;

use crate::daemon::actor::{ChildResult, Command, Event, ProjectRemovalError};
use crate::daemon::task::{Task, TaskStatus};

/// Cloneable handle clients use to talk to the daemon.
#[derive(Clone)]
pub struct DaemonHandle {
    pub cmd_tx: mpsc::Sender<Command>,
    pub(crate) event_tx: broadcast::Sender<Event>,
}

impl DaemonHandle {
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.event_tx.subscribe()
    }

    pub async fn send(&self, cmd: Command) {
        let _ = self.cmd_tx.send(cmd).await;
    }

    pub async fn projects(&self) -> Vec<ProjectEntry> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Projects(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn tasks(&self) -> Vec<Task> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Tasks(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn snapshot(&self) -> wire::Snapshot {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Snapshot(tx)).await;
        rx.await.unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_task(
        &self,
        project: &str,
        prompt: &str,
        agent: &str,
        tags: Vec<String>,
        include_runtime_context: bool,
        worktree: bool,
        parent_task_id: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        config_overrides: std::collections::HashMap<String, String>,
        backlog_item_id: Option<String>,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CreateTask {
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            tags,
            include_runtime_context,
            worktree,
            parent_task_id,
            attachments,
            default_model,
            config_overrides,
            backlog_item_id,
            start: true,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn queue_task(
        &self,
        project: &str,
        prompt: &str,
        agent: &str,
        tags: Vec<String>,
        include_runtime_context: bool,
        worktree: bool,
        parent_task_id: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        config_overrides: std::collections::HashMap<String, String>,
        backlog_item_id: Option<String>,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CreateTask {
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            tags,
            include_runtime_context,
            worktree,
            parent_task_id,
            attachments,
            default_model,
            config_overrides,
            backlog_item_id,
            start: false,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn set_task_status(&self, id: &str, status: TaskStatus) {
        self.send(Command::SetTaskStatus {
            id: id.to_string(),
            status,
        })
        .await;
    }

    /// Hard-stop a task and wait until the actor has cancelled its session.
    /// For workflow parents this also stops every active stage child.
    pub async fn cancel_task(&self, id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CancelTask {
            id: id.to_string(),
            reply: tx,
        })
        .await;
        rx.await
            .map_err(|_| "daemon stopped before the task was cancelled".to_string())?
    }

    /// Hard-stop a task, wait for its session process to exit, then permanently
    /// remove the task and its persisted session history.
    pub async fn delete_task(&self, id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::DeleteTask {
            id: id.to_string(),
            reply: tx,
        })
        .await;
        rx.await
            .map_err(|_| "daemon stopped before the task was deleted".to_string())?
    }

    pub async fn set_task_title(&self, id: &str, title: &str) {
        self.send(Command::SetTaskTitle {
            id: id.to_string(),
            title: title.to_string(),
        })
        .await;
    }

    pub async fn read_inbox(&self, parent_task_id: &str) -> Vec<ChildResult> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ReadInbox {
            parent_task_id: parent_task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn diff(&self, task_id: &str) -> wire::TaskDiff {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GetDiff {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn work_item_link_task(&self, item_id: &str, task_id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::WorkItemLinkTask {
            item_id: item_id.to_string(),
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the item-link request".into()))
    }

    /// A window of a service's retained log lines (for backfill; live tail
    /// arrives via `ServiceLog` events).
    pub async fn service_logs(
        &self,
        project: &str,
        service: &str,
        after: u64,
        limit: Option<u32>,
    ) -> (Vec<String>, Vec<u64>, u64) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ServiceLogs {
            project: project.to_string(),
            service: service.to_string(),
            after,
            limit,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    /// A window of a port-forward's retained log lines (for backfill; live tail
    /// arrives via `PortForwardLog` events).
    pub async fn portforward_logs(
        &self,
        project: &str,
        name: &str,
        after: u64,
        limit: Option<u32>,
    ) -> (Vec<String>, Vec<u64>, u64) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::PortForwardLogs {
            project: project.to_string(),
            name: name.to_string(),
            after,
            limit,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    /// Register a new project, generate config if needed, broadcast to clients.
    pub async fn add_project(
        &self,
        path: &str,
        name: Option<&str>,
        port_range: Option<crate::registry::PortRange>,
    ) -> Result<ProjectEntry, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::AddProject {
            path: path.to_string(),
            name: name.map(str::to_string),
            port_range,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err("daemon dropped reply".into()))
    }

    /// Remove a project from the registry and broadcast to clients.
    pub async fn remove_project(
        &self,
        name: &str,
        stop_resources: bool,
    ) -> Result<(), ProjectRemovalError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::RemoveProject {
            name: name.to_string(),
            stop_resources,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(ProjectRemovalError::Internal(
            "daemon dropped project removal reply".into(),
        )))
    }

    /// Set (or clear) a project's local port-range override and re-resolve.
    pub async fn set_port_range(
        &self,
        project: &str,
        range: Option<crate::registry::PortRange>,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SetPortRange {
            project: project.to_string(),
            range,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err("daemon dropped reply".into()))
    }

    /// Ask the daemon to tear down (stop services, port-forwards, agents) and
    /// end its actor loop. Used on SIGTERM so we don't leave orphans.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Shutdown { reply: tx }).await;
        let _ = rx.await;
    }

    pub async fn update_blockers(&self) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::UpdateSafety { reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| vec!["daemon closed during update safety check".into()])
    }
}
