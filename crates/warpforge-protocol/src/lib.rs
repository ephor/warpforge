//! Wire types for the warpforge daemon API.
//!
//! Transport: WebSocket on 127.0.0.1 (endpoint + auth token published in
//! `~/.warpforge/daemon.json`). Every frame is a JSON object in one of three
//! shapes:
//!
//! - client → daemon  request:  `{ "id": 7, "method": "task.create", "params": { … } }`
//! - daemon → client  response: `{ "id": 7, "result": { … } }` or `{ "id": 7, "error": { … } }`
//! - daemon → client  event:    `{ "event": "service.log", "data": { … } }`
//!
//! Events are broadcast to every subscribed client — the daemon has no concept
//! of a "primary" UI. Clients call `state.subscribe` once after connecting and
//! receive a full [`Snapshot`] followed by incremental events.
//!
//! This crate is deliberately dependency-light (serde only) so the TUI, the
//! Tauri shell's Rust side, and any future client can share it without pulling
//! in daemon internals.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Version of the daemon WebSocket contract. Bump this only for a breaking
/// wire change; application versions may advance without changing it.
pub const PROTOCOL_VERSION: u32 = 1;

fn default_true() -> bool {
    true
}

fn default_search_limit() -> u32 {
    200
}

fn default_terminal_cols() -> u16 {
    80
}

fn default_terminal_rows() -> u16 {
    24
}

// ─── Envelope ────────────────────────────────────────────────────────────────

/// A client → daemon frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub method: Method,
}

/// A daemon → client frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
// Events intentionally stay inline: this is the shared wire envelope and
// boxing only one variant would leak an allocation detail into every client.
#[allow(clippy::large_enum_variant)]
pub enum ServerMessage {
    Response { id: u64, result: serde_json::Value },
    Error { id: u64, error: RpcError },
    Event(Event),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    NotFound,
    Conflict,
    AgentUnavailable,
    Internal,
    Updating,
}

