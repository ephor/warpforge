use anyhow::Result;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::registry::ProjectEntry;

use crate::daemon::actor::{ChildResult, GitEffect, ProjectRemovalError};
use crate::daemon::task::{Task, TaskStatus};

pub enum Command {
    Projects(oneshot::Sender<Vec<ProjectEntry>>),
    Tasks(oneshot::Sender<Vec<Task>>),
    /// Full serializable state snapshot (sent to a client on `state.subscribe`).
    Snapshot(oneshot::Sender<wire::Snapshot>),
    /// Start every declared service + port-forward for a project (what "opening"
    /// a project used to do implicitly in the TUI — now explicit).
    OpenProject {
        name: String,
    },
    StartService {
        project: String,
        service: String,
    },
    StopService {
        project: String,
        service: String,
    },
    RestartService {
        project: String,
        service: String,
    },
    /// Start every declared service for a project (services only, no port-forwards).
    StartAllServices {
        project: String,
    },
    StopProject {
        project: String,
    },
    /// Atomically check whether an update can interrupt this daemon. If no
    /// blockers exist, the actor tears down and acknowledges only afterward;
    /// commands queued behind this one are never allowed to start new work.
    UpdateSafety {
        reply: oneshot::Sender<Vec<String>>,
    },
    /// Stop every service and port-forward while keeping the daemon and agent
    /// sessions alive. Used when the desktop UI closes.
    StopRuntime,
    /// A window of a service's retained log lines (events only carry the tail).
    /// The reply is (lines, capture-timestamps[ms], nextSeq cursor).
    ServiceLogs {
        project: String,
        service: String,
        after: u64,
        limit: Option<u32>,
        reply: oneshot::Sender<(Vec<String>, Vec<u64>, u64)>,
    },
    /// A window of a port-forward's retained log lines.
    PortForwardLogs {
        project: String,
        name: String,
        after: u64,
        limit: Option<u32>,
        reply: oneshot::Sender<(Vec<String>, Vec<u64>, u64)>,
    },
    /// Start every declared port-forward for a project (port-forwards only).
    StartAllPortForwards {
        project: String,
    },
    /// Start a single declared port-forward by its label.
    StartPortForward {
        project: String,
        name: String,
    },
    StopPortForward {
        project: String,
        name: String,
    },
    StopAllPortForwards {
        project: String,
    },
    SpawnAgent {
        project: String,
        command: String,
        description: String,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<Result<String>>,
    },
    WriteAgent {
        id: String,
        data: Vec<u8>,
    },
    ResizeAgent {
        id: String,
        cols: u16,
        rows: u16,
    },
    KillAgent {
        id: String,
    },
    /// A task's worktree checkout finished (or failed); start its session.
    WorktreeReady {
        task_id: String,
        created: Result<(String, crate::daemon::worktree::Worktree), String>,
    },
    /// Test-only: report whether a finished turn's output has a consumer.
    #[cfg(test)]
    TurnOutputConsumerProbe {
        task_id: String,
        workflow_child: bool,
        reply: oneshot::Sender<bool>,
    },
    /// A worktree merge finished and its checkout is gone; drop it from the
    /// manager and clear the task's worktree.
    WorktreeMerged {
        task_id: String,
        project: String,
    },
    /// A git operation that ran off the loop finished; apply what it changed
    /// to the task's state.
    GitOpFinished {
        task_id: String,
        effect: GitEffect,
    },
    /// A task's resume replay guard was read from the store; start its session
    /// now that replayed history can be de-duplicated. Loaded off the loop
    /// (write-behind flush + store read), mirroring [`Command::WorktreeReady`].
    ResumeReplayReady {
        task_id: String,
        replay: std::collections::VecDeque<wire::SessionUpdate>,
    },
    /// A finished turn's full text output was assembled from the store; deliver
    /// it to the orchestrator / parent inbox off the actor loop.
    TaskOutputReady {
        task_id: String,
        success: bool,
        workflow_child: bool,
        output: String,
    },
    CreateTask {
        project: String,
        prompt: String,
        agent: String,
        tags: Vec<String>,
        include_runtime_context: bool,
        /// When true, create an isolated git worktree for this task.
        worktree: bool,
        /// Set when this task is a sub-agent of an orchestrator task.
        parent_task_id: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        /// Model id to apply to the agent session before the first prompt
        /// (via `session/set_config_option`). When None, the daemon falls back
        /// to the agent's `last_model` so orchestrator-spawned sub-agents
        /// inherit the user's previous pick without an explicit UI selection.
        default_model: Option<String>,
        /// Non-model config overrides (reasoning effort, mode, etc.) keyed by
        /// config-option id; applied via `session/setConfigOption` after model.
        config_overrides: std::collections::HashMap<String, String>,
        /// Id of the backlog item this task was started from, if any.
        backlog_item_id: Option<String>,
        /// When false, create the task but do not start its agent session.
        start: bool,
        reply: oneshot::Sender<String>,
    },
    /// Create a workflow-pipeline parent task and start its first stage.
    /// Unlike `CreateTask` the parent gets no agent session of its own — the
    /// daemon drives stages as child tasks.
    CreateWorkflowTask {
        project: String,
        prompt: String,
        agent: String,
        tags: Vec<String>,
        worktree: bool,
        workflow: String,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        include_runtime_context: bool,
        config_overrides: std::collections::HashMap<String, String>,
        /// Set when this pipeline is a sub-agent of an orchestrator task —
        /// its final outcome is delivered to that task's inbox.
        parent_task_id: Option<String>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// Soft-pause a workflow pipeline at its next stage barrier.
    WorkflowPause {
        task: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Resume a paused workflow pipeline.
    WorkflowResume {
        task: String,
        note: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Answer a workflow stage's pending `need_user_input` question.
    WorkflowReply {
        task: String,
        message: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Decide what an out-of-rounds workflow pipeline does next.
    WorkflowDecide {
        task: String,
        decision: wire::WorkflowDecision,
        rounds: Option<u32>,
        note: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Drain an orchestrator task's inbox of finished sub-agent results.
    ReadInbox {
        parent_task_id: String,
        reply: oneshot::Sender<Vec<ChildResult>>,
    },
    CancelTask {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Archive a task (set status to Done, hide from live views).
    ArchiveTask {
        id: String,
    },
    /// Read one task's full folded conversation history (off the loop).
    SessionHistory {
        task_id: String,
        reply: oneshot::Sender<Result<Vec<wire::SessionUpdate>, String>>,
    },
    /// Read the task-history retention setting from config.yaml.
    HistoryGetSettings {
        reply: oneshot::Sender<wire::HistorySettings>,
    },
    /// Change the retention windows, persist them, and sweep immediately.
    HistorySetSettings {
        retention_days: u32,
        settle_ignored_after_days: u32,
        delete_closed_after_days: u32,
        reply: oneshot::Sender<Result<wire::HistorySettings, String>>,
    },
    /// Prune finished tasks' transcripts older than the retention window.
    /// Fired at daemon start, daily, and after a settings change.
    PruneHistory,
    /// Delete a task and its session history permanently.
    DeleteTask {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Override a task's title, persist, and emit TaskUpdated.
    SetTaskTitle {
        id: String,
        title: String,
    },
    /// Merge a task's worktree branch back into its base branch and clean up.
    MergeWorktree {
        task_id: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// List active worktrees for a project.
    ListWorktrees {
        project: String,
        reply: oneshot::Sender<Vec<wire::WorktreeInfo>>,
    },
    /// Settle a task (user acknowledged, hide from attention).
    SettleTask {
        task_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Clear the settled state on a task.
    UnsettleTask {
        task_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Snooze a task until the given Unix timestamp.
    SnoozeTask {
        task_id: String,
        until: u64,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Clear the snooze state on a task.
    UnsnoozeTask {
        task_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// List resumable agent sessions found on disk for a project's cwd.
    ListSessions {
        project: String,
        reply: oneshot::Sender<Vec<wire::ExternalSession>>,
    },
    /// Resume an external agent session as a new task; replies with its task id.
    ResumeTask {
        project: String,
        agent: String,
        session_id: String,
        title: String,
        reply: oneshot::Sender<String>,
    },
    /// Compute the task's working-tree diff (git).
    GetDiff {
        task_id: String,
        reply: oneshot::Sender<wire::TaskDiff>,
    },
    /// Old (HEAD) + new (working-tree) text of one file.
    GetFileContents {
        task_id: String,
        path: String,
        project: Option<String>,
        reply: oneshot::Sender<Option<wire::FileDoc>>,
    },
    /// List files in a task's project working tree.
    ListFiles {
        task_id: String,
        project: Option<String>,
        include_ignored: bool,
        reply: oneshot::Sender<Vec<wire::ProjectFile>>,
    },
    /// Write new contents to a file in the task's working tree.
    SaveFile {
        task_id: String,
        path: String,
        content: String,
        project: Option<String>,
    },
    CreateFile {
        task_id: String,
        path: String,
        directory: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RenameFile {
        task_id: String,
        path: String,
        new_path: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    DeleteFile {
        task_id: String,
        path: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Plain-text search across the task's project working tree.
    SearchFiles {
        task_id: String,
        query: String,
        limit: u32,
        project: Option<String>,
        reply: oneshot::Sender<Vec<wire::SymbolMatch>>,
    },
    /// Accept (keep) or reject (revert) a single hunk in the working tree.
    ResolveHunk {
        task_id: String,
        file: String,
        hunk_index: u32,
        resolution: wire::HunkResolution,
    },
    /// Stage (optionally a subset of) files and commit them in the task's repo.
    GitCommit {
        task_id: String,
        message: String,
        files: Option<Vec<String>>,
        amend: bool,
        project: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Read the task repo's latest commit message (for pre-filling an amend).
    GitLastCommitMessage {
        task_id: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// Fetch + rebase the task's repo onto its upstream (autostash, rollback).
    GitUpdate {
        task_id: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// List local branches of a repo, located by task or by project name.
    GitBranches {
        task_id: Option<String>,
        project: Option<String>,
        reply: oneshot::Sender<wire::GitBranchList>,
    },
    /// Switch the task's repo to `branch` (smart checkout, rollback on conflict).
    GitSwitchBranch {
        task_id: String,
        branch: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Rename a local branch.
    GitBranchRename {
        task_id: String,
        branch: String,
        new_name: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Delete a local branch.
    GitBranchDelete {
        task_id: String,
        branch: String,
        force: bool,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Create a branch from a ref and check it out.
    GitBranchCreate {
        task_id: String,
        name: String,
        from: Option<String>,
        checkout: bool,
        overwrite: bool,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Rebase the current branch onto `target`.
    GitRebase {
        task_id: String,
        branch: String,
        target: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    /// Merge `target` into the current branch.
    GitMerge {
        task_id: String,
        target: String,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    GitPushInfo {
        task_id: String,
        reply: oneshot::Sender<Result<wire::GitPushInfo, String>>,
    },
    GitPush {
        task_id: String,
        force: bool,
        reply: oneshot::Sender<wire::GitOpResult>,
    },
    GitCreatePr {
        task_id: String,
        title: String,
        body: String,
        base: Option<String>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    GenerateText {
        task_id: String,
        agent_id: String,
        kind: wire::TextGenKind,
        model: Option<String>,
        /// Account to run against; `None` uses the agent's active one.
        account_id: Option<String>,
        /// Client-supplied text for kinds that summarise the conversation.
        input: Option<String>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    EnhanceText {
        project: String,
        agent_id: String,
        prompt: String,
        model: Option<String>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    TrackerPersistLink {
        link: crate::daemon::store::TrackerLink,
        reply: oneshot::Sender<Result<(), String>>,
    },
    TrackerLinks {
        reply: oneshot::Sender<Result<Vec<wire::TrackerLinkInfo>, String>>,
    },
    TrackerProjectSettings {
        project: String,
        reply: oneshot::Sender<Result<wire::TrackerProjectSettings, String>>,
    },
    TrackerSetProjectLinearTeam {
        project: String,
        team_id: Option<String>,
        team_name: Option<String>,
        reply: oneshot::Sender<Result<wire::TrackerProjectSettings, String>>,
    },
    TrackerSyncInputs {
        ids: Vec<String>,
        /// Links, each github project's repo dir, each linear project's team id.
        #[allow(clippy::type_complexity)]
        reply: oneshot::Sender<(
            Vec<crate::daemon::store::TrackerLink>,
            std::collections::HashMap<String, String>,
            std::collections::HashMap<String, String>,
        )>,
    },
    TrackerPersistSynced {
        links: Vec<crate::daemon::store::TrackerLink>,
        reply: oneshot::Sender<()>,
    },
    TrackerDeleteItems {
        ids: Vec<String>,
        reply: oneshot::Sender<()>,
    },
    TrackerAdoptImported {
        project: String,
        fetched: Vec<(String, Vec<crate::daemon::tracker::RemoteIssue>)>,
        #[allow(clippy::type_complexity)]
        reply: oneshot::Sender<
            Result<(Vec<wire::ImportedWorkItem>, Vec<wire::SyncedExternalItem>), String>,
        >,
    },
    BacklogGetSettings {
        reply: oneshot::Sender<Result<wire::BacklogSettings, String>>,
    },
    BacklogSetStorage {
        mode: wire::BacklogStorageMode,
        reply: oneshot::Sender<Result<wire::BacklogSettings, String>>,
    },
    BacklogList {
        project: String,
        query: crate::daemon::backlog::Query,
        reply: oneshot::Sender<Result<wire::BacklogPage, String>>,
    },
    BacklogCreate {
        item: crate::daemon::backlog::NewItem,
        reply: oneshot::Sender<Result<wire::BacklogItem, String>>,
    },
    BacklogUpdate {
        patch: crate::daemon::backlog::ItemPatch,
        reply: oneshot::Sender<Result<wire::BacklogItem, String>>,
    },
    BacklogAttachExternal {
        item_id: String,
        project: String,
        provider: String,
        external_id: String,
        url: String,
        remote_status: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    BacklogDelete {
        item_id: String,
        project: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    WorkItemLinkTask {
        item_id: String,
        task_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Send a follow-up prompt into a task's running agent session.
    SessionPrompt {
        task_id: String,
        text: String,
        attachments: Vec<wire::PromptAttachment>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Answer a permission request the agent raised.
    SessionPermission {
        task_id: String,
        request_id: String,
        outcome: String,
    },
    /// Change a session selector (model/mode/…) the agent exposes. The reply
    /// carries the agent's verdict so the UI can undo a rejected pick.
    SessionSetConfigOption {
        task_id: String,
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// The verdict of a `SessionSetConfigOption` round-trip, routed back so
    /// the actor (which owns task state) can record it: an accepted model
    /// selector change is the task's model intent; a rejected one is a
    /// durable `ModelMismatch`.
    SessionConfigOptionResult {
        task_id: String,
        config_id: String,
        value: String,
        result: Result<(), String>,
    },
    /// Detect installed ACP-capable agents (runs which/where, returns list).
    DetectAgents {
        reply: oneshot::Sender<Vec<wire::DetectedAgent>>,
    },
    /// Save agent configuration from setup wizard or settings.
    UpdateAgents {
        agents: Vec<wire::AgentConfig>,
    },
    /// Every registered agent account.
    ListAccounts {
        reply: oneshot::Sender<Vec<wire::AccountInfo>>,
    },
    /// Register the agent's current login as a new account. Replies with the
    /// updated list, or the reason the import failed.
    ImportAccount {
        agent_id: String,
        label: String,
        reply: oneshot::Sender<Result<Vec<wire::AccountInfo>, String>>,
    },
    RenameAccount {
        account_id: String,
        label: String,
        reply: oneshot::Sender<Result<Vec<wire::AccountInfo>, String>>,
    },
    RemoveAccount {
        account_id: String,
        reply: oneshot::Sender<Result<Vec<wire::AccountInfo>, String>>,
    },
    SetActiveAccount {
        agent_id: String,
        account_id: String,
        reply: oneshot::Sender<Result<Vec<wire::AccountInfo>, String>>,
    },
    /// Trigger an ACP probe for one agent's model selectors. The probe runs in
    /// a background task and reports back via [`Command::AgentProbed`]. `reply`
    /// is set only for a user-requested refresh, which waits for the verdict.
    ProbeAgent {
        id: String,
        reply: Option<oneshot::Sender<Result<(), String>>>,
    },
    /// A probe finished — persist the discovered models and re-emit agents.
    /// Deliberately does not carry `last_model`: writing the pre-probe value
    /// back would revert an explicit pick made while the probe (up to ~15s)
    /// was in flight.
    AgentProbed {
        id: String,
        models: Vec<wire::ConfigOption>,
    },
    /// Start an orchestration plan (planner→worker→reviewer pipeline).
    StartOrchestration {
        project: String,
        goal: String,
        reply: oneshot::Sender<(String, String)>,
    },
    /// List active orchestration graphs.
    ListOrchestrations {
        reply: oneshot::Sender<Vec<crate::orchestration::GraphInfo>>,
    },
    /// Get the orchestrator configuration.
    GetOrchestratorConfig {
        reply: oneshot::Sender<wire::OrchestratorConfigDto>,
    },
    /// Save the orchestrator configuration.
    SaveOrchestratorConfig {
        config: wire::OrchestratorConfigDto,
        reply: oneshot::Sender<bool>,
    },
    /// Force-set a task's status and emit a TaskUpdated event. Used by the
    /// orchestrator to reflect aggregate orchestration state on the parent task.
    SetTaskStatus {
        id: String,
        status: TaskStatus,
    },
    /// Add a project to the registry, generate config if needed, broadcast update.
    AddProject {
        path: String,
        name: Option<String>,
        /// Optional sticky port range assigned at registration, like the
        /// CLI's `warpforge add --ports`. Not a local override — a declared
        /// config range outranks it (ADR 0006).
        port_range: Option<crate::registry::PortRange>,
        reply: oneshot::Sender<Result<ProjectEntry, String>>,
    },
    /// Remove a project from the registry and broadcast the update.
    RemoveProject {
        name: String,
        stop_resources: bool,
        reply: oneshot::Sender<Result<(), ProjectRemovalError>>,
    },
    /// Set (or clear) a project's local port-range override, re-resolve every
    /// range, and broadcast the affected projects. Local registry only — the
    /// shared config is never touched (ADR 0006 invariant 1).
    SetPortRange {
        project: String,
        /// `None` clears the override.
        range: Option<crate::registry::PortRange>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Ensure a language server is running for a task's workspace + language.
    LspStart {
        task_id: String,
        language: String,
        project: Option<String>,
        reply: oneshot::Sender<wire::LspStartResult>,
    },
    /// Forward an opaque LSP message to a running server's stdin.
    LspSend {
        server_id: String,
        payload: serde_json::Value,
    },
    /// Release one editor's reference to a language server.
    LspStop {
        server_id: String,
    },
    /// Persist a durable fact into shared memory.
    MemoryStore {
        content: String,
        scope: Option<String>,
        kind: Option<String>,
        tags: Option<Vec<String>>,
        project_id: Option<String>,
        created_by: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    /// Full-text search over shared memories.
    MemorySearch {
        query: String,
        scope: Option<String>,
        limit: Option<u32>,
        mode: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryList {
        scope: Option<String>,
        kind: Option<String>,
        limit: Option<u32>,
        offset: Option<u32>,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryUpdate {
        id: String,
        content: String,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryDelete {
        id: String,
        reply: oneshot::Sender<Result<(), crate::daemon::memory::MemoryError>>,
    },
    MemoryStats {
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    SetMemoryEmbedding {
        mode: String,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryAddEdge {
        src_id: String,
        dst_id: String,
        relation: String,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryEdges {
        id: String,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryDream {
        dry_run: bool,
        project_id: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryListCompaction {
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    MemoryResolveCompaction {
        id: i64,
        approve: bool,
        reply: oneshot::Sender<Result<serde_json::Value, crate::daemon::memory::MemoryError>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
    ListAgentLimits {
        reply: oneshot::Sender<Vec<wire::AgentAccountLimits>>,
        refresh: bool,
    },
    ListAgentSpend {
        reply: oneshot::Sender<Vec<wire::AgentSpend>>,
    },
    AgentSpendUpdated {
        agents: Vec<wire::AgentSpend>,
        at: std::time::Instant,
    },
    AgentLimitsUpdated {
        accounts: Vec<wire::AgentAccountLimits>,
    },
}
