use anyhow::Result;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::daemon::actor::{Command, DaemonHandle};

impl DaemonHandle {
    pub async fn generate_text(
        &self,
        task_id: &str,
        agent_id: &str,
        kind: wire::TextGenKind,
        model: Option<String>,
        account_id: Option<String>,
        input: Option<String>,
    ) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GenerateText {
            task_id: task_id.to_string(),
            agent_id: agent_id.to_string(),
            kind,
            model,
            account_id,
            input,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the text-generation request".into()))
    }

    /// Polish a user-written task prompt (title/description) one-shot. Unlike
    /// `generate_text` this runs before a task exists, so it takes a project
    /// name and the raw prompt instead of a `task_id`.
    pub async fn enhance_text(
        &self,
        project: &str,
        agent_id: &str,
        prompt: &str,
        model: Option<String>,
    ) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::EnhanceText {
            project: project.to_string(),
            agent_id: agent_id.to_string(),
            prompt: prompt.to_string(),
            model,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the text-enhance request".into()))
    }

    pub async fn tracker_persist_link(
        &self,
        link: crate::daemon::store::TrackerLink,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerPersistLink { link, reply: tx })
            .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the tracker-link write".into()))
    }

    pub async fn tracker_links(&self) -> Result<Vec<wire::TrackerLinkInfo>, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerLinks { reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the tracker-links request".into()))
    }

    /// The links a sync should refresh, plus the git dir of every project they
    /// belong to. Store read only — the caller does the network itself so the
    /// actor loop never waits on a tracker.
    #[allow(clippy::type_complexity)]
    pub async fn tracker_sync_inputs(
        &self,
        ids: Vec<String>,
    ) -> (
        Vec<crate::daemon::store::TrackerLink>,
        std::collections::HashMap<String, String>,
        std::collections::HashMap<String, String>,
    ) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerSyncInputs { ids, reply: tx })
            .await;
        rx.await.unwrap_or_default()
    }

    pub async fn tracker_project_settings(
        &self,
        project: &str,
    ) -> Result<wire::TrackerProjectSettings, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerProjectSettings {
            project: project.to_string(),
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped tracker settings request".into()))
    }

    pub async fn tracker_set_project_linear_team(
        &self,
        project: String,
        team_id: Option<String>,
        team_name: Option<String>,
    ) -> Result<wire::TrackerProjectSettings, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerSetProjectLinearTeam {
            project,
            team_id,
            team_name,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped tracker settings request".into()))
    }

    pub async fn tracker_persist_synced(&self, links: Vec<crate::daemon::store::TrackerLink>) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerPersistSynced { links, reply: tx })
            .await;
        let _ = rx.await;
    }

    pub async fn tracker_delete_items(&self, ids: Vec<String>) {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerDeleteItems { ids, reply: tx })
            .await;
        let _ = rx.await;
    }

    pub async fn tracker_adopt_imported(
        &self,
        project: &str,
        fetched: Vec<(String, Vec<crate::daemon::tracker::RemoteIssue>)>,
    ) -> Result<(Vec<wire::ImportedWorkItem>, Vec<wire::SyncedExternalItem>), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::TrackerAdoptImported {
            project: project.to_string(),
            fetched,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the external-import request".into()))
    }

    pub async fn backlog_get_settings(&self) -> Result<wire::BacklogSettings, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogGetSettings { reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog settings request".into()))
    }

    /// One task's full folded conversation history. Index-backed read, so it
    /// stays fast on databases where the whole-table load used to take tens
    /// of seconds.
    pub async fn session_history(
        &self,
        task_id: String,
    ) -> Result<Vec<wire::SessionUpdate>, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SessionHistory { task_id, reply: tx })
            .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the session history request".into()))
    }

    pub async fn history_get_settings(&self) -> wire::HistorySettings {
        let (tx, rx) = oneshot::channel();
        self.send(Command::HistoryGetSettings { reply: tx }).await;
        rx.await.unwrap_or_else(|_| {
            let defaults = crate::daemon::history_config::HistoryConfig::default();
            wire::HistorySettings {
                retention_days: defaults.retention_days,
                settle_ignored_after_days: defaults.settle_ignored_after_days,
                delete_closed_after_days: defaults.delete_closed_after_days,
            }
        })
    }

    pub async fn history_set_settings(
        &self,
        retention_days: u32,
        settle_ignored_after_days: u32,
        delete_closed_after_days: u32,
    ) -> Result<wire::HistorySettings, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::HistorySetSettings {
            retention_days,
            settle_ignored_after_days,
            delete_closed_after_days,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the history settings request".into()))
    }

    /// Fire-and-forget history prune (start, daily, settings change).
    pub async fn prune_history(&self) {
        self.send(Command::PruneHistory).await;
    }

    pub async fn backlog_set_storage(
        &self,
        mode: wire::BacklogStorageMode,
    ) -> Result<wire::BacklogSettings, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogSetStorage { mode, reply: tx })
            .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog storage request".into()))
    }

    pub async fn backlog_list(
        &self,
        project: String,
        query: crate::daemon::backlog::Query,
    ) -> Result<wire::BacklogPage, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogList {
            project,
            query,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog list request".into()))
    }

    pub async fn backlog_create(
        &self,
        item: crate::daemon::backlog::NewItem,
    ) -> Result<wire::BacklogItem, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogCreate { item, reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog create request".into()))
    }

    pub async fn backlog_update(
        &self,
        patch: crate::daemon::backlog::ItemPatch,
    ) -> Result<wire::BacklogItem, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogUpdate { patch, reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog update request".into()))
    }

    pub async fn backlog_attach_external(
        &self,
        item_id: String,
        project: String,
        provider: String,
        external_id: String,
        url: String,
        remote_status: Option<String>,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogAttachExternal {
            item_id,
            project,
            provider,
            external_id,
            url,
            remote_status,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog external attach request".into()))
    }

    pub async fn backlog_delete(&self, item_id: String, project: String) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogDelete {
            item_id,
            project,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog delete request".into()))
    }
}