// ─── Methods (client → daemon) ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum Method {
    /// Negotiate the wire contract before a client enables mutations.
    #[serde(rename = "system.handshake")]
    SystemHandshake {
        client_version: String,
        protocol_version: u32,
    },
    /// Quiesce a desktop-owned daemon and shut it down for an atomic app
    /// update. Refused for externally started daemons or active work.
    #[serde(rename = "update.prepareShutdown")]
    UpdatePrepareShutdown {
        expected_daemon_version: String,
        protocol_version: u32,
    },

    /// Subscribe to state updates. Response is a [`Snapshot`]; events follow.
    #[serde(rename = "state.subscribe")]
    StateSubscribe {
        /// Empty = everything. Otherwise topic prefixes: "task", "service",
        /// "portforward", "agent", "project".
        #[serde(default)]
        topics: Vec<String>,
    },

    // ── Projects ──
    #[serde(rename = "project.add")]
    ProjectAdd { path: String, name: Option<String> },
    #[serde(rename = "project.remove")]
    ProjectRemove {
        name: String,
        /// Explicitly authorize stopping live project resources before removal.
        /// Defaults to false so older clients fail safely when resources exist.
        #[serde(default)]
        stop_resources: bool,
    },

    // ── Runtime lifecycle ──
    /// Stop all running dev services and port-forwards without shutting down
    /// the daemon or killing agent sessions.
    #[serde(rename = "runtime.stopAll")]
    RuntimeStopAll {},

    // ── Dev servers (existing ServiceManager behaviour, exposed) ──
    #[serde(rename = "service.start")]
    ServiceStart { project: String, service: String },
    #[serde(rename = "service.stop")]
    ServiceStop { project: String, service: String },
    #[serde(rename = "service.restart")]
    ServiceRestart { project: String, service: String },
    /// Start every service declared in the project's .warpforge.yaml
    /// (what the TUI did implicitly on "Enter project").
    #[serde(rename = "service.startAll")]
    ServiceStartAll { project: String },
    #[serde(rename = "service.stopAll")]
    ServiceStopAll { project: String },
    /// Fetch a window of retained log lines (events only carry the tail).
    #[serde(rename = "service.logs")]
    ServiceLogs {
        project: String,
        service: String,
        /// Return lines with seq > after. 0 = from the oldest retained line.
        #[serde(default)]
        after: u64,
        #[serde(default)]
        limit: Option<u32>,
    },

    // ── Port-forwards ──
    #[serde(rename = "portforward.startAll")]
    PortForwardStartAll { project: String },
    #[serde(rename = "portforward.start")]
    PortForwardStart { project: String, name: String },
    #[serde(rename = "portforward.stop")]
    PortForwardStop { project: String, name: String },
    #[serde(rename = "portforward.stopAll")]
    PortForwardStopAll { project: String },
    /// Fetch a window of retained port-forward log lines.
    #[serde(rename = "portforward.logs")]
    PortForwardLogs {
        project: String,
        name: String,
        #[serde(default)]
        after: u64,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// List the project's declared services and port-forwards with their live
    /// status and allocated ports. Read-only; used by the MCP bridge so an agent
    /// can discover what runtime is up before reading logs or restarting a
    /// service.
    #[serde(rename = "runtime.list")]
    RuntimeList { project: String },

    // ── Tasks (agent sessions on the board) ──
    #[serde(rename = "task.create")]
    TaskCreate {
        project: String,
        /// Prompt / instruction handed to the agent.
        prompt: String,
        /// Agent template name from .warpforge.yaml, or a raw command.
        agent: String,
        #[serde(default)]
        tags: Vec<String>,
        /// When true (default), the daemon prepends a runtime-context block to
        /// the agent's first prompt describing the project's currently-running
        /// services and their live URLs/ports — so the agent knows the app is
        /// already up and can hit real endpoints / run tests against them.
        /// This is what ties Projects to agent work (see docs/UI_CONCEPT.md).
        #[serde(default = "default_true")]
        include_runtime_context: bool,
        /// When true, create an isolated git worktree for this task so it
        /// doesn't conflict with the main working tree or other tasks.
        #[serde(default)]
        worktree: bool,
        /// When set, this task is a sub-agent spawned by the given orchestrator
        /// task; its result is delivered back into that orchestrator's inbox.
        #[serde(default)]
        parent_task_id: Option<String>,
        /// Files and images included with the initial prompt.
        #[serde(default)]
        attachments: Vec<PromptAttachment>,
        /// Model id to apply to the agent session before the first prompt
        /// (via `session/setConfigOption`). When `None`, the daemon falls back
        /// to the agent's `last_model` so orchestrator-spawned sub-agents
        /// inherit the user's previous choice without an explicit UI pick.
        #[serde(default)]
        default_model: Option<String>,
        /// Non-model config overrides the user picked in the "New task" dialog
        /// (reasoning effort, mode, collaboration mode, fast mode, etc.).
        /// Keyed by config-option id; applied via `session/setConfigOption`
        /// after the model. Unknown option ids are logged and skipped.
        #[serde(default)]
        config_overrides: HashMap<String, String>,
        /// When set, run this task as a deterministic workflow pipeline: the
        /// created task becomes the pipeline parent (no agent session of its
        /// own) and the daemon drives plan? → implement → review ⇄ fix stages
        /// as child tasks. The id comes from `workflow.list`. Mutually
        /// exclusive with the orchestrator-chat mode.
        #[serde(default)]
        workflow: Option<String>,
        /// Id of the backlog item this task is started from, if any.
        #[serde(default)]
        backlog_item_id: Option<String>,
        /// When false, create without starting session. Defaults to true.
        #[serde(default = "default_true")]
        start: bool,
    },
    #[serde(rename = "task.cancel")]
    TaskCancel { task_id: String },
    /// Archive a finished task off the board.
    #[serde(rename = "task.archive")]
    TaskArchive { task_id: String },
    /// Delete a task and its persisted session history permanently.
    #[serde(rename = "task.delete")]
    TaskDelete { task_id: String },
    /// Override a task's title (e.g. after async title generation completes).
    #[serde(rename = "task.setTitle")]
    TaskSetTitle { task_id: String, title: String },
    /// Merge a task's worktree branch back into its base branch and remove
    /// the worktree. No-op if the task has no worktree.
    #[serde(rename = "task.mergeWorktree")]
    TaskMergeWorktree { task_id: String },
    /// List active worktrees for a project.
    #[serde(rename = "task.listWorktrees")]
    TaskListWorktrees { project: String },

    // ── Lifecycle (settle/snooze visibility overlay) ──
    /// Mark a task as settled (user acknowledged, hide from attention).
    /// Rejected while the task is Running or has pending permission requests.
    #[serde(rename = "task.settle")]
    TaskSettle { task_id: String },
    /// Clear the settled state (make the task visible again).
    #[serde(rename = "task.unsettle")]
    TaskUnsettle { task_id: String },
    /// Snooze a task until the given Unix timestamp (hide from attention).
    /// Rejected while the task has pending permission requests. Running tasks
    /// may be snoozed.
    #[serde(rename = "task.snooze")]
    TaskSnooze { task_id: String, until: u64 },
    /// Clear the snooze state (make the task visible again).
    #[serde(rename = "task.unsnooze")]
    TaskUnsnooze { task_id: String },

    // ── External agent sessions (claude/codex on-disk session stores) ──
    /// List agent sessions found on disk for a project's working directory.
    /// Returns `{ sessions: ExternalSession[] }`.
    #[serde(rename = "sessions.list")]
    SessionsList { project: String },
    /// Resume an existing external agent session as a new warpforge task.
    /// Returns `{ taskId }`.
    #[serde(rename = "task.resume")]
    TaskResume {
        project: String,
        agent: String,
        session_id: String,
        #[serde(default)]
        title: String,
    },

    /// Drain an orchestrator task's inbox of finished sub-agent results.
    /// Returns `{ results: ChildResult[] }`. Called by the orchestrator's
    /// `read_inbox` MCP tool.
    #[serde(rename = "orchestrator.readInbox")]
    OrchestratorReadInbox { parent_task_id: String },
    /// List tasks spawned by an orchestrator. The parent id is required so an
    /// orchestrator cannot accidentally inspect another task's children.
    /// Returns `{ agents: TaskInfo[] }`; `project`, when supplied, narrows the
    /// result to that project as an additional safety filter.
    #[serde(rename = "orchestrator.listAgents")]
    OrchestratorListAgents {
        parent_task_id: String,
        #[serde(default)]
        project: Option<String>,
    },

    // ── Shared memory ──
    /// Persist a durable fact into shared memory. `scope` defaults to the
    /// current project when `project_id` is supplied, else `global`.
    #[serde(rename = "memory.store")]
    MemoryStore {
        content: String,
        #[serde(default)]
        scope: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default)]
        project_id: Option<String>,
    },
    /// Full-text search over stored memories (FTS5, BM25-ranked).
    #[serde(rename = "memory.search")]
    MemorySearch {
        query: String,
        #[serde(default)]
        scope: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
        #[serde(default)]
        mode: Option<String>,
    },
    #[serde(rename = "memory.list")]
    MemoryList {
        #[serde(default)]
        scope: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
        #[serde(default)]
        offset: Option<u32>,
    },
    #[serde(rename = "memory.update")]
    MemoryUpdate { id: String, content: String },
    #[serde(rename = "memory.delete")]
    MemoryDelete { id: String },
    #[serde(rename = "memory.stats")]
    MemoryStats {},
    /// Toggle local embeddings (`none` | `fastembed`). `fastembed` downloads
    /// all-MiniLM-L6-v2 (~80 MB) on first use; falls back to FTS when offline.
    #[serde(rename = "memory.setEmbedding")]
    MemorySetEmbedding { mode: String },
    #[serde(rename = "memory.addEdge")]
    MemoryAddEdge {
        src_id: String,
        dst_id: String,
        relation: String,
    },
    #[serde(rename = "memory.edges")]
    MemoryEdges { id: String },
    #[serde(rename = "memory.dream")]
    MemoryDream {
        #[serde(default)]
        dry_run: Option<bool>,
        #[serde(default)]
        project_id: Option<String>,
    },

    // ── Agent registry ──
    /// Detect installed ACP-capable agents. Returns `{ detected: DetectedAgent[] }`.
    #[serde(rename = "agents.detect")]
    AgentsDetect {},
    /// Save the user's agent configuration (from setup wizard or settings).
    #[serde(rename = "agents.update")]
    AgentsUpdate { agents: Vec<AgentConfig> },
    /// Install or update an agent's global package (npm/brew). Runs the agent's
    /// install/update command and returns `{ ok, output }` when it finishes.
    #[serde(rename = "agents.install")]
    AgentsInstall { id: String },
    /// Re-read an agent's model/selector list from the harness, replacing the
    /// cached one. Use after adding a provider or model outside Warpforge.
    /// Resolves once the probe finishes; the refreshed list arrives as
    /// `agents.updated`.
    #[serde(rename = "agents.probe")]
    AgentsProbe { id: String },

    // ── Agent accounts (several logins per agent, one active) ──
    /// All registered accounts. Returns `{ accounts: AccountInfo[] }`.
    #[serde(rename = "accounts.list")]
    AccountsList {},
    /// Register the agent's currently-authenticated login as a new account.
    /// Returns `{ accounts: AccountInfo[] }`.
    #[serde(rename = "accounts.import")]
    AccountsImport { agent_id: String, label: String },
    /// Rename an account. Returns `{ accounts: AccountInfo[] }`.
    #[serde(rename = "accounts.rename")]
    AccountsRename { account_id: String, label: String },
    /// Remove an account and delete its vault. Returns `{ accounts: AccountInfo[] }`.
    #[serde(rename = "accounts.remove")]
    AccountsRemove { account_id: String },
    /// Make an account the one new sessions use. Returns `{ accounts: AccountInfo[] }`.
    #[serde(rename = "accounts.setActive")]
    AccountsSetActive {
        agent_id: String,
        account_id: String,
    },

    // ── ACP passthrough for a task's agent session ──
    /// Send a follow-up user message into a running session.
    #[serde(rename = "session.prompt")]
    SessionPrompt {
        task_id: String,
        text: String,
        #[serde(default)]
        attachments: Vec<PromptAttachment>,
    },
    /// Answer a permission request raised by the agent.
    #[serde(rename = "session.permission")]
    SessionPermission {
        task_id: String,
        request_id: String,
        outcome: PermissionOutcome,
    },
    /// Change a session selector (model/mode/…) the agent exposes.
    #[serde(rename = "session.setConfigOption")]
    SessionSetConfigOption {
        task_id: String,
        config_id: String,
        value: String,
    },

    // ── Diff / review ──
    #[serde(rename = "diff.get")]
    DiffGet { task_id: String },
    #[serde(rename = "diff.resolveHunk")]
    DiffResolveHunk {
        task_id: String,
        file: String,
        hunk_index: u32,
        resolution: HunkResolution,
    },
    /// Full old (HEAD) + new (working-tree) contents of one file — powers the
    /// editable side-by-side (CodeMirror merge) review.
    #[serde(rename = "file.contents")]
    FileContents {
        #[serde(default)]
        task_id: String,
        path: String,
        /// Read from the project's own checkout when no task owns the file
        /// (the project page's read-only Files surface).
        #[serde(default)]
        project: Option<String>,
    },
    /// List files in the task's project working tree.
    #[serde(rename = "file.list")]
    FileList {
        #[serde(default)]
        task_id: String,
        #[serde(default)]
        project: Option<String>,
        /// Include .gitignore'd paths (editor tree wants them; the composer's
        /// `@` picker does not — node_modules/target swamp it).
        #[serde(default)]
        include_ignored: bool,
    },
    /// Write new contents to a file in the task's working tree (in-review edit).
    #[serde(rename = "file.save")]
    FileSave {
        task_id: String,
        path: String,
        content: String,
    },
    #[serde(rename = "file.create")]
    FileCreate {
        task_id: String,
        path: String,
        #[serde(default)]
        directory: bool,
    },
    #[serde(rename = "file.rename")]
    FileRename {
        task_id: String,
        path: String,
        new_path: String,
    },
    #[serde(rename = "file.delete")]
    FileDelete { task_id: String, path: String },
    /// Plain-text search across the task's project working tree (grep). Powers
    /// "go to definition" (a symbol under the cursor resolved to its definition
    /// lines) and quick symbol lookup, without needing a full LSP server.
    #[serde(rename = "file.search")]
    FileSearch {
        task_id: String,
        /// Case-insensitive substring matched against each line.
        query: String,
        /// Cap on the number of matches returned (cheap safety valve).
        #[serde(default = "default_search_limit")]
        limit: u32,
    },
    /// Stage files and commit them in the task's repo. `files=None` stages all
    /// changes; `amend` rewrites the previous commit.
    #[serde(rename = "git.commit")]
    GitCommit {
        task_id: String,
        message: String,
        #[serde(default)]
        files: Option<Vec<String>>,
        #[serde(default)]
        amend: bool,
    },
    /// Pull the task's project repo up to its upstream (rebase + autostash).
    /// Any conflict rolls the working tree back to the exact prior state.
    #[serde(rename = "git.update")]
    GitUpdate { task_id: String },
    /// List local branches of a repo, identified either by a task or — before
    /// a task exists, as in New Task — by project name directly.
    #[serde(rename = "git.branches")]
    GitBranches {
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        project: Option<String>,
    },
    /// Switch the task's project repo to `branch`, carrying uncommitted changes
    /// across (stash → checkout → unstash). A conflict rolls back to the branch
    /// you were on with your changes intact.
    #[serde(rename = "git.switchBranch")]
    GitSwitchBranch { task_id: String, branch: String },
    /// Rename a local branch to `new_name`. Works on the checked-out branch or
    /// any other; errors if `new_name` already exists.
    #[serde(rename = "git.branchRename")]
    GitBranchRename {
        task_id: String,
        branch: String,
        new_name: String,
    },
    /// Delete a local branch. Refuses the checked-out branch; without `force`
    /// also refuses unmerged branches.
    #[serde(rename = "git.branchDelete")]
    GitBranchDelete {
        task_id: String,
        branch: String,
        #[serde(default)]
        force: bool,
    },
    /// Create `name` from `from` (defaults to the current HEAD) and check it
    /// out, carrying uncommitted changes across.
    #[serde(rename = "git.branchCreate")]
    GitBranchCreate {
        task_id: String,
        name: String,
        #[serde(default)]
        from: Option<String>,
        #[serde(default = "default_true")]
        checkout: bool,
        #[serde(default)]
        overwrite: bool,
    },
    /// Rebase the current branch onto `target`, carrying uncommitted changes
    /// across. A conflict rolls back to the prior tree.
    #[serde(rename = "git.rebase")]
    GitRebase {
        task_id: String,
        branch: String,
        target: String,
    },
    /// Merge `target` into the current branch, carrying uncommitted changes.
    /// A conflict rolls back to the prior tree.
    #[serde(rename = "git.merge")]
    GitMerge { task_id: String, target: String },
    /// Describe the commits and files that would be sent by `git.push`.
    #[serde(rename = "git.pushInfo")]
    GitPushInfo { task_id: String },
    /// Full message of the task repo's latest commit, for pre-filling an amend.
    /// Returns `{ message }`, empty when the repo has no commits yet.
    #[serde(rename = "git.lastCommitMessage")]
    GitLastCommitMessage { task_id: String },
    /// Push the current branch. With `force`, uses `--force-with-lease`.
    #[serde(rename = "git.push")]
    GitPush {
        task_id: String,
        #[serde(default)]
        force: bool,
    },
    /// Open a GitHub pull request for the task branch via `gh`. Returns
    /// `{ url }`. `base` defaults to the repo's default branch when omitted.
    #[serde(rename = "git.createPr")]
    GitCreatePr {
        task_id: String,
        title: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        base: Option<String>,
    },
    /// Generate git prose (a commit message or a PR description) by running the
    /// configured text-generation agent one-shot over the task's diff. Returns
    /// `{ text }`. `model` overrides the agent's default when set.
    #[serde(rename = "text.generate")]
    TextGenerate {
        task_id: String,
        agent_id: String,
        kind: TextGenKind,
        #[serde(default)]
        model: Option<String>,
    },
    /// Polish a task prompt (title/description written by the user) using the
    /// configured text-generation agent one-shot. Returns `{ text }`. Unlike
    /// `text.generate` it does not need a task — the backlog creates locally and
    /// this runs before a task exists.
    #[serde(rename = "text.enhance")]
    TextEnhance {
        project: String,
        agent_id: String,
        prompt: String,
        #[serde(default)]
        model: Option<String>,
    },

    // ── Raw terminal agents (legacy PTY sessions, kept for the TUI) ──
    #[serde(rename = "terminal.spawn")]
    TerminalSpawn {
        project: String,
        command: String,
        #[serde(default = "default_terminal_cols")]
        cols: u16,
        #[serde(default = "default_terminal_rows")]
        rows: u16,
    },
    #[serde(rename = "terminal.input")]
    TerminalInput {
        terminal_id: String,
        /// Base64-encoded raw bytes for the PTY.
        data_b64: String,
    },
    #[serde(rename = "terminal.resize")]
    TerminalResize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "terminal.kill")]
    TerminalKill { terminal_id: String },

    // ── Orchestration ──
    /// Start an orchestration: planner → workers → reviewers pipeline.
    /// Returns `{ graphId, taskId }` — the taskId is the parent orchestrator task.
    #[serde(rename = "orchestrate.start")]
    OrchestrateStart { project: String, goal: String },
    /// List active orchestration graphs.
    #[serde(rename = "orchestrate.list")]
    OrchestrateList {},
    /// Cancel an orchestration and its child tasks.
    #[serde(rename = "orchestrate.cancel")]
    OrchestrateCancel { graph_id: String },
    /// Get the orchestrator configuration.
    #[serde(rename = "orchestrate.getConfig")]
    OrchestrateGetConfig {},
    /// Save the orchestrator configuration.
    #[serde(rename = "orchestrate.saveConfig")]
    OrchestrateSaveConfig { config: OrchestratorConfigDto },

    // ── Workflows (deterministic pipeline templates) ──
    /// List workflows selectable for a project: `.warpforge/workflows/*.yaml`
    /// plus built-in templates (a project file overrides the built-in with the
    /// same id). Returns `{ "workflows": [WorkflowMeta] }`.
    #[serde(rename = "workflow.list")]
    WorkflowList { project: String },
    /// Copy a built-in workflow into the project's `.warpforge/workflows/`
    /// directory so it can be customized. Refuses to overwrite an existing
    /// file. Returns `{ "path": … }`.
    #[serde(rename = "workflow.eject")]
    WorkflowEject { project: String, id: String },
    /// Soft-pause a running workflow pipeline: the current stage finishes its
    /// turn, the next stage does not start. Errors when the pipeline is not
    /// in a pausable state (already waiting for the user, or finished).
    #[serde(rename = "workflow.pause")]
    WorkflowPause { task: String },
    /// Resume a paused pipeline from its stage barrier. `note`, when set, is
    /// delivered to the next stage as an extra "User guidance" block.
    #[serde(rename = "workflow.resume")]
    WorkflowResume {
        task: String,
        #[serde(default)]
        note: Option<String>,
    },
    /// Answer a stage's pending `need_user_input` question. The message is
    /// forwarded verbatim to the session that asked. Errors unless the
    /// pipeline is waiting on a question.
    #[serde(rename = "workflow.reply")]
    WorkflowReply { task: String, message: String },
    /// Decide what an out-of-rounds pipeline does next. Errors unless the
    /// pipeline is waiting on a limit decision.
    #[serde(rename = "workflow.decide")]
    WorkflowDecide {
        task: String,
        decision: WorkflowDecision,
        /// For `extend`: how many extra review ⇄ fix rounds to grant (1..=5,
        /// default 1).
        #[serde(default)]
        rounds: Option<u32>,
        /// Optional extra guidance delivered to the next fix stage.
        #[serde(default)]
        note: Option<String>,
    },

    // ── Bootstrap wizard (desktop) ──
    /// Scan the repo, build the bootstrap prompt from the user's answers, and
    /// create a config-gen task. Returns `{ taskId }`.
    #[serde(rename = "bootstrap.start")]
    BootstrapStart {
        project: String,
        answers: BootstrapAnswers,
    },
    /// Extract the YAML from an agent response and validate it. Returns
    /// `{ yaml, issues: [{ severity, message }] }`.
    #[serde(rename = "bootstrap.finalize")]
    BootstrapFinalize { response: String },
    /// Read the project's current config file and validate it. Used after a
    /// bootstrap task to review what the agent wrote. Returns
    /// `{ yaml, issues: [{ severity, message }] }`.
    #[serde(rename = "bootstrap.readConfig")]
    BootstrapReadConfig { project: String },
    /// Write the accepted YAML to the project's config file. Returns
    /// `{ ok, path }`.
    #[serde(rename = "bootstrap.writeConfig")]
    BootstrapWriteConfig { project: String, yaml: String },

    // ── LSP ──
    /// Ensure a language server is running for a task's workspace + language.
    /// Reuses an existing server for the same (workspace, language). Returns
    /// [`LspStartResult`]; `available: false` when no server binary is on PATH.
    #[serde(rename = "lsp.start")]
    LspStart { task_id: String, language: String },
    /// Forward an opaque LSP JSON-RPC message to a running server's stdin.
    #[serde(rename = "lsp.send")]
    LspSend {
        server_id: String,
        payload: serde_json::Value,
    },
    /// Release one reference to a server; the process is killed once the last
    /// editor using it closes.
    #[serde(rename = "lsp.stop")]
    LspStop { server_id: String },
    /// Detect installed/updatable language servers for the supported languages.
    /// Returns `DetectedLanguageServer[]` with install/update commands and a
    /// freshness verdict, mirroring `agents.detect`.
    #[serde(rename = "lsp.detect")]
    LanguageServersDetect {},
    /// Install (when missing) or update (when behind) a supported language
    /// server. Returns `{ ok, command, output }`.
    #[serde(rename = "lsp.install")]
    LanguageServersInstall { id: String },

    // ── Issue trackers (GitHub / Linear sync) ──
    /// Current tracker connection state. Returns `{ linear: { connected,
    /// email?, organization? } | null, github: { connected, login? } | null }`.
    #[serde(rename = "tracker.status")]
    TrackerStatus {},
    /// Connect a Linear workspace using a personal API key. The key is stored
    /// encrypted (keychain on macOS). Returns the status object.
    #[serde(rename = "tracker.connectLinear")]
    TrackerConnectLinear { api_key: String },
    /// Disconnect Linear, deleting the stored key.
    #[serde(rename = "tracker.disconnectLinear")]
    TrackerDisconnectLinear {},
    /// Connect GitHub, verifying the user's `gh` CLI session. Returns the status
    /// object.
    #[serde(rename = "tracker.connectGithub")]
    TrackerConnectGithub {},
    /// Disconnect GitHub (removes stored links; `gh` login itself is untouched).
    #[serde(rename = "tracker.disconnectGithub")]
    TrackerDisconnectGithub {},
    /// Every persisted backlog↔tracker link, so a client can hydrate its
    /// locally-stored backlog with remote ids/urls/status on connect.
    /// Returns `{ links: [TrackerLinkInfo] }`.
    #[serde(rename = "tracker.links")]
    TrackerLinks {},
    /// List every team the connected Linear key can see, so a project can be
    /// pointed at one. Returns `{ teams: [LinearTeam] }`.
    #[serde(rename = "tracker.linearTeams")]
    TrackerLinearTeams {},
    /// Read one image embedded in an issue body. The WebView has no tracker
    /// session of its own, so the daemon fetches the bytes with the
    /// credentials it already holds. Returns `TrackerAttachment`.
    #[serde(rename = "tracker.attachment")]
    TrackerAttachment {
        /// Absolute https URL, as it appeared in the issue body.
        url: String,
    },
    /// Which tracker slice a project reads. Returns `TrackerProjectSettings`.
    #[serde(rename = "tracker.projectSettings")]
    TrackerProjectSettings {
        /// Project key, e.g. "warpforge".
        project: String,
    },
    /// Point a project at a Linear team (or `null` to stop importing Linear
    /// into it). Changing this drops the rows the previous team imported.
    /// Returns the updated `TrackerProjectSettings`.
    #[serde(rename = "tracker.setProjectLinearTeam")]
    TrackerSetProjectLinearTeam {
        project: String,
        team_id: Option<String>,
        team_name: Option<String>,
    },
    /// Which sources this project can actually read and write. `local` is
    /// always true; Linear needs both a connected key and a mapped team;
    /// GitHub needs a `gh` session whose repo resolves from the project dir.
    /// Returns `ProjectSources`.
    #[serde(rename = "tracker.projectSources")]
    TrackerProjectSources {
        /// Project key, e.g. "warpforge".
        project: String,
    },
    /// Create an issue in an external tracker for a backlog item. Returns
    /// `{ itemId, externalId, url, status }`.
    #[serde(rename = "workItem.createExternal")]
    WorkItemCreateExternal {
        /// Client-generated backlog item id (uuid). The daemon keys its
        /// `tracker_links` row on this.
        item_id: String,
        /// Provider: "github" or "linear".
        provider: String,
        project: String,
        title: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        priority: WorkItemPriority,
        #[serde(default)]
        status: Option<String>,
    },
    /// Pull the latest status of external-tracker issues linked to backlog
    /// items. `ids` empty = all. Returns `{ items: [{ id, url, status }] }`.
    #[serde(rename = "workItem.syncExternal")]
    WorkItemSyncExternal {
        #[serde(default)]
        ids: Vec<String>,
    },
    /// Import open issues that exist in a tracker but have no backlog item yet.
    /// The daemon mints the item id and persists the link, so a client can
    /// insert the returned rows straight into its board.
    /// Returns `{ items: [ImportedWorkItem] }`.
    #[serde(rename = "workItem.importExternal")]
    WorkItemImportExternal {
        project: String,
        /// Provider: "github" or "linear". Omitted = every connected tracker.
        #[serde(default)]
        provider: Option<String>,
    },
    /// Read one server-paginated page from a connected external tracker.
    /// Sorting and filtering happen at the daemon boundary so the desktop does
    /// not import an entire repository into localStorage just to render a page.
    #[serde(rename = "workItem.list")]
    WorkItemList {
        project: String,
        provider: String,
        #[serde(default = "default_page")]
        page: u32,
        #[serde(default = "default_page_size")]
        page_size: u32,
        #[serde(default)]
        sort_by: String,
        #[serde(default)]
        sort_desc: bool,
        #[serde(default)]
        search: String,
        #[serde(default)]
        status: Option<String>,
    },
    /// Read the daemon-owned backlog storage configuration.
    #[serde(rename = "backlog.getSettings")]
    BacklogGetSettings {},
    /// Select YAML-file or SQLite backlog persistence.
    #[serde(rename = "backlog.setStorage")]
    BacklogSetStorage { mode: BacklogStorageMode },
    /// Read one project-scoped backlog page from the configured backend.
    #[serde(rename = "backlog.list")]
    BacklogList {
        project: String,
        #[serde(default = "default_page")]
        page: u32,
        #[serde(default = "default_page_size")]
        page_size: u32,
        #[serde(default)]
        sort_by: String,
        #[serde(default)]
        sort_desc: bool,
        #[serde(default)]
        search: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        priority: Option<String>,
        #[serde(default)]
        assignee: Option<String>,
    },
    /// Create a local backlog item in configured storage.
    #[serde(rename = "backlog.create")]
    BacklogCreate {
        project: String,
        title: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        priority: String,
        #[serde(default)]
        source: String,
        #[serde(default)]
        assignee: Option<String>,
    },
    /// Edit a backlog item's own fields. Every field is optional: absent means
    /// "leave alone", so one call can change just a priority. Returns the item.
    #[serde(rename = "backlog.update")]
    BacklogUpdate {
        item_id: String,
        project: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        priority: Option<String>,
        #[serde(default)]
        assignee: Option<String>,
    },
    #[serde(rename = "backlog.attachExternal")]
    BacklogAttachExternal {
        item_id: String,
        project: String,
        provider: String,
        external_id: String,
        url: String,
        #[serde(default)]
        remote_status: Option<String>,
    },
    /// Delete a backlog item and its tracker link (rollback for a failed
    /// external create). Returns `{ ok }`.
    #[serde(rename = "backlog.delete")]
    BacklogDelete { item_id: String, project: String },
    /// Link a daemon task to a backlog item (created when a backlog item starts
    /// its first task). Returns `{ ok }`.
    #[serde(rename = "workItem.linkTask")]
    WorkItemLinkTask { item_id: String, task_id: String },
}

