use anyhow::Result;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::daemon::actor::event::memory_dropped;
use crate::daemon::actor::{Command, DaemonHandle};

impl DaemonHandle {
    pub async fn memory_store(
        &self,
        content: &str,
        scope: Option<&str>,
        kind: Option<&str>,
        tags: Option<&[String]>,
        project_id: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryStore {
            content: content.to_string(),
            scope: scope.map(str::to_string),
            kind: kind.map(str::to_string),
            tags: tags.map(|t| t.to_vec()),
            project_id: project_id.map(str::to_string),
            created_by: created_by.map(str::to_string),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_dream(
        &self,
        dry_run: bool,
        _project_id: Option<&str>,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryDream {
            dry_run,
            project_id: _project_id.map(|s| s.to_string()),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_search(
        &self,
        query: &str,
        scope: Option<&str>,
        limit: Option<u32>,
        mode: Option<&str>,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemorySearch {
            query: query.to_string(),
            scope: scope.map(str::to_string),
            limit,
            mode: mode.map(str::to_string),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_list(
        &self,
        scope: Option<&str>,
        kind: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryList {
            scope: scope.map(str::to_string),
            kind: kind.map(str::to_string),
            limit,
            offset,
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_update(
        &self,
        id: &str,
        content: &str,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryUpdate {
            id: id.to_string(),
            content: content.to_string(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_delete(&self, id: &str) -> Result<(), crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryDelete {
            id: id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_stats(
        &self,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryStats { reply: tx }).await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn set_memory_embedding(
        &self,
        mode: &str,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SetMemoryEmbedding {
            mode: mode.to_string(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }
    pub async fn memory_add_edge(
        &self,
        src: &str,
        dst: &str,
        rel: &str,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryAddEdge {
            src_id: src.into(),
            dst_id: dst.into(),
            relation: rel.into(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }
    pub async fn memory_list_compaction(
        &self,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryListCompaction { reply: tx }).await;
        rx.await.map_err(|_| memory_dropped())?
    }
    pub async fn memory_resolve_compaction(
        &self,
        id: i64,
        approve: bool,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryResolveCompaction {
            id,
            approve,
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }
    pub async fn memory_edges(
        &self,
        id: &str,
    ) -> Result<serde_json::Value, crate::daemon::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryEdges {
            id: id.into(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn file_contents(
        &self,
        task_id: &str,
        path: &str,
        project: Option<String>,
    ) -> Option<wire::FileDoc> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GetFileContents {
            task_id: task_id.to_string(),
            path: path.to_string(),
            project,
            reply: tx,
        })
        .await;
        rx.await.ok().flatten()
    }

    pub async fn list_files(
        &self,
        task_id: &str,
        project: Option<String>,
        include_ignored: bool,
    ) -> Vec<wire::ProjectFile> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ListFiles {
            task_id: task_id.to_string(),
            project,
            include_ignored,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn search_files(
        &self,
        task_id: &str,
        query: &str,
        limit: u32,
        project: Option<String>,
    ) -> Vec<wire::SymbolMatch> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SearchFiles {
            task_id: task_id.to_string(),
            query: query.to_string(),
            limit,
            project,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }
}
