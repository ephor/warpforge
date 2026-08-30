use anyhow::Result;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::daemon::actor::event::op_result_or_dropped;
use crate::daemon::actor::{Command, DaemonHandle};

impl DaemonHandle {
    pub async fn git_last_commit_message(&self, task_id: &str) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitLastCommitMessage {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err("daemon stopped".into()))
    }

    pub async fn git_commit(
        &self,
        task_id: &str,
        message: &str,
        files: Option<Vec<String>>,
        amend: bool,
        project: Option<String>,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitCommit {
            task_id: task_id.to_string(),
            message: message.to_string(),
            files,
            amend,
            project,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the commit request".into()))
    }

    pub async fn git_update(&self, task_id: &str) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitUpdate {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| wire::GitOpResult {
            status: wire::GitOpStatus::Error,
            message: "daemon dropped the update request".into(),
            conflicts: Vec::new(),
            branch: None,
        })
    }

    pub async fn git_branches(
        &self,
        task_id: Option<String>,
        project: Option<String>,
    ) -> wire::GitBranchList {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitBranches {
            task_id,
            project,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn git_switch_branch(&self, task_id: &str, branch: &str) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitSwitchBranch {
            task_id: task_id.to_string(),
            branch: branch.to_string(),
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| wire::GitOpResult {
            status: wire::GitOpStatus::Error,
            message: "daemon dropped the switch request".into(),
            conflicts: Vec::new(),
            branch: None,
        })
    }

    pub async fn git_branch_rename(
        &self,
        task_id: &str,
        branch: &str,
        new_name: &str,
    ) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitBranchRename {
            task_id: task_id.to_string(),
            branch: branch.to_string(),
            new_name: new_name.to_string(),
            reply: tx,
        })
        .await;
        op_result_or_dropped(rx.await, "daemon dropped the rename request")
    }

    pub async fn git_branch_delete(
        &self,
        task_id: &str,
        branch: &str,
        force: bool,
    ) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitBranchDelete {
            task_id: task_id.to_string(),
            branch: branch.to_string(),
            force,
            reply: tx,
        })
        .await;
        op_result_or_dropped(rx.await, "daemon dropped the delete request")
    }

    pub async fn git_rebase(&self, task_id: &str, branch: &str, target: &str) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitRebase {
            task_id: task_id.to_string(),
            branch: branch.to_string(),
            target: target.to_string(),
            reply: tx,
        })
        .await;
        op_result_or_dropped(rx.await, "daemon dropped the rebase request")
    }

    pub async fn git_branch_create(
        &self,
        task_id: &str,
        name: &str,
        from: Option<String>,
        checkout: bool,
        overwrite: bool,
    ) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitBranchCreate {
            task_id: task_id.to_string(),
            name: name.to_string(),
            from,
            checkout,
            overwrite,
            reply: tx,
        })
        .await;
        op_result_or_dropped(rx.await, "daemon dropped the create-branch request")
    }

    pub async fn git_merge(&self, task_id: &str, target: &str) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitMerge {
            task_id: task_id.to_string(),
            target: target.to_string(),
            reply: tx,
        })
        .await;
        op_result_or_dropped(rx.await, "daemon dropped the merge request")
    }

    pub async fn git_push_info(&self, task_id: &str) -> Result<wire::GitPushInfo, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitPushInfo {
            task_id: task_id.to_string(),
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the push preview request".into()))
    }

    pub async fn git_push(&self, task_id: &str, force: bool) -> wire::GitOpResult {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitPush {
            task_id: task_id.to_string(),
            force,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| wire::GitOpResult {
            status: wire::GitOpStatus::Error,
            message: "daemon dropped the push request".into(),
            conflicts: Vec::new(),
            branch: None,
        })
    }

    pub async fn git_create_pr(
        &self,
        task_id: &str,
        title: String,
        body: String,
        base: Option<String>,
    ) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GitCreatePr {
            task_id: task_id.to_string(),
            title,
            body,
            base,
            reply: tx,
        })
        .await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped the create-PR request".into()))
    }
}