/// One supported editor language and its language-server install state, sent
/// by [`Method::LanguageServersDetect`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLanguageServer {
    /// Editor language id, matching the daemon's server_command table
    /// (`typescript`, `rust`, `go`, `python`, `json`, `css`, `html`, `yaml`).
    pub id: String,
    /// User-facing label ("TypeScript / JavaScript", "Rust", …).
    pub language: String,
    pub installed: bool,
    /// Installed version of the server binary, when determinable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Latest published version (from the npm registry), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    /// Freshness verdict: "current" | "behind" | "missing" | "unknown".
    pub status: String,
    /// Shell command that installs the server. None when there is no automatable
    /// install (unknown package manager / system-only package).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    /// Shell command that updates an installed server to latest, derived from
    /// how the existing binary was installed. None when it can't be updated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_command: Option<String>,
    /// Whether the daemon can run an automated install/update for this server.
    pub can_manage: bool,
    /// Human-readable install hint shown when the server is missing.
    pub install_hint: String,
}

/// Reply to [`Method::LspStart`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspStartResult {
    pub server_id: String,
    pub available: bool,
    /// Absolute workspace root the server was rooted at. Clients build
    /// `file://` document URIs from it. Empty when unavailable.
    pub root_path: String,
}

/// Answers collected by the desktop bootstrap wizard. Mirrors the daemon's
/// `bootstrap::UserRuntimeAnswers`; `runtime_kind` is one of `local`,
/// `docker-compose`, `kubernetes`, `mixed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAnswers {
    pub agent: String,
    pub runtime_kind: String,
    #[serde(default)]
    pub compose_path: String,
    #[serde(default)]
    pub k8s_manifests_path: String,
    #[serde(default)]
    pub k8s_helm_file: String,
    #[serde(default)]
    pub k8s_release_names: String,
    #[serde(default)]
    pub k8s_namespace: String,
    #[serde(default)]
    pub dev_commands: String,
    #[serde(default)]
    pub notes: String,
}

// ── Issue trackers (GitHub / Linear sync) ───────────────────────────────────

/// Mirror of the desktop backlog's normalized statuses; these are the values
/// warpforge uses internally and maps onto each tracker's native states.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemPriority {
    Urgent,
    High,
    Medium,
    Low,
    #[default]
    None,
}

/// A single external-tracker link for a backlog item, as seen by clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerLinkInfo {
    /// The warpforge backlog item id (client-generated UUID).
    pub item_id: String,
    /// Provider: "github" or "linear".
    pub provider: String,
    /// Provider-native identifier (GHL-123, #456).
    pub external_id: String,
    pub url: String,
    /// Normalized status last observed remotely.
    #[serde(default)]
    pub status: String,
    /// Provider-native status label, if richer than the normalized one
    /// (GitHub project columns, Linear state names).
    #[serde(default)]
    pub remote_status: Option<String>,
    /// When the remote was last observed, unix seconds. 0 = never synced.
    #[serde(default)]
    pub last_synced_at: u64,
    /// Id of the daemon task this backlog item became, if any.
    #[serde(default)]
    pub task_id: Option<String>,
}

/// Linear connection state (subset of what `tracker.status` returns).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerLinearStatus {
    pub connected: bool,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub organization: Option<String>,
}

/// GitHub connection state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerGithubStatus {
    pub connected: bool,
    #[serde(default)]
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    #[serde(default)]
    pub linear: Option<TrackerLinearStatus>,
    #[serde(default)]
    pub github: Option<TrackerGithubStatus>,
}

/// One image from an issue body, already fetched. Inlined as base64 rather
/// than handed over as a URL: the renderer has no tracker session, and a
/// signed storage link expires in minutes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerAttachment {
    /// The image's MIME type, e.g. `image/png`.
    pub content_type: String,
    pub data_base64: String,
}

/// A Linear team the connected API key can see, so the desktop can point a
/// project at one instead of making anyone paste an id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

/// Which external-tracker slice a project reads. Currently just the Linear
/// team mapping; GitHub rides on the `gh` CLI session and needs none.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackerProjectSettings {
    pub project: String,
    /// Linear team id this project imports from, or `None` before any choice.
    #[serde(default)]
    pub linear_team_id: Option<String>,
    #[serde(default)]
    pub linear_team_name: Option<String>,
}

/// Per-project tracker availability. This is what the UI should key its
/// source filters and pickers on: the global connection state says nothing
/// about whether *this* project has a repo or a Linear team behind it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSources {
    pub project: String,
    /// Local items are always available.
    pub local: bool,
    /// Linear is usable only with a team mapped for this project.
    pub linear: bool,
    /// GitHub is usable only when the project dir resolves to a repo the
    /// connected `gh` session can see.
    pub github: bool,
}

/// Result of creating an external issue for a backlog item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateExternalResult {
    pub item_id: String,
    pub provider: String,
    pub external_id: String,
    pub url: String,
    pub status: String,
}

/// One synced external item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedExternalItem {
    pub id: String,
    pub url: String,
    pub status: String,
    #[serde(default)]
    pub remote_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncExternalResult {
    pub items: Vec<SyncedExternalItem>,
}

/// An issue that existed in a tracker before warpforge knew about it. The
/// daemon has already minted `item_id` and persisted the link, so the client
/// only has to add the row to its board.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedWorkItem {
    pub item_id: String,
    #[serde(default)]
    pub number: u64,
    pub provider: String,
    pub project: String,
    pub external_id: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Normalized status.
    pub status: String,
    /// Provider-native status label.
    #[serde(default)]
    pub remote_status: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    /// Remote's last-updated time, unix seconds.
    #[serde(default)]
    pub updated_at: u64,
}

/// One listing answers both questions, so the result carries both: issues that
/// became new backlog items, and already-tracked ones whose status moved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalResult {
    pub items: Vec<ImportedWorkItem>,
    #[serde(default)]
    pub synced: Vec<SyncedExternalItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkItemPage {
    pub items: Vec<ImportedWorkItem>,
    pub page: u32,
    pub page_size: u32,
    /// Exact when provider exposes a count; otherwise omitted and clients use
    /// `hasNextPage` for forward pagination.
    #[serde(default)]
    pub total: Option<u64>,
    pub has_next_page: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum BacklogStorageMode {
    #[default]
    Sqlite,
    Yaml,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BacklogSettings {
    pub mode: BacklogStorageMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BacklogItem {
    pub id: String,
    pub number: u64,
    pub project: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub status: String,
    pub priority: String,
    pub source: String,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub remote_status: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BacklogPage {
    pub items: Vec<BacklogItem>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
    pub has_next_page: bool,
}

fn default_page() -> u32 {
    0
}

fn default_page_size() -> u32 {
    20
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    Allow,
    AllowAlways,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HunkResolution {
    Accept,
    Reject,
}

// ─── Events (daemon → client) ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// Full state snapshot, sent as the reply-adjacent first event after
    /// `state.subscribe` and again after daemon-side recovery.
    #[serde(rename = "state.snapshot")]
    Snapshot(Snapshot),

    #[serde(rename = "project.added")]
    ProjectAdded(ProjectInfo),
    #[serde(rename = "project.removed")]
    ProjectRemoved { name: String },
    /// A registered project's .warpforge.yaml changed. Replaces only the
    /// config-derived slice of client state; task/session history is untouched.
    #[serde(rename = "project.configChanged")]
    ProjectConfigChanged(ProjectConfigState),

    #[serde(rename = "service.status")]
    ServiceStatus {
        project: String,
        service: String,
        status: ServiceStatus,
        allocated_port: u16,
    },
    #[serde(rename = "service.log")]
    ServiceLog {
        project: String,
        service: String,
        /// Monotonic per-service sequence number so clients can detect gaps
        /// and backfill via `service.logs`.
        seq: u64,
        line: String,
    },

    #[serde(rename = "portforward.status")]
    PortForwardStatus {
        project: String,
        name: String,
        status: PortForwardStatus,
    },
    #[serde(rename = "portforward.log")]
    PortForwardLog {
        project: String,
        name: String,
        seq: u64,
        line: String,
    },

    #[serde(rename = "task.created")]
    TaskCreated(TaskInfo),
    #[serde(rename = "task.updated")]
    TaskUpdated(TaskInfo),
    /// A task was deleted; clients should drop it from all views.
    #[serde(rename = "task.removed")]
    TaskRemoved { id: String },

    /// Structured ACP session update for a task: tool calls, agent text,
    /// file edits, permission requests. Mirrors ACP `session/update`.
    #[serde(rename = "session.update")]
    SessionUpdate {
        task_id: String,
        update: SessionUpdate,
    },

    /// Daemon detected installed agents on first start; no agents configured
    /// yet. Frontend should show the setup wizard.
    #[serde(rename = "agents.setup_needed")]
    AgentsSetupNeeded { detected: Vec<DetectedAgent> },

    /// Agent registry updated (after setup wizard or settings change).
    #[serde(rename = "agents.updated")]
    AgentsUpdated { agents: Vec<AgentConfig> },

    /// Account list or active selection changed.
    #[serde(rename = "accounts.updated")]
    AccountsUpdated { accounts: Vec<AccountInfo> },

    /// Terminal (PTY) screen changed. Carries the rendered screen contents,
    /// not raw bytes — every client sees the same vt100 state.
    #[serde(rename = "terminal.screen")]
    TerminalScreen {
        terminal_id: String,
        screen: TerminalScreen,
    },
    /// A new terminal was spawned. Additive: clients add this TerminalInfo to
    /// their snapshot.terminals projection. The terminal stays in the snapshot
    /// until a `terminal.exited` event removes it.
    #[serde(rename = "terminal.spawned")]
    TerminalSpawned(TerminalInfo),
    /// Raw PTY output bytes (base64). Additive with terminal.screen — clients
    /// that render via a terminal emulator (xterm.js) use this instead of the
    /// rendered screen spans. Bounded to the <=4096-byte read chunk.
    #[serde(rename = "terminal.data")]
    TerminalData {
        terminal_id: String,
        data_b64: String,
    },
    #[serde(rename = "terminal.exited")]
    TerminalExited { terminal_id: String, code: i32 },

    // ── Orchestration ──
    /// A worker/reviewer node was dispatched.
    #[serde(rename = "orchestration.nodeDispatched")]
    OrchestrationNodeDispatched {
        graph_id: String,
        node_id: String,
        task_id: String,
        agent: String,
        kind: String,
    },
    /// A node completed successfully.
    #[serde(rename = "orchestration.nodeCompleted")]
    OrchestrationNodeCompleted {
        graph_id: String,
        node_id: String,
        task_id: String,
    },
    /// A node failed.
    #[serde(rename = "orchestration.nodeFailed")]
    OrchestrationNodeFailed {
        graph_id: String,
        node_id: String,
        task_id: String,
        reason: String,
    },
    /// All nodes in the orchestration are done.
    #[serde(rename = "orchestration.allComplete")]
    OrchestrationAllComplete { graph_id: String, project: String },

    // ── LSP ──
    /// An opaque LSP JSON-RPC message from a server's stdout.
    #[serde(rename = "lsp.message")]
    LspMessage {
        server_id: String,
        payload: serde_json::Value,
    },
    /// A language server exited (crashed or was stopped).
    #[serde(rename = "lsp.exit")]
    LspExit {
        server_id: String,
        code: Option<i32>,
    },
}

// ─── State DTOs ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub projects: Vec<ProjectInfo>,
    pub services: Vec<ServiceInfo>,
    pub portforwards: Vec<PortForwardInfo>,
    pub tasks: Vec<TaskInfo>,
    pub terminals: Vec<TerminalInfo>,
    /// Persisted session conversation history keyed by task id. Sent on
    /// `state.subscribe` so clients can reconstruct conversations without
    /// polling. Omitted from the wire when empty.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub session_history: HashMap<String, Vec<SessionUpdate>>,
    /// All configured agents (enabled or not). Empty until the user completes
    /// the setup wizard.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentConfig>,
    /// Registered agent accounts. Empty until the user adds one; a single
    /// account is still listed so the switcher can show which one is live.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<AccountInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    /// Inclusive port range assigned to this project.
    pub port_range: (u16, u16),
    /// Services declared in .warpforge.yaml (may not be running).
    pub declared_services: Vec<String>,
    pub agent_templates: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigState {
    pub project: ProjectInfo,
    pub services: Vec<ServiceInfo>,
    pub portforwards: Vec<PortForwardInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub project: String,
    pub name: String,
    pub command: String,
    pub status: ServiceStatus,
    pub original_port: u16,
    pub allocated_port: u16,
    /// Sequence number of the newest retained log line.
    pub log_seq: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceStatus {
    Starting,
    Running,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub project: String,
    pub name: String,
    pub namespace: String,
    pub pod: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub status: PortForwardStatus,
    pub log_seq: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortForwardStatus {
    Starting,
    Active,
    Restarting,
    Failed,
    Stopped,
}

/// A task on the board: one agent session working on one prompt in one project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub project: String,
    pub prompt: String,
    pub agent: String,
    pub status: TaskStatus,
    pub tags: Vec<String>,
    /// Short imperative label derived from the prompt, or set explicitly. May
    /// be empty when no title has been generated or set yet.
    #[serde(default)]
    pub title: String,
    /// Unix seconds.
    pub created_at: u64,
    pub updated_at: u64,
    /// Files touched so far (drives the board card's diff badge).
    pub files_changed: u32,
    /// Set when status == Blocked or Failed.
    pub blocked_reason: Option<String>,
    /// Session selectors (model/mode/…) reported by the agent. The daemon
    /// persists the last known set so resumed/interrupted tasks can still show
    /// their controls after a restart.
    #[serde(default)]
    pub config_options: Vec<ConfigOption>,
    /// Path to the git worktree for this task, if isolated.
    /// `null` / omitted when the task runs in the project's main working dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// Orchestration graph for parent orchestrator tasks. Contains child nodes
    /// (workers/reviewers) each with their own task_id for navigation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_graph: Option<OrchGraphInfo>,
    /// Task that spawned this task through the orchestrator MCP. Keeping this
    /// on the wire lets clients present the child in its parent's context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    /// Live workflow pipeline state for workflow parent tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run: Option<WorkflowRunInfo>,
    /// Explicit settle override (true = settled, false = not settled).
    /// `None` = derive from execution status only (no manual override).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_override: Option<bool>,
    /// Unix seconds when the task was last settled. `None` = never settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<u64>,
    /// Unix seconds until which the task is snoozed (hidden from attention).
    /// `None` = not snoozed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<u64>,
    /// Unix seconds when the current snooze was set. `None` = not snoozed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_at: Option<u64>,
    /// Id of the backlog item this task was started from, if any. Lets clients
    /// keep the board's backlog item and its agent task linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backlog_item_id: Option<String>,
}

/// A task's lifecycle. Deliberately **not** an axis for derived facts: whether
/// a `Waiting` task has a diff worth looking at is `files_changed > 0`, which is
/// already its own field. Splitting that out into a status is what turned the
/// old `NeedsReview` into a settling tank that every finished task fell into.
///
/// `Interrupted` covers sessions whose live ACP handle was lost to a daemon
/// restart. If the task has a saved native session id and the agent supports
/// `session/load`, the daemon can reconnect when the user continues.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Created; the agent has not started.
    Queued,
    /// The agent is actively working.
    Running,
    /// The agent yielded its turn and the ball is in the human's court. Merges
    /// the former `Idle` and `NeedsReview`, which named one lifecycle state
    /// twice. Both legacy strings still deserialize into this variant.
    #[serde(alias = "idle", alias = "needs_review")]
    Waiting,
    /// The agent is genuinely stuck and needs a decision or a permission grant.
    Blocked,
    /// The run was cut short (user stop / workflow stop); the work is
    /// incomplete. Distinct from `Waiting`, where the agent chose to yield.
    Interrupted,
    /// Finished or archived.
    Done,
}

/// Structured agent-session update, a deliberately small projection of ACP's
/// `session/update` notification. Extend as views need more.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageCost {
    pub amount: f64,
    pub currency: String,
}

/// One agent session referenced by an inline workflow timeline event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEventAgent {
    pub task_id: String,
    pub label: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowEventKind {
    WorkflowStarted,
    StageStarted,
    AgentOutput,
    ReviewResult,
    Status,
    WorkflowFinished,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowEventTone {
    Info,
    Running,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionUpdate {
    /// The developer's own prompt, echoed by the daemon into the stream so
    /// every attached client shows the same conversation.
    UserMessage {
        text: String,
        #[serde(default)]
        attachments: Vec<PromptAttachmentSummary>,
    },
    PromptCapabilities {
        image: bool,
        embedded_context: bool,
    },
    AgentText {
        text: String,
    },
    /// A durable, independently rendered entry in a workflow parent's
    /// Conversation timeline. Unlike streamed AgentText chunks these records
    /// never coalesce, and agent references remain clickable after completion.
    WorkflowEvent {
        event: WorkflowEventKind,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stage: Option<WorkflowStage>,
        #[serde(default)]
        agents: Vec<WorkflowEventAgent>,
        tone: WorkflowEventTone,
    },
    AgentThought {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        status: ToolCallStatus,
        /// Unix epoch milliseconds when the daemon first observed this call.
        /// Optional for histories written by older Warpforge versions.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<u64>,
        /// ACP tool kind: read/edit/delete/move/search/execute/think/fetch/other.
        #[serde(default)]
        tool_kind: String,
        /// Rendered tool output/content, if the agent included any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    FileEdit {
        path: String,
        /// ACP tool-call id, used by clients to coalesce lifecycle frames for
        /// the same edit. Optional for histories written by older versions.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        /// Line-level changes reported by this individual edit operation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        additions: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deletions: Option<u32>,
        /// Compact per-operation hunks derived from ACP's oldText/newText.
        /// Older histories and lower-fidelity agents may not include them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hunks: Vec<EditHunk>,
    },
    PermissionRequest {
        request_id: String,
        title: String,
        options: Vec<String>,
    },
    /// A permission request the developer answered — recorded in the stream so
    /// the resolved state survives reopen/restart (the request itself lingers).
    PermissionResolved {
        request_id: String,
        outcome: String,
    },
    /// The agent's plan / todo list (ACP `plan` update).
    Plan {
        entries: Vec<PlanEntry>,
    },
    /// Slash-commands the agent exposes (ACP `available_commands_update`).
    AvailableCommands {
        commands: Vec<CommandInfo>,
    },
    /// Current ACP context-window utilization and optional cumulative cost.
    Usage {
        used: u64,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<SessionUsageCost>,
    },
    TurnEnded {
        stop_reason: String,
    },
}

/// One concrete edit operation reported by ACP. Unlike `Hunk`, this is scoped
/// to one tool call rather than the aggregate working-tree diff against HEAD.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Only changed lines, prefixed with '+' or '-'.
    pub lines: Vec<String>,
}

/// 1-based, inclusive source line span.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// A transient attachment sent with a prompt. Image data is never persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptAttachment {
    File {
        path: String,
        /// When present, only the inclusive line span is attached as context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<LineRange>,
    },
    Image {
        name: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
    },
}

/// Safe, persistence-friendly attachment metadata stored in the transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptAttachmentSummary {
    File { path: String },
    Image { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    /// "pending" | "in_progress" | "completed".
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// A session-level selector the agent exposes (ACP `configOptions`): model,
/// mode, reasoning effort, etc. We surface it read-only for now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    /// "mode" | "model" | "model_config" | "thought_level" | …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub current_value: String,
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

// ─── Git operations (update / branch switch) ────────────────────────────────

/// Machine-readable outcome of a `git.update` / `git.switchBranch` op.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitOpStatus {
    /// Nothing to do — already up to date / already on that branch.
    UpToDate,
    /// Completed cleanly (pulled, or switched with changes carried over).
    Ok,
    /// A conflict was hit and the working tree was rolled back to the exact
    /// prior state. `conflicts` lists the files that blocked it.
    Conflict,
    /// Precondition failed (no upstream, detached HEAD, unknown branch, …).
    Error,
}

/// Result of `git.update` / `git.switchBranch`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    pub status: GitOpStatus,
    /// Human-readable one-liner for the toast/banner.
    pub message: String,
    /// Files that blocked the op (on `Conflict`); empty otherwise.
    #[serde(default)]
    pub conflicts: Vec<String>,
    /// Current branch after the op (so the UI can refresh its chip).
    #[serde(default)]
    pub branch: Option<String>,
}

/// Result of `git.branches`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
    #[serde(default)]
    pub current: Option<String>,
    pub branches: Vec<String>,
    /// Remote-tracking refs, e.g. `["origin/main", "origin/feature/x"]`.
    #[serde(default)]
    pub remotes: Vec<String>,
}

/// One file contained in an outgoing commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushFile {
    pub path: String,
    /// Git's compact name-status code (`A`, `M`, `D`, `R`, …).
    pub status: String,
}

/// One commit that is not present on the push target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub files: Vec<GitPushFile>,
}

/// Which kind of git prose `text.generate` should produce.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextGenKind {
    /// A conventional-commit message for the working-tree changes.
    CommitMessage,
    /// A pull-request title + body for the branch's outgoing commits.
    PrDescription,
    /// A short (≤60 chars) imperative title derived from a task's first prompt.
    TaskTitle,
    /// A polished, well-structured rewrite of a user-written task prompt.
    EnhancePrompt,
}

/// Preview returned by `git.pushInfo`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushInfo {
    pub branch: String,
    pub remote: String,
    pub remote_branch: String,
    /// Configured upstream, or the target Warpforge will create on first push.
    pub upstream: String,
    pub has_upstream: bool,
    pub commits: Vec<GitPushCommit>,
}

// ─── Diff / review ───────────────────────────────────────────────────────────

/// Result of `diff.get`: the task's working-tree changes, per file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub task_id: String,
    pub files: Vec<FileDiff>,
    /// Current git branch of the task's project, if it's a repo.
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileDiffStatus,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileDiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Unified-diff body lines, each prefixed with ' ', '+', or '-'.
    pub lines: Vec<String>,
    pub resolution: Option<HunkResolution>,
}

/// Result of `file.contents`: a file's HEAD (old) and working-tree (new) text,
/// for the editable side-by-side (CodeMirror merge) review.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDoc {
    pub path: String,
    pub status: FileDiffStatus,
    pub old_text: String,
    pub new_text: String,
    /// Base64-encoded binary content for images (PNG, JPG, etc). None for text files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_data_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_data_base64: Option<String>,
}

/// Result of `file.list`: project files available to open in the editor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    #[serde(default)]
    pub changed: bool,
}

/// One line-level match from `file.search` — a project path plus 1-based line and
/// column where `query` appears, with the matching source line for context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

// ─── Terminal agents (legacy PTY path) ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub project: String,
    pub command: String,
    pub started_at: u64,
    pub cols: u16,
    pub rows: u16,
}

/// A rendered vt100 screen. Row-oriented so clients don't need a terminal
/// emulator: the daemon owns the single authoritative vt100 parser.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreen {
    pub cols: u16,
    pub rows: u16,
    pub cursor: (u16, u16),
    /// One entry per row; each row is a run-length list of styled spans.
    pub rows_content: Vec<Vec<StyledSpan>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyledSpan {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inverse: bool,
}

// ─── Agent registry ──────────────────────────────────────────────────────────

/// A user-configured ACP agent (persisted in SQLite, managed via UI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub display_name: String,
    /// The ACP server command run as `sh -c <acp_command>`.
    pub acp_command: String,
    pub enabled: bool,
    /// Cached model/effort selectors the agent exposed via its last ACP
    /// `session/update` (`configOptions`). Probed once on enable and refreshed
    /// on daemon startup so the New Task view can offer a model picker before
    /// any prompt is sent. Empty when the probe failed or the agent exposes no
    /// model selector.
    #[serde(default)]
    pub models: Vec<ConfigOption>,
    /// Last model the user explicitly picked when starting a task with this
    /// agent. Used as the default for new tasks and for orchestrator-spawned
    /// sub-agents (which have no UI to pick from). `None` until the first
    /// explicit choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_model: Option<String>,
}

/// An agent candidate surfaced by auto-detection (sent in the setup popup).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub default_acp_command: String,
    pub install_hint: String,
    /// Installed version, when it could be determined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Latest published version (from the npm registry), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    /// Freshness verdict: "current" | "behind" | "missing" | "unknown".
    pub status: String,
    /// Shell command that installs the agent (npm/brew). None when there is no
    /// automatable install (unknown package manager).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    /// Shell command that updates the agent to latest, derived from how the
    /// existing binary was installed. None when we can't update it safely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_command: Option<String>,
    /// Whether the daemon can run an automated install/update for this agent.
    pub can_manage: bool,
}

/// One registered login for an agent. Carries only what the switcher shows —
/// credentials never cross this boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    /// Stable id, `"<agent>:<slug>"`.
    pub id: String,
    pub agent_id: String,
    /// User-facing name ("personal", "work"). Editable.
    pub label: String,
    /// Account email, read out of the agent's own credential metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Plan or seat tier, when the agent reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Whether new sessions for this agent use this account.
    pub active: bool,
}

/// An agent session discovered on disk (claude/codex native session store),
/// resumable via `task.resume` → ACP `session/load`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    /// Agent id this session belongs to ("claude" | "codex").
    pub agent: String,
    /// The agent's native session id (uuid) — passed to ACP `session/load`.
    pub session_id: String,
    /// Human-readable title (first user prompt or codex thread name); may be empty.
    pub title: String,
    /// Unix seconds of last activity (file mtime / index timestamp).
    pub updated_at: u64,
    /// Rough message count (0 if unknown).
    pub message_count: u32,
}

/// A git worktree for an isolated task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub task_id: String,
    pub path: String,
    pub branch: String,
    pub base_branch: String,
}

/// Contents of `~/.warpforge/daemon.json`, written by the daemon on startup
/// so clients can discover the endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEndpoint {
    pub pid: u32,
    /// e.g. "ws://127.0.0.1:61814"
    pub url: String,
    /// Random per-daemon-start token; clients send it as the first frame:
    /// `{ "auth": "<token>" }`.
    pub token: String,
    pub version: String,
    #[serde(default)]
    pub protocol_version: u32,
    #[serde(default)]
    pub owner: DaemonOwner,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaemonOwner {
    Desktop,
    #[default]
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHandshake {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub owner: DaemonOwner,
    pub protocol_compatible: bool,
    pub exact_version_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHandoff {
    pub ready: bool,
    #[serde(default)]
    pub blockers: Vec<String>,
}

// ─── Orchestration DTOs ──────────────────────────────────────────────────────

/// Orchestration graph info, embedded in a parent TaskInfo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchGraphInfo {
    pub id: String,
    pub goal: String,
    pub nodes: Vec<OrchNodeInfo>,
}

/// A single node in the orchestration graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchNodeInfo {
    pub id: String,
    pub kind: OrchNodeKind,
    pub agent: String,
    pub status: OrchNodeStatus,
    /// Task ID on the board — click to open TaskDetail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Node result text from the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchNodeKind {
    Plan,
    Implement,
    Review,
    Merge,
    /// Workflow-pipeline repair stage (fix findings from a review round).
    Fix,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchNodeStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Skipped,
}

/// One selectable workflow template, as returned by `workflow.list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMeta {
    pub id: String,
    /// Display name from the YAML; falls back to the id for invalid files.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: WorkflowSource,
    /// False when the file failed to parse or validate — such workflows are
    /// listed (greyed out in the picker, `error` in the tooltip) but cannot
    /// be selected.
    pub valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Non-fatal issues (unknown keys, clamped values).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Stage names for the picker tooltip, e.g. ["plan","implement","review×2","fix"].
    /// Empty for invalid files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<String>,
    /// Review ⇄ fix round limit. 0 for invalid files.
    #[serde(default)]
    pub max_rounds: u32,
}

/// Where a workflow definition comes from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowSource {
    Project,
    Builtin,
}

/// A `workflow.decide` choice after review rounds are exhausted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowDecision {
    /// Grant extra review ⇄ fix rounds and continue.
    Extend,
    /// Finish as Waiting with the open findings in the summary.
    Finish,
    /// Stop the pipeline (parent becomes Interrupted).
    Stop,
}

/// Live state of a workflow pipeline, carried on the parent task and updated
/// via `task.updated` events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunInfo {
    pub workflow_id: String,
    pub workflow_name: String,
    pub stage: WorkflowStage,
    /// Current review round, 1-based; 0 until the first review starts.
    pub round: u32,
    /// Effective round limit: the YAML `max_rounds` plus user-granted
    /// extensions.
    pub max_rounds: u32,
    /// Latest merged review verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<WorkflowVerdict>,
    /// Present while the pipeline waits for the user — the parent composer
    /// opens on this, and it drives the attention ("Needs you") rail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<WorkflowWaiting>,
    /// A pause has been requested and takes effect when the running stage
    /// finishes. Lets the UI show progress instead of an idle Pause button.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pause_requested: bool,
}

/// Pipeline position for display.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStage {
    Plan,
    Implement,
    Review,
    Fix,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowVerdict {
    Approve,
    RequestChanges,
}

/// Why a pipeline is suspended and what input unblocks it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowWaiting {
    pub kind: WorkflowWaitKind,
    /// Which stage asked (for `question`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<WorkflowStage>,
    /// The question text (for `question`), or a short findings summary (for
    /// `limit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowWaitKind {
    /// A stage asked `need_user_input` — answer with `workflow.reply`.
    Question,
    /// Review rounds exhausted with open findings — answer with
    /// `workflow.decide`.
    Limit,
    /// Soft-paused — continue with `workflow.resume`.
    Paused,
}

/// Orchestrator configuration DTO (wire format).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorConfigDto {
    pub planner_agent: String,
    pub worker_pool: Vec<OrchWorkerPoolDto>,
    pub reviewer_pool: Vec<OrchReviewerPoolDto>,
    pub worktrees_enabled: bool,
}

impl Default for OrchestratorConfigDto {
    fn default() -> Self {
        Self {
            planner_agent: "claude".into(),
            worker_pool: vec![
                OrchWorkerPoolDto {
                    agent: "claude".into(),
                },
                OrchWorkerPoolDto {
                    agent: "codex".into(),
                },
            ],
            reviewer_pool: vec![OrchReviewerPoolDto {
                agent: "opencode".into(),
            }],
            worktrees_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchWorkerPoolDto {
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchReviewerPoolDto {
    pub agent: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_waiting_absorbs_the_legacy_spellings() {
        // A daemon may be newer than the client that persisted a snapshot, and
        // `task.updated` payloads are replayed from disk — so both pre-merge
        // spellings must still deserialize.
        let from_idle: TaskStatus = serde_json::from_str(r#""idle""#).unwrap();
        let from_review: TaskStatus = serde_json::from_str(r#""needs_review""#).unwrap();
        assert_eq!(from_idle, TaskStatus::Waiting);
        assert_eq!(from_review, TaskStatus::Waiting);

        // Only the new spelling is ever written.
        assert_eq!(
            serde_json::to_string(&TaskStatus::Waiting).unwrap(),
            r#""waiting""#
        );
    }

    #[test]
    fn agents_detect_roundtrip() {
        // Struct variant with empty params — client always sends params:{}.
        let json: serde_json::Value =
            serde_json::from_str(r#"{"id":1,"method":"agents.detect","params":{}}"#).unwrap();
        let req: Request = serde_json::from_value(json).unwrap();
        assert_eq!(req.id, 1);
        assert!(matches!(req.method, Method::AgentsDetect {}));
    }

    #[test]
    fn agents_probe_roundtrip() {
        let json: serde_json::Value =
            serde_json::from_str(r#"{"id":4,"method":"agents.probe","params":{"id":"opencode"}}"#)
                .unwrap();
        let req: Request = serde_json::from_value(json).unwrap();
        assert!(matches!(req.method, Method::AgentsProbe { id } if id == "opencode"));
    }

    #[test]
    fn git_last_commit_message_roundtrip() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"id":5,"method":"git.lastCommitMessage","params":{"task_id":"t1"}}"#,
        )
        .unwrap();
        let req: Request = serde_json::from_value(json).unwrap();
        assert!(matches!(req.method, Method::GitLastCommitMessage { task_id } if task_id == "t1"));
    }

    #[test]
    fn orchestrator_list_agents_wire_shape() {
        let req = Request {
            id: 9,
            method: Method::OrchestratorListAgents {
                parent_task_id: "t_parent".into(),
                project: Some("demo".into()),
            },
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["method"], "orchestrator.listAgents");
        assert_eq!(json["params"]["parent_task_id"], "t_parent");
        assert_eq!(json["params"]["project"], "demo");

        let back: Request = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);

        let no_project: Request = serde_json::from_value(serde_json::json!({
            "id": 10,
            "method": "orchestrator.listAgents",
            "params": { "parent_task_id": "t_parent" }
        }))
        .unwrap();
        assert!(matches!(
            no_project.method,
            Method::OrchestratorListAgents { project: None, .. }
        ));
    }

    #[test]
    fn request_wire_shape() {
        let req = Request {
            id: 7,
            method: Method::TaskCreate {
                project: "my-app".into(),
                prompt: "fix the login bug".into(),
                agent: "claude".into(),
                tags: vec!["bug".into()],
                include_runtime_context: true,
                worktree: false,
                parent_task_id: None,
                attachments: vec![],
                default_model: Some("opus".into()),
                config_overrides: Default::default(),
                workflow: None,
                backlog_item_id: None,
            },
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["id"], 7);
        assert_eq!(json["method"], "task.create");
        assert_eq!(json["params"]["project"], "my-app");

        let back: Request = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);
    }

    #[test]
    fn prompt_attachments_are_backward_compatible_and_roundtrip() {
        let old: Request = serde_json::from_str(
            r#"{"id":1,"method":"session.prompt","params":{"task_id":"t1","text":"hi"}}"#,
        )
        .unwrap();
        assert!(
            matches!(old.method, Method::SessionPrompt { attachments, .. } if attachments.is_empty())
        );

        for attachment in [
            PromptAttachment::File {
                path: "src/main.rs".into(),
                range: None,
            },
            PromptAttachment::File {
                path: "src/main.rs".into(),
                range: Some(LineRange { start: 4, end: 12 }),
            },
            PromptAttachment::Image {
                name: "shot.png".into(),
                mime_type: "image/png".into(),
                data: "AA==".into(),
            },
        ] {
            let value = serde_json::to_value(&attachment).unwrap();
            assert_eq!(
                serde_json::from_value::<PromptAttachment>(value).unwrap(),
                attachment
            );
        }

        let old_history: SessionUpdate =
            serde_json::from_str(r#"{"kind":"user_message","text":"hello"}"#).unwrap();
        assert!(
            matches!(old_history, SessionUpdate::UserMessage { attachments, .. } if attachments.is_empty())
        );

        let old_tool: SessionUpdate = serde_json::from_str(
            r#"{"kind":"tool_call","tool_call_id":"t1","title":"wait","status":"in_progress","tool_kind":"execute"}"#,
        )
        .unwrap();
        assert!(matches!(
            old_tool,
            SessionUpdate::ToolCall {
                started_at: None,
                ..
            }
        ));

        let old_file_edit: SessionUpdate =
            serde_json::from_str(r#"{"kind":"file_edit","path":"src/main.rs"}"#).unwrap();
        assert!(matches!(
            old_file_edit,
            SessionUpdate::FileEdit {
                tool_call_id: None,
                additions: None,
                deletions: None,
                hunks,
                ..
            } if hunks.is_empty()
        ));

        let detailed_file_edit = SessionUpdate::FileEdit {
            path: "src/main.rs".into(),
            tool_call_id: Some("edit-1".into()),
            additions: Some(1),
            deletions: Some(1),
            hunks: vec![EditHunk {
                old_start: 4,
                old_lines: 1,
                new_start: 4,
                new_lines: 1,
                lines: vec!["-old".into(), "+new".into()],
            }],
        };
        let value = serde_json::to_value(&detailed_file_edit).unwrap();
        assert_eq!(value["hunks"][0]["newStart"], 4);
        assert_eq!(
            serde_json::from_value::<SessionUpdate>(value).unwrap(),
            detailed_file_edit
        );
    }

    #[test]
    fn workflow_event_keeps_agent_links_as_distinct_wire_records() {
        let update = SessionUpdate::WorkflowEvent {
            event: WorkflowEventKind::StageStarted,
            title: "Implement started".into(),
            detail: None,
            stage: Some(WorkflowStage::Implement),
            agents: vec![WorkflowEventAgent {
                task_id: "t_impl".into(),
                label: "implement".into(),
                agent: "codex".into(),
                model: Some("gpt-5.6-sol".into()),
            }],
            tone: WorkflowEventTone::Running,
        };
        let value = serde_json::to_value(&update).unwrap();
        assert_eq!(value["kind"], "workflow_event");
        assert_eq!(value["event"], "stage_started");
        assert_eq!(value["stage"], "implement");
        assert_eq!(value["agents"][0]["taskId"], "t_impl");
        assert_eq!(
            serde_json::from_value::<SessionUpdate>(value).unwrap(),
            update
        );
    }

    #[test]
    fn event_wire_shape() {
        let ev = Event::ServiceLog {
            project: "my-app".into(),
            service: "db".into(),
            seq: 42,
            line: "ready".into(),
        };
        let json = serde_json::to_value(ServerMessage::Event(ev.clone())).unwrap();
        assert_eq!(json["event"], "service.log");
        assert_eq!(json["data"]["seq"], 42);

        let back: ServerMessage = serde_json::from_value(json).unwrap();
        assert_eq!(back, ServerMessage::Event(ev));
    }

    #[test]
    fn response_vs_error_disambiguation() {
        let ok: ServerMessage =
            serde_json::from_str(r#"{"id":1,"result":{"taskId":"abc"}}"#).unwrap();
        assert!(matches!(ok, ServerMessage::Response { id: 1, .. }));

        let err: ServerMessage = serde_json::from_str(
            r#"{"id":2,"error":{"code":"not_found","message":"no such task"}}"#,
        )
        .unwrap();
        match err {
            ServerMessage::Error { id, error } => {
                assert_eq!(id, 2);
                assert_eq!(error.code, ErrorCode::NotFound);
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn old_daemon_endpoint_defaults_to_external_and_unknown_protocol() {
        let endpoint: DaemonEndpoint = serde_json::from_str(
            r#"{"pid":42,"url":"ws://127.0.0.1:1","token":"t","version":"0.1.0"}"#,
        )
        .unwrap();
        assert_eq!(endpoint.protocol_version, 0);
        assert_eq!(endpoint.owner, DaemonOwner::External);
    }

    #[test]
    fn update_methods_keep_the_documented_wire_shape() {
        let handshake = serde_json::to_value(Request {
            id: 1,
            method: Method::SystemHandshake {
                client_version: "0.2.0".into(),
                protocol_version: PROTOCOL_VERSION,
            },
        })
        .unwrap();
        assert_eq!(handshake["method"], "system.handshake");
        assert_eq!(handshake["params"]["client_version"], "0.2.0");

        let handoff = serde_json::to_value(Request {
            id: 2,
            method: Method::UpdatePrepareShutdown {
                expected_daemon_version: "0.2.0".into(),
                protocol_version: PROTOCOL_VERSION,
            },
        })
        .unwrap();
        assert_eq!(handoff["method"], "update.prepareShutdown");
        assert_eq!(handoff["params"]["expected_daemon_version"], "0.2.0");
    }

    #[test]
    fn snapshot_event_roundtrip() {
        let ev = Event::Snapshot(Snapshot::default());
        let json = serde_json::to_string(&ev).unwrap();
        let back: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ev);
    }

    #[test]
    fn project_config_changed_event_roundtrip() {
        let ev = Event::ProjectConfigChanged(ProjectConfigState {
            project: ProjectInfo {
                name: "demo".into(),
                path: "/tmp/demo".into(),
                port_range: (4000, 4099),
                declared_services: vec!["web".into()],
                agent_templates: HashMap::new(),
            },
            services: vec![ServiceInfo {
                project: "demo".into(),
                name: "web".into(),
                command: "npm run dev".into(),
                status: ServiceStatus::Stopped,
                original_port: 3000,
                allocated_port: 0,
                log_seq: 0,
            }],
            portforwards: Vec::new(),
        });

        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""event":"project.configChanged""#));
        let back: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ev);
    }

    #[test]
    fn terminal_spawn_defaults_cols_rows_when_omitted() {
        let old: Request = serde_json::from_str(
            r#"{"id":1,"method":"terminal.spawn","params":{"project":"p","command":"sh"}}"#,
        )
        .unwrap();
        assert!(
            matches!(old.method, Method::TerminalSpawn { cols, rows, .. } if cols == 80 && rows == 24)
        );
    }

    #[test]
    fn terminal_spawn_uses_provided_cols_rows() {
        let req: Request = serde_json::from_str(
            r#"{"id":1,"method":"terminal.spawn","params":{"project":"p","command":"sh","cols":120,"rows":40}}"#,
        )
        .unwrap();
        assert!(
            matches!(req.method, Method::TerminalSpawn { cols, rows, .. } if cols == 120 && rows == 40)
        );
    }

    #[test]
    fn project_remove_defaults_to_safe_resource_guard() {
        let old: Request =
            serde_json::from_str(r#"{"id":1,"method":"project.remove","params":{"name":"demo"}}"#)
                .unwrap();
        assert!(matches!(
            old.method,
            Method::ProjectRemove {
                name,
                stop_resources: false
            } if name == "demo"
        ));

        let authorized: Request = serde_json::from_str(
            r#"{"id":2,"method":"project.remove","params":{"name":"demo","stop_resources":true}}"#,
        )
        .unwrap();
        assert!(matches!(
            authorized.method,
            Method::ProjectRemove {
                stop_resources: true,
                ..
            }
        ));
    }
}
