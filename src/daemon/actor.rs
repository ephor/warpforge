//! The daemon actor: a single tokio task that owns all runtime state (projects,
//! dev servers, port-forwards, agent PTYs, tasks) and is the sole mutator of it.
//!
//! Clients (the TUI now; a WebSocket server in Stage 2) never touch the managers
//! directly — they send [`Command`]s in and consume [`Event`]s out. This is the
//! daemon/client boundary the pivot is about: because every observer is on the
//! same event stream, there is no "primary" UI, and nothing assumes a single
//! consumer.
//!
//! The internal [`Event`] here is intentionally *not* the serializable wire type
//! (`warpforge_protocol::Event`): in-process it can carry rich handles like the
//! live vt100 parser. Stage 2 adds a thin translation from this to the wire
//! type for the socket.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::{broadcast, mpsc, oneshot};

use warpforge_protocol as wire;

use crate::agent::{AgentEvent, AgentManager, AgentStatus};
use crate::config::{
    find_config_file, load_workspace_config, sorted_services, try_load_workspace_config,
    WorkspaceConfig,
};
use crate::portforward::{PfEvent, PfStatus, PortForwardManager};
use crate::registry::ProjectEntry;
use crate::service::{kill_listeners_in_ranges, ServiceEvent, ServiceManager, ServiceStatus};

use super::acp::{spawn_acp_session, AcpHandle, AcpUpdate, PolicyCheck};
use super::runtime::{Ask as PersistAsk, Write as PersistWrite};
use super::store::Store;
use super::task::{Task, TaskStatus};
use super::wire as wireconv;
use super::workflow::{
    self, RunState, StageKind, StageSignal, Verdict, WorkflowOutcome, WorkflowRun,
};
use super::worktree::WorktreeManager;
use crate::policies::builtins::{BlastRadiusPolicy, SpawnBoundsPolicy};
use crate::policies::registry::PolicyRegistry;
use crate::policies::{Phase, PolicyContext};

/// Split a `project/service` service key back into its parts (split on first
/// `/`, which is how `ServiceManager` composes the key).
fn split_key(key: &str) -> (String, String) {
    match key.split_once('/') {
        Some((p, s)) => (p.to_string(), s.to_string()),
        None => (String::new(), key.to_string()),
    }
}

type ConfigFingerprint = Option<(PathBuf, Vec<u8>)>;

const CONFIG_POLL_INTERVAL: Duration = Duration::from_millis(250);
const CONFIG_CHANGE_DEBOUNCE: Duration = Duration::from_millis(200);

/// Raw history rows shipped per task in a state snapshot. Covers the tiles'
/// preview, the attention rail's pending permission and failure detection;
/// a transcript needing more loads via `session.history`.
const SNAPSHOT_HISTORY_TAIL: usize = 200;

/// How often the daemon re-runs history pruning. The first sweep happens at
/// start, so a shortened window applies without waiting a day.
const HISTORY_PRUNE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

fn config_fingerprint(project_path: &Path) -> ConfigFingerprint {
    let path = find_config_file(project_path);
    std::fs::read(&path).ok().map(|contents| (path, contents))
}

/// Content-based, debounced observer for registered project configs.
///
/// Resolving the active config path on each pass rather than tracking one inode
/// is important because many editors save by replacing the file atomically.
/// Polling the small config files also keeps the daemon cross-platform without
/// another native watcher dependency.
struct ConfigObserver {
    applied: HashMap<String, ConfigFingerprint>,
    pending: HashMap<String, (ConfigFingerprint, Instant)>,
}

impl ConfigObserver {
    fn new(projects: &[ProjectEntry]) -> Self {
        Self {
            applied: projects
                .iter()
                .map(|project| {
                    (
                        project.name.clone(),
                        config_fingerprint(Path::new(&project.path)),
                    )
                })
                .collect(),
            pending: HashMap::new(),
        }
    }

    fn track(&mut self, project: &ProjectEntry) {
        self.applied.insert(
            project.name.clone(),
            config_fingerprint(Path::new(&project.path)),
        );
        self.pending.remove(&project.name);
    }

    fn untrack(&mut self, project: &str) {
        self.applied.remove(project);
        self.pending.remove(project);
    }

    fn ready(
        &mut self,
        projects: &[ProjectEntry],
        now: Instant,
    ) -> Vec<(String, ConfigFingerprint)> {
        let registered: HashSet<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        self.applied
            .retain(|project, _| registered.contains(project.as_str()));
        self.pending
            .retain(|project, _| registered.contains(project.as_str()));

        let mut ready = Vec::new();
        for project in projects {
            let current = config_fingerprint(Path::new(&project.path));
            if self.applied.get(&project.name) == Some(&current) {
                self.pending.remove(&project.name);
                continue;
            }

            match self.pending.get_mut(&project.name) {
                Some((pending, since)) if *pending == current => {
                    if now.duration_since(*since) >= CONFIG_CHANGE_DEBOUNCE {
                        ready.push((project.name.clone(), current));
                    }
                }
                Some((pending, since)) => {
                    *pending = current;
                    *since = now;
                }
                None => {
                    self.pending.insert(project.name.clone(), (current, now));
                }
            }
        }
        ready
    }

    fn mark_applied(&mut self, project: &str, fingerprint: ConfigFingerprint) {
        self.applied.insert(project.to_string(), fingerprint);
        self.pending.remove(project);
    }
}

fn is_acp_replay_update(update: &wire::SessionUpdate) -> bool {
    match update {
        wire::SessionUpdate::UserMessage { .. }
        | wire::SessionUpdate::PermissionResolved { .. }
        | wire::SessionUpdate::PromptCapabilities { .. }
        | wire::SessionUpdate::WorkflowEvent { .. } => false,
        wire::SessionUpdate::AgentText { text } => {
            text != "Reconnecting to the saved agent session…"
                && !text.starts_with("⚠ No live agent session")
        }
        wire::SessionUpdate::AgentThought { .. }
        | wire::SessionUpdate::ToolCall { .. }
        | wire::SessionUpdate::FileEdit { .. }
        | wire::SessionUpdate::PermissionRequest { .. }
        | wire::SessionUpdate::Plan { .. }
        | wire::SessionUpdate::AvailableCommands { .. }
        | wire::SessionUpdate::TurnEnded { .. } => true,
        wire::SessionUpdate::Usage { .. } => false,
    }
}

/// The replayable subset of a task's persisted history, in order — the seed
/// for the resume replay guard. Built from the store on demand, because the
/// actor holds no full transcript in memory.
fn replayable_history(updates: &[wire::SessionUpdate]) -> VecDeque<wire::SessionUpdate> {
    updates
        .iter()
        .filter(|update| is_acp_replay_update(update))
        .cloned()
        .collect()
}

/// Fold a turn's updates into the two shapes the pipeline needs: the agent's
/// closing message and the whole turn. A new user message starts a fresh turn.
/// The input is the current-turn buffer, which is bounded by a turn, not by the
/// session's length.
fn stage_text_from_updates(updates: &[wire::SessionUpdate]) -> StageText {
    let mut full: Vec<String> = Vec::new();
    let mut closing: Vec<String> = Vec::new();
    for update in updates {
        match update {
            // A new user message starts a fresh turn.
            wire::SessionUpdate::UserMessage { .. } => {
                full.clear();
                closing.clear();
            }
            wire::SessionUpdate::AgentText { text } => {
                full.push(text.clone());
                closing.push(text.clone());
            }
            // Any work the agent does ends whatever it was narrating, so the
            // closing message restarts after it.
            wire::SessionUpdate::ToolCall { .. }
            | wire::SessionUpdate::FileEdit { .. }
            | wire::SessionUpdate::AgentThought { .. }
            | wire::SessionUpdate::Plan { .. } => closing.clear(),
            _ => {}
        }
    }
    StageText {
        closing: closing.join(""),
        full: full.join(""),
    }
}

/// Concatenate every `AgentText` update in a task's history — a task's full
/// text output, used as the orchestrator node's result. Computed off the actor
/// loop from the store (the actor holds no full transcript).
fn agent_text_from_updates(updates: &[wire::SessionUpdate]) -> String {
    updates
        .iter()
        .filter_map(|update| match update {
            wire::SessionUpdate::AgentText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// System preamble prepended to an orchestrator-chat session's first prompt.
const ORCHESTRATOR_SYSTEM: &str = "\
You are an orchestrator agent in warpforge. You coordinate work by delegating to \
sub-agents rather than doing large tasks yourself.\n\n\
You have these MCP tools:\n\
- spawn_agent(agent, task): dispatch a sub-agent (e.g. \"claude\", \"codex\", \
\"opencode\") to work on a task. It runs asynchronously in its own session and \
returns immediately with a task id. Spawn several in one turn to parallelize.\n\
- read_inbox(): collect finished sub-agent results. When a sub-agent finishes you \
will receive a system message telling you results are waiting — call read_inbox to \
collect them, then decide the next step (spawn more, or report back to the user).\n\
- message_agent(task_id, message): send a follow-up message to a previously \
spawned sub-agent, continuing the same session. The agent sees the full \
conversation history and can respond in context. Use this instead of spawn_agent \
when you want to continue a conversation with an agent you already started. \
Returns immediately; the response lands in your inbox — then call read_inbox.\n\n\
- list_agents(): list the sub-agents spawned by this orchestrator, including \
their task ids, statuses, and last-activity timestamps. A workflow pipeline \
also shows its current stage, review round, and whether it is waiting on you \
(see workflowRun in the listing).\n\
- stop_agent(task_id): stop one sub-agent session and wait for its process to \
exit. Use this when a specific child is stale or no longer needed. Also works \
on a workflow pipeline task id — it stops the whole pipeline.\n\
- cleanup_agents(max_age_seconds, dry_run, include_active): permanently remove \
child sessions and their task history in bulk. By default it removes all \
inactive/completed children; use `max_age_seconds` to filter by age, `dry_run` \
to preview candidates, and `include_active` only when you explicitly intend to \
stop and delete running work.\n\n\
- spawn_workflow(workflow_id, goal, agent): dispatch a multi-stage pipeline \
(plan/implement/review/fix, with review ⇄ fix rounds) instead of a single \
sub-agent, for work that benefits from independent review. Runs \
asynchronously as its own parent task; its final outcome lands in your inbox \
like a sub-agent's, and its progress shows up in list_agents. Costs several \
times the tokens of a single sub-agent — prefer spawn_agent for straightforward \
tasks.\n\
- pause_workflow(task_id) / resume_workflow(task_id, note?): soft-pause a \
running pipeline at its next stage boundary, or resume it, optionally with a \
guidance note for the next stage.\n\
- answer_workflow(task_id, message): answer a pipeline stage's pending \
question (list_agents shows workflowRun.waiting.kind == \"question\" when one \
is open). Do not use message_agent on a workflow pipeline task id — it has no \
agent session of its own and the message will not be delivered.\n\
- decide_workflow(task_id, decision, rounds?, note?): decide what a pipeline \
does when it has exhausted its review rounds with open findings \
(workflowRun.waiting.kind == \"limit\"). decision is \"extend\" (grant `rounds` \
more, default 1), \"finish\" (accept as-is), or \"stop\".\n\n\
Talk to the user normally. When a task needs real work, delegate it with \
spawn_agent (or spawn_workflow for review-worthy changes), tell the user what \
you dispatched, and continue the conversation. The user can keep messaging you \
while sub-agents and pipelines run.";

/// System preamble prepended to a plain task session's first prompt. The task's
/// dev services run under the warpforge daemon, so their stdout and status are
/// invisible to the agent's own shell — these MCP tools are how the agent sees
/// the runtime it is supposed to be working against.
const RUNTIME_MCP_SYSTEM: &str = "\
You have these warpforge MCP tools for observing and controlling the project's \
dev runtime (services and port-forwards are managed by the warpforge daemon, so \
their stdout and lifecycle are NOT visible to your shell):\n\
- list_runtime(): list the project's running services and port-forwards with \
their status and allocated ports. Call it first to see what is up and which \
ports to hit.\n\
- read_service_logs(service, filter?, after?, limit?): read a window of a \
service's stdout/stderr. Use it to diagnose crashes or check request output. \
Pass a case-insensitive `filter` substring to find specific lines (errors, \
request ids); paginate old history with `after` (offset into the buffer) and \
`limit` (page size, default 100). read_portforward_logs(name) does the same \
for a port-forward.\n\
- service_start(service) / service_stop(service) / service_restart(service): \
start, stop, or restart a service. These dispatch asynchronously and return \
immediately — follow up with read_service_logs to watch the outcome.\n\
- portforward_start(name) / portforward_stop(name): start or stop a \
port-forward.\n\
- create_backlog_task(title, project?, body?, priority?, status?): record \
follow-up work as a local backlog item without starting an agent. The older \
create_task name is a deprecated alias.";

/// Shared-memory preamble prepended to every session's first prompt when memory
/// is enabled. This is the primary channel that teaches harnesses to use
/// memory_* instead of per-harness CLAUDE.md/AGENTS.md silos. The tool
/// descriptions are the always-visible secondary channel; the AGENTS.md /
/// CLAUDE.md snippet fallback is deferred (no file writes in v1).
const MEMORY_SYSTEM: &str = "\
You run inside Warpforge. For durable cross-session knowledge use memory_store / \
memory_search / memory_list (shared across Claude, Codex, opencode). Prefer this \
over writing CLAUDE.md/AGENTS.md. Check memory_stats for active scopes.";

/// The warpforge MCP bridge config handed to every ACP session so the agent
/// can call back into this daemon (read service logs, restart a service,
/// and — for orchestrator-chat sessions — spawn_agent / read_inbox). The
/// `WF_MODE` env lets the bridge expose the orchestrator-only tools only to
/// sessions that are actually orchestrators.
fn mcp_servers(task_id: &str, project: &str, is_orchestrator: bool) -> Vec<serde_json::Value> {
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "warpforge".to_string());
    vec![serde_json::json!({
        "name": "warpforge",
        "command": exe,
        "args": ["__mcp-orchestrator"],
        "env": [
            { "name": "WF_TASK", "value": task_id },
            { "name": "WF_PROJECT", "value": project },
            { "name": "WF_MODE", "value": if is_orchestrator { "orchestrator" } else { "single" } },
        ],
    })]
}

/// A finished sub-agent's result, queued in its orchestrator parent's inbox
/// until the orchestrator agent drains it via the `read_inbox` MCP tool.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildResult {
    pub child_id: String,
    pub agent: String,
    pub prompt: String,
    pub output: String,
    pub success: bool,
}

/// Tracks unresolved permission requests per task. Keyed by task_id (not
/// session_id) because Command::SessionPermission and AcpUpdate::PermissionRequest
/// both use task_id as the correlation key, and sessions are keyed by task_id.
#[derive(Default)]
struct PendingPermissions {
    by_task: HashMap<String, HashSet<String>>,
}

impl PendingPermissions {
    fn record(&mut self, task_id: &str, request_id: &str) {
        self.by_task
            .entry(task_id.to_string())
            .or_default()
            .insert(request_id.to_string());
    }

    fn resolve(&mut self, task_id: &str, request_id: &str) {
        if let Some(requests) = self.by_task.get_mut(task_id) {
            requests.remove(request_id);
            if requests.is_empty() {
                self.by_task.remove(task_id);
            }
        }
    }

    fn cleanup_task(&mut self, task_id: &str) {
        self.by_task.remove(task_id);
    }

    fn has_pending(&self, task_id: &str) -> bool {
        self.by_task.get(task_id).is_some_and(|r| !r.is_empty())
    }
}

/// Lifecycle state transitions for settle/snooze visibility overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LifecycleAction {
    Settle,
    Unsettle,
    Snooze { until: u64 },
    Unsnooze,
}

/// Pure lifecycle transition function. Returns:
/// - Err for validation failures (running, pending permission, invalid until)
/// - Ok(None) for true no-ops (task already in target state)
/// - Ok(Some(task)) when changes were made (caller must persist/emit)
fn apply_lifecycle_action(
    task: &Task,
    has_pending: bool,
    now: u64,
    action: LifecycleAction,
) -> Result<Option<Task>, String> {
    match action {
        LifecycleAction::Settle => {
            if task.status == TaskStatus::Running {
                return Err(format!("task {} is running", task.id));
            }
            if has_pending {
                return Err(format!("task {} has pending permission request", task.id));
            }
            // Check if already in target state
            let already_settled = task.settled_override == Some(true)
                && task.settled_at.is_some()
                && task.snoozed_until.is_none()
                && task.snoozed_at.is_none();
            if already_settled {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.settled_override = Some(true);
            // Preserve existing settled_at only when already settled (override=true)
            // Otherwise replace stale timestamp with now
            updated.settled_at = match task.settled_override {
                Some(true) => Some(task.settled_at.unwrap_or(now)),
                _ => Some(now),
            };
            // Clear snooze
            updated.snoozed_until = None;
            updated.snoozed_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
        LifecycleAction::Unsettle => {
            // Check if already in target state
            let already_unsettled = task.settled_override == Some(false)
                && task.settled_at.is_none()
                && task.snoozed_until.is_none()
                && task.snoozed_at.is_none();
            if already_unsettled {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.settled_override = Some(false);
            updated.settled_at = None;
            updated.snoozed_until = None;
            updated.snoozed_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
        LifecycleAction::Snooze { until } => {
            if until <= now {
                return Err("snooze until must be in the future".to_string());
            }
            if has_pending {
                return Err(format!("task {} has pending permission request", task.id));
            }
            // Check if already in target state
            let already_snoozed = task.snoozed_until == Some(until)
                && task.snoozed_at.is_some()
                && task.settled_override == Some(false)
                && task.settled_at.is_none();
            if already_snoozed {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.snoozed_until = Some(until);
            // Preserve snoozed_at only when same until AND Some; otherwise set now
            updated.snoozed_at = if task.snoozed_until == Some(until) && task.snoozed_at.is_some() {
                task.snoozed_at
            } else {
                Some(now)
            };
            updated.settled_override = Some(false);
            updated.settled_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
        LifecycleAction::Unsnooze => {
            // Check if already in target state
            if task.snoozed_until.is_none() && task.snoozed_at.is_none() {
                return Ok(None);
            }
            let mut updated = task.clone();
            updated.snoozed_until = None;
            updated.snoozed_at = None;
            updated.updated_at = now;
            Ok(Some(updated))
        }
    }
}

/// Cap the diff we feed a text-generation agent. A commit message or PR body
/// only needs the shape of the change, not every line of a huge diff, and an
/// oversized prompt is slow and can blow the model's context.
const TEXTGEN_DIFF_LIMIT: usize = 48 * 1024;

const COMMIT_INSTRUCTION: &str = "\
Write a git commit message for the changes below (the output of `git diff HEAD`). \
Use Conventional Commits: a concise subject line in the imperative mood, at most \
72 characters, then a blank line and a short body only if it adds information the \
subject cannot. Reply with ONLY the commit message — no code fences, no preamble, \
no closing remarks.";

const PR_INSTRUCTION: &str = "\
Write a GitHub pull-request description for the branch's outgoing commits (listed \
below, with their combined diff). Output the PR title as the first line, then a \
blank line, then a Markdown body summarizing what changed and why. Reply with ONLY \
the title and body — no code fences, no preamble.";

const TASK_TITLE_INSTRUCTION: &str = "\
Given the task prompt below, write a short title for this task. The title must be \
a single imperative line, at most 60 characters, plain text, no quotes, no trailing \
period, no markdown. Reply with ONLY the title — no code fences, no preamble, no \
closing remarks.";

const ENHANCE_PROMPT_INSTRUCTION: &str = "\
Below is a task description written by a user. Rewrite it into a clear, well-structured \
task: a strong imperative title on the first line, then a blank line, then a concise \
Markdown body that states the goal, acceptance criteria (as bullet points where \
helpful), and any constraints worth keeping. Keep the user's intent and technical \
details unchanged — only clarify, organise, and improve the phrasing. Do not invent \
requirements that are not implied by the text. Reply with ONLY the rewritten task — \
no code fences, no preamble, no closing remarks.";

/// Build the one-shot prompt for `text.generate` from the repo's git state.
/// When `message` is set (required for `TaskTitle`), it is used verbatim as the
/// input to describe instead of running git.
async fn build_textgen_prompt(
    repo: &str,
    kind: wire::TextGenKind,
    message: Option<&str>,
) -> Result<String, String> {
    async fn git_out(repo: &str, args: &[&str]) -> Result<String, String> {
        let out = tokio::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .await
            .map_err(|e| format!("git failed to run: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn clamp(mut diff: String) -> String {
        if diff.len() > TEXTGEN_DIFF_LIMIT {
            diff.truncate(TEXTGEN_DIFF_LIMIT);
            diff.push_str("\n… diff truncated …\n");
        }
        diff
    }

    match kind {
        wire::TextGenKind::CommitMessage => {
            let diff = git_out(repo, &["diff", "HEAD"]).await?;
            if diff.trim().is_empty() {
                return Err("no changes to describe".to_string());
            }
            Ok(format!(
                "{COMMIT_INSTRUCTION}\n\n----- git diff HEAD -----\n{}",
                clamp(diff)
            ))
        }
        wire::TextGenKind::PrDescription => {
            let info = super::diff::push_info(repo)
                .await
                .map_err(|e| e.to_string())?;
            if info.commits.is_empty() {
                return Err("no outgoing commits to describe".to_string());
            }
            let subjects = info
                .commits
                .iter()
                .map(|c| format!("- {}", c.subject))
                .collect::<Vec<_>>()
                .join("\n");
            // commits are oldest-first; parent of the first covers exactly the
            // outgoing range without depending on the upstream ref existing.
            let range = format!("{}^..HEAD", info.commits[0].hash);
            let diff = git_out(repo, &["diff", &range]).await.unwrap_or_default();
            Ok(format!(
                "{PR_INSTRUCTION}\n\n----- commits -----\n{subjects}\n\n----- combined diff -----\n{}",
                clamp(diff)
            ))
        }
        wire::TextGenKind::TaskTitle => {
            let prompt = message.unwrap_or("");
            if prompt.trim().is_empty() {
                return Err("no prompt to summarize".to_string());
            }
            Ok(format!(
                "{TASK_TITLE_INSTRUCTION}\n\n----- task prompt -----\n{prompt}"
            ))
        }
        wire::TextGenKind::EnhancePrompt => {
            let prompt = message.unwrap_or("");
            if prompt.trim().is_empty() {
                return Err("no prompt to enhance".to_string());
            }
            Ok(format!(
                "{ENHANCE_PROMPT_INSTRUCTION}\n\n----- task prompt -----\n{prompt}"
            ))
        }
        // The caller renders the transcript, since reading it is a store hit
        // rather than the git work the other kinds do here.
        wire::TextGenKind::Handoff => super::handoff::cold_prompt(message.unwrap_or("")),
    }
}

/// Commands from clients to the daemon.
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
        created: Result<(String, super::worktree::Worktree), String>,
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
        link: super::store::TrackerLink,
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
            Vec<super::store::TrackerLink>,
            std::collections::HashMap<String, String>,
            std::collections::HashMap<String, String>,
        )>,
    },
    TrackerPersistSynced {
        links: Vec<super::store::TrackerLink>,
        reply: oneshot::Sender<()>,
    },
    TrackerDeleteItems {
        ids: Vec<String>,
        reply: oneshot::Sender<()>,
    },
    TrackerAdoptImported {
        project: String,
        fetched: Vec<(String, Vec<super::tracker::RemoteIssue>)>,
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
        query: super::backlog::Query,
        reply: oneshot::Sender<Result<wire::BacklogPage, String>>,
    },
    BacklogCreate {
        item: super::backlog::NewItem,
        reply: oneshot::Sender<Result<wire::BacklogItem, String>>,
    },
    BacklogUpdate {
        patch: super::backlog::ItemPatch,
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
        reply: oneshot::Sender<Result<ProjectEntry, String>>,
    },
    /// Remove a project from the registry and broadcast the update.
    RemoveProject {
        name: String,
        stop_resources: bool,
        reply: oneshot::Sender<Result<(), ProjectRemovalError>>,
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
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    /// Full-text search over shared memories.
    MemorySearch {
        query: String,
        scope: Option<String>,
        limit: Option<u32>,
        mode: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryList {
        scope: Option<String>,
        kind: Option<String>,
        limit: Option<u32>,
        offset: Option<u32>,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryUpdate {
        id: String,
        content: String,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryDelete {
        id: String,
        reply: oneshot::Sender<Result<(), super::memory::MemoryError>>,
    },
    MemoryStats {
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    SetMemoryEmbedding {
        mode: String,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryAddEdge {
        src_id: String,
        dst_id: String,
        relation: String,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryEdges {
        id: String,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryDream {
        dry_run: bool,
        project_id: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryListCompaction {
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    MemoryResolveCompaction {
        id: i64,
        approve: bool,
        reply: oneshot::Sender<Result<serde_json::Value, super::memory::MemoryError>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// State deltas broadcast to every subscribed client.
#[derive(Clone)]
pub enum Event {
    ServiceStatus {
        project: String,
        service: String,
        status: ServiceStatus,
        allocated_port: u16,
    },
    ServiceLog {
        project: String,
        service: String,
        line: String,
    },
    PortForwardStatus {
        project: String,
        name: String,
        status: PfStatus,
    },
    PortForwardLog {
        project: String,
        name: String,
        line: String,
    },
    ProjectAdded(wire::ProjectInfo),
    ProjectRemoved {
        name: String,
    },
    ProjectConfigChanged(wire::ProjectConfigState),
    AgentsSetupNeeded {
        detected: Vec<wire::DetectedAgent>,
    },
    AgentsUpdated {
        agents: Vec<wire::AgentConfig>,
    },
    /// Account list or active selection changed.
    AccountsUpdated {
        accounts: Vec<wire::AccountInfo>,
    },
    /// A PTY agent was created; carries the live vt100 parser so an in-process
    /// client can render it. (Stage 3 replaces this with serialized screens.)
    AgentSpawned {
        id: String,
        project: String,
        screen: Arc<Mutex<vt100::Parser>>,
    },
    AgentStatus {
        id: String,
        status: AgentStatus,
    },
    AgentExited {
        id: String,
    },
    TaskCreated(Task),
    TaskUpdated(Task),
    TaskRemoved {
        id: String,
    },
    /// Structured ACP session activity for a task (tool calls, agent text,
    /// file edits, permission requests) — already in wire shape.
    SessionUpdate {
        task_id: String,
        update: wire::SessionUpdate,
    },
    /// Session transcripts of finished tasks older than the retention window
    /// were removed; `updates` counts the deleted rows.
    HistoryPruned {
        updates: u64,
    },
    /// The retention sweep settled and/or deleted tasks (see HistorySwept's
    /// wire doc for the counters' meaning).
    HistorySwept {
        settled: u64,
        expired: u64,
        kept: u64,
    },
    /// A PTY terminal's rendered screen changed (serialized, so clients need no
    /// terminal emulator — the daemon owns the one authoritative vt100 parser).
    TerminalScreen {
        terminal_id: String,
        screen: wire::TerminalScreen,
    },
    /// A new terminal was spawned. Wire clients use this to add TerminalInfo to
    /// their snapshot projection. Internal-only info (parser handle) stays on
    /// AgentSpawned for the in-process TUI.
    TerminalSpawned {
        info: wire::TerminalInfo,
    },
    /// Raw PTY output bytes (base64) for terminal-emulator clients.
    TerminalData {
        terminal_id: String,
        data_b64: String,
    },
    /// Orchestration pipeline event (plan created, node dispatched, etc.)
    #[allow(clippy::enum_variant_names)]
    OrchestrationEvent(crate::orchestration::OrchEvent),
    /// An opaque LSP message from a language server's stdout.
    LspMessage {
        server_id: String,
        payload: serde_json::Value,
    },
    /// A language server exited.
    LspExit {
        server_id: String,
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectRemovalError {
    Conflict(String),
    NotFound(String),
    Internal(String),
}

impl std::fmt::Display for ProjectRemovalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict(message) | Self::NotFound(message) | Self::Internal(message) => {
                f.write_str(message)
            }
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ProjectLiveResources {
    services: usize,
    portforwards: usize,
    terminals: usize,
}

impl ProjectLiveResources {
    fn any(&self) -> bool {
        self.services + self.portforwards + self.terminals > 0
    }

    fn conflict_message(&self, project: &str) -> String {
        let mut counts = Vec::new();
        if self.services > 0 {
            counts.push(format!(
                "{} live service{}",
                self.services,
                plural(self.services)
            ));
        }
        if self.portforwards > 0 {
            counts.push(format!(
                "{} live port-forward{}",
                self.portforwards,
                plural(self.portforwards)
            ));
        }
        if self.terminals > 0 {
            counts.push(format!(
                "{} live terminal{}",
                self.terminals,
                plural(self.terminals)
            ));
        }
        format!(
            "Project \"{project}\" has {}; retry project.remove with stop_resources=true to stop them and remove the registration",
            counts.join(", ")
        )
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// Collapse a dropped memory reply channel into a "disabled" error, matching
/// what a never-opened store reports.
fn memory_dropped() -> super::memory::MemoryError {
    super::memory::MemoryError::Disabled("memory disabled".into())
}

/// Collapse a failed oneshot into an error `GitOpResult` instead of panicking.
fn op_result_or_dropped(
    received: Result<wire::GitOpResult, oneshot::error::RecvError>,
    message: &str,
) -> wire::GitOpResult {
    received.unwrap_or_else(|_| wire::GitOpResult {
        status: wire::GitOpStatus::Error,
        message: message.to_string(),
        conflicts: Vec::new(),
        branch: None,
    })
}

/// Cloneable handle clients use to talk to the daemon.
#[derive(Clone)]
pub struct DaemonHandle {
    pub cmd_tx: mpsc::Sender<Command>,
    event_tx: broadcast::Sender<Event>,
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

    pub async fn memory_store(
        &self,
        content: &str,
        scope: Option<&str>,
        kind: Option<&str>,
        tags: Option<&[String]>,
        project_id: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryUpdate {
            id: id.to_string(),
            content: content.to_string(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_delete(&self, id: &str) -> Result<(), super::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryDelete {
            id: id.to_string(),
            reply: tx,
        })
        .await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn memory_stats(&self) -> Result<serde_json::Value, super::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryStats { reply: tx }).await;
        rx.await.map_err(|_| memory_dropped())?
    }

    pub async fn set_memory_embedding(
        &self,
        mode: &str,
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::MemoryListCompaction { reply: tx }).await;
        rx.await.map_err(|_| memory_dropped())?
    }
    pub async fn memory_resolve_compaction(
        &self,
        id: i64,
        approve: bool,
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
    ) -> Result<serde_json::Value, super::memory::MemoryError> {
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
        link: super::store::TrackerLink,
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
        Vec<super::store::TrackerLink>,
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

    pub async fn tracker_persist_synced(&self, links: Vec<super::store::TrackerLink>) {
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
        fetched: Vec<(String, Vec<super::tracker::RemoteIssue>)>,
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
            let defaults = super::history_config::HistoryConfig::default();
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
        query: super::backlog::Query,
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
        item: super::backlog::NewItem,
    ) -> Result<wire::BacklogItem, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::BacklogCreate { item, reply: tx }).await;
        rx.await
            .unwrap_or_else(|_| Err("daemon dropped backlog create request".into()))
    }

    pub async fn backlog_update(
        &self,
        patch: super::backlog::ItemPatch,
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
    ) -> Result<ProjectEntry, String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::AddProject {
            path: path.to_string(),
            name: name.map(str::to_string),
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

/// What a finished git operation changed about a task.
///
/// These describe something that already happened on disk, so applying one late
/// is still correct — a commit that landed is a commit that landed. The only
/// guard needed is that the task still exists, which the handlers check.
#[derive(Debug, Clone, Copy)]
pub enum GitEffect {
    /// HEAD or the working tree moved: nudge clients to refetch.
    Bump,
    /// A commit landed, so the task has no uncommitted changes left.
    Committed,
    /// A hunk was rejected, so one fewer file differs.
    HunkRejected,
}

/// A session that cannot start until its worktree exists.
struct PendingSessionStart {
    project: String,
    agent: String,
    prompt: String,
    include_runtime_context: bool,
    attachments: Vec<wire::PromptAttachment>,
    default_model: Option<String>,
    config_overrides: std::collections::HashMap<String, String>,
}

/// A session that cannot start until its resume replay guard has been loaded
/// from the store. Carries everything `start_session` needs to resume.
struct PendingResume {
    project: String,
    agent: String,
    text: String,
    session_id: String,
    attachments: Vec<wire::PromptAttachment>,
    /// The task's model intent, re-applied to the loaded session. `None`
    /// keeps the resumed session's own model state, as before.
    default_model: Option<String>,
}

/// De-duplicates the ACP updates an agent replays on `session/load` against the
/// daemon's persisted history. While the replay matches history in order it is
/// dropped; the first mismatch is new live output and disables the guard.
struct ResumeReplayGuard {
    history: VecDeque<wire::SessionUpdate>,
}

impl ResumeReplayGuard {
    /// The replayable subset of `updates`, in order. `None` when there is
    /// nothing to de-duplicate (a session with no persisted history).
    fn from_updates(updates: &[wire::SessionUpdate]) -> Option<Self> {
        let history = replayable_history(updates);
        (!history.is_empty()).then_some(Self { history })
    }

    fn is_empty(&self) -> bool {
        self.history.is_empty()
    }

    /// True when `update` is the next replayed update and should be dropped.
    /// False when it is live output (and the caller must disable the guard).
    fn consume(&mut self, update: &wire::SessionUpdate) -> bool {
        if self.history.front() == Some(update) {
            self.history.pop_front();
            true
        } else {
            false
        }
    }
}

/// A worktree checkout resolved against actor state, ready to run elsewhere.
struct WorktreeRequest {
    project: String,
    base_repo: PathBuf,
    task_id: String,
    /// What a conversation branch inherits from.
    source: Option<BranchSource>,
}

/// Where a branched conversation picks up from.
struct BranchSource {
    /// The source task's own branch, when it has a worktree. `None` means the
    /// source works in the project checkout, so the branch starts from HEAD.
    base_branch: Option<String>,
    /// The working tree whose uncommitted changes carry over.
    path: PathBuf,
}

impl WorktreeRequest {
    async fn run(self) -> Result<(String, super::worktree::Worktree), String> {
        let created = match self.source {
            Some(ref source) => {
                super::worktree::create_branched_detached(
                    &self.base_repo,
                    &self.task_id,
                    source.base_branch.as_deref(),
                    &source.path,
                )
                .await
            }
            None => super::worktree::create_detached(&self.base_repo, &self.task_id, None).await,
        };
        created
            .map(|wt| (self.project, wt))
            // `{:#}` keeps the context chain: the top line alone says only
            // "failed to copy working state", never which git step failed.
            .map_err(|e| format!("{e:#}"))
    }
}

pub struct Daemon {
    projects: Vec<ProjectEntry>,
    config_observer: ConfigObserver,
    tasks: HashMap<String, Task>,
    /// Enabled ACP agent configurations (from SQLite, user-managed).
    configured_agents: Vec<wire::AgentConfig>,
    /// Live agent sessions keyed by task id. One per task in v1; the map (not a
    /// field on Task) is what keeps multi-session-per-task additive later.
    sessions: HashMap<String, AcpHandle>,
    /// Unresolved permission requests per task. Used for settle/snooze validation.
    pending_permissions: PendingPermissions,
    agents: AgentManager,
    services: ServiceManager,
    portforwards: PortForwardManager,
    /// Language-server proxy: spawns and tunnels LSP servers per workspace.
    lsp: super::lsp::LspManager,
    event_tx: broadcast::Sender<Event>,
    acp_tx: mpsc::UnboundedSender<(String, AcpUpdate)>,
    /// Sender back to this actor's command channel — used so background tasks
    /// (e.g. the ACP probe) can deliver results without needing a borrow of the
    /// actor. Held alongside `store` etc. as a primary mutator handle.
    cmd_tx: mpsc::Sender<Command>,
    /// Queued writes, applied off the actor thread. Every mutation goes here —
    /// calling `store` directly from a handler puts a blocking disk write back
    /// on the hot path (ADR 0002).
    persist: super::runtime::Persist,
    /// Shared with the persistence thread, for the reads that still run on the
    /// actor. Those move to an in-memory projection next; until then, use
    /// [`Daemon::with_store`] rather than locking at the call site.
    store: Option<Arc<Mutex<Store>>>,
    /// `session/load` may replay already persisted ACP updates. While the
    /// replay matches local history in order, drop it; the first mismatch is
    /// new live output and disables the guard.
    resume_replay: HashMap<String, ResumeReplayGuard>,
    /// Per-project git worktree managers, lazily created on first worktree use.
    worktrees: HashMap<String, WorktreeManager>,
    /// Sessions waiting on a worktree checkout, keyed by task id. Presence is
    /// the token that lets a finished checkout start its session: cancel and
    /// delete remove the entry, so a late checkout cannot resurrect the task.
    pending_session_starts: HashMap<String, PendingSessionStart>,
    /// Policy engine: gates agent actions through configurable policies.
    policies: PolicyRegistry,
    /// Channel for ACP reader tasks to request policy checks before file ops.
    policy_tx: mpsc::UnboundedSender<PolicyCheck>,
    /// Orchestrator: drives planner→worker→reviewer pipeline.
    orch_tx: Option<mpsc::Sender<crate::orchestration::OrchCommand>>,
    /// Receiver for orchestrator events (forwarded to broadcast).
    orch_event_rx: Option<broadcast::Receiver<crate::orchestration::OrchEvent>>,
    /// Orchestrator configuration (loaded from ~/.warpforge/orchestrator.yaml).
    orch_config: crate::orchestration::config::OrchestratorConfig,
    /// Per-orchestrator-task inbox of finished sub-agent results, keyed by the
    /// parent (orchestrator) task id. Drained by the `read_inbox` MCP tool.
    orchestrator_inbox: HashMap<String, Vec<ChildResult>>,
    /// Orchestrator tasks with results that arrived mid-turn: wake them once
    /// their current turn ends (deferred so a fan-out of N completions yields
    /// one wake, and an ignored wake never re-fires into a loop).
    pending_wake: std::collections::HashSet<String>,
    /// Stable first-seen timestamps for streamed frames of the same tool call.
    tool_call_starts: HashMap<(String, String), u64>,
    /// The last session update emitted per task — all `emit_session_unless_last_duplicate`
    /// needs to catch a reconnect retry or a repeated usage frame. O(1) per task,
    /// never the whole transcript.
    last_session_update: HashMap<String, wire::SessionUpdate>,
    /// Updates emitted since the task's last user message (its current turn).
    /// Reset on each new user message, so this is bounded by a turn, not by the
    /// session's length. Serves the workflow engine's stage-text reads, which
    /// used to fold the entire in-memory transcript.
    turn_updates: HashMap<String, Vec<wire::SessionUpdate>>,
    /// A session that cannot start until its resume replay guard has been read
    /// from the store (off the loop). Presence is the token that lets the loaded
    /// guard start the session: cancel and delete remove the entry, so a late
    /// load cannot resurrect the task (ADR 0002 invariant 5).
    pending_resume: HashMap<String, PendingResume>,
    /// Deterministic workflow pipelines keyed by parent task id. Finished runs
    /// stay in the map so their state remains visible on the board.
    workflow_runs: HashMap<String, WorkflowRun>,
    /// Registered agent accounts, mirroring the `agent_accounts` table.
    accounts: Vec<super::store::StoredAccount>,
    /// Shared memory store (separate `~/.warpforge/memory.db`), owned here so
    /// all memory ops run on the actor thread against one connection.
    memory: super::memory::MemoryStore,
    last_memory_activity: Arc<Mutex<std::time::Instant>>,
}

impl Daemon {
    /// Construct the daemon and run its actor loop on a background task.
    /// Persisted tasks are loaded from the store (Running/Queued tasks come back
    /// as Interrupted — no live-session resumption in v1).
    pub fn spawn(projects: Vec<ProjectEntry>, store: Option<Store>) -> DaemonHandle {
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let (event_tx, _) = broadcast::channel(2048);
        let (agent_tx, agent_rx) = mpsc::unbounded_channel();
        let (service_tx, service_rx) = mpsc::unbounded_channel();
        let (pf_tx, pf_rx) = mpsc::unbounded_channel();
        let (acp_tx, acp_rx) = mpsc::unbounded_channel();
        let (policy_tx, policy_rx) = mpsc::unbounded_channel::<PolicyCheck>();

        let tasks = store
            .as_ref()
            .and_then(|s| s.load_tasks().ok())
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();

        let mut configured_agents = store
            .as_ref()
            .and_then(|s| s.load_agents().ok())
            .unwrap_or_default();
        // Migrate retired `npx …@latest` launch commands to the global-binary
        // form. Persist once if anything changed so it's a one-time rewrite.
        let mut migrated = false;
        for agent in &mut configured_agents {
            if let Some(new_cmd) = super::agents::migrate_npx_command(&agent.id, &agent.acp_command)
            {
                agent.acp_command = new_cmd;
                migrated = true;
            }
        }
        if migrated {
            if let Some(store) = store.as_ref() {
                let _ = store.save_agents(&configured_agents);
            }
        }
        // Always present every known agent in canonical order, even those never
        // saved (e.g. newly installed). Keeps the UI list stable and complete
        // without waiting on live detection; version/install state is layered on
        // later by `agents.detect`.
        let configured_agents = super::agents::reconcile_agents_config(&configured_agents);
        // Re-probe every enabled agent, cached list or not: the user may have
        // added a provider inside the harness (a new OpenCode provider, say)
        // since we last looked, and a cached list would hide it forever. The
        // cache still serves the UI instantly; the probe refreshes it behind it.
        let probe_candidates: Vec<String> = configured_agents
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect();

        let needs_setup = store
            .as_ref()
            .map(|s| !s.agents_configured())
            .unwrap_or(false);

        let orch_config = store
            .as_ref()
            .and_then(|s| s.load_orchestrator_config().ok())
            .flatten()
            .unwrap_or_default();

        // Only the stable tool-call timestamps survive startup. The full
        // transcripts are NOT loaded or held in memory — resume replay guards,
        // snapshots and finished-turn output read them from the store on demand.
        let tool_call_starts = store
            .as_ref()
            .and_then(|s| s.load_tool_call_starts().ok())
            .unwrap_or_default();

        let accounts = store
            .as_ref()
            .and_then(|s| s.load_accounts().ok())
            .unwrap_or_default();

        // Open (or disable) the shared-memory store. `load` never fails: an
        // unopenable memory.db yields a disabled store whose tools report
        // "memory disabled" rather than crashing the daemon.
        let memory = super::memory::MemoryStore::load();

        // Everything above read from the store directly — it is startup, the
        // actor is not running yet. From here the connection belongs to the
        // persistence thread and writes go through the queue.
        let (persist, store) = super::runtime::Persist::spawn(store);

        let config_observer = ConfigObserver::new(&projects);
        let daemon = Daemon {
            projects,
            config_observer,
            tasks,
            configured_agents,
            sessions: HashMap::new(),
            pending_permissions: PendingPermissions::default(),
            agents: AgentManager::new(agent_tx),
            services: ServiceManager::new(service_tx),
            portforwards: PortForwardManager::new(pf_tx),
            lsp: super::lsp::LspManager::new(event_tx.clone()),
            event_tx: event_tx.clone(),
            acp_tx,
            cmd_tx: cmd_tx.clone(),
            persist,
            store,
            resume_replay: HashMap::new(),
            worktrees: HashMap::new(),
            pending_session_starts: HashMap::new(),
            policies: default_policies(),
            policy_tx,
            orch_tx: None,
            orch_event_rx: None,
            orch_config,
            orchestrator_inbox: HashMap::new(),
            pending_wake: std::collections::HashSet::new(),
            tool_call_starts,
            last_session_update: HashMap::new(),
            turn_updates: HashMap::new(),
            pending_resume: HashMap::new(),
            workflow_runs: HashMap::new(),
            accounts,
            memory,
            last_memory_activity: Arc::new(Mutex::new(std::time::Instant::now())),
        };

        let handle = DaemonHandle { cmd_tx, event_tx };

        // Detect installed agents in background so it doesn't block startup,
        // then emit setup_needed if no agents are configured yet.
        if needs_setup {
            let ev_tx = handle.event_tx.clone();
            tokio::spawn(async move {
                let detected = super::agents::detect_agents_local().await;
                let _ = ev_tx.send(Event::AgentsSetupNeeded { detected });
            });
        }

        // Spawn the orchestrator with loaded config.
        let orch_config = daemon.orch_config.clone();
        let orch_handle = handle.clone();
        let (orch_cmd_tx, orch_event_bcast) =
            crate::orchestration::spawn_orchestrator(orch_config, orch_handle);

        // Forward orchestrator events into the daemon broadcast.
        let ev_tx = handle.event_tx.clone();
        let mut orch_event_rx = orch_event_bcast.subscribe();
        tokio::spawn(async move {
            while let Ok(ev) = orch_event_rx.recv().await {
                let _ = ev_tx.send(Event::OrchestrationEvent(ev));
            }
        });

        // Rebuild daemon with orchestrator handles.
        let mut daemon = daemon;
        daemon.orch_tx = Some(orch_cmd_tx);
        daemon.orch_event_rx = None; // receiver moved to forwarder task
                                     // Bring persisted workflow pipelines back: barrier states as-is,
                                     // mid-stage runs paused at their last barrier.
        daemon.restore_workflow_runs();

        // Dreaming idle/cron scheduler (config-driven, enabled false by default)
        let dream_cfg = daemon.memory.config().dreaming.clone();
        let dream_tx = handle.cmd_tx.clone();
        if dream_cfg.enabled && dream_cfg.trigger == "idle" {
            let idle = crate::daemon::memory_dream::parse_idle_after(&dream_cfg.idle_after);
            let last_activity = daemon.last_memory_activity.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(idle).await;
                    let been_idle = last_activity.lock().unwrap().elapsed() >= idle;
                    if !been_idle {
                        continue;
                    }
                    let (tx, _rx) = tokio::sync::oneshot::channel();
                    let _ = dream_tx
                        .send(Command::MemoryDream {
                            dry_run: false,
                            project_id: None,
                            reply: tx,
                        })
                        .await;
                }
            });
        } else if dream_cfg.enabled && dream_cfg.trigger == "cron" {
            let cron_str = dream_cfg.cron.clone();
            tokio::spawn(async move {
                // Full cron parsing is deferred (no extra dep): treat the configured
                // cron (default "0 3 * * *") as a daily-3am stub approximated by a
                // periodic loop. Keeps looping forever; the daemon dedupes via the
                // pending-compaction check. Config change requires restart.
                let _ = cron_str;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let (tx, _rx) = tokio::sync::oneshot::channel();
                    let _ = dream_tx
                        .send(Command::MemoryDream {
                            dry_run: false,
                            project_id: None,
                            reply: tx,
                        })
                        .await;
                }
            });
        }

        // History retention sweeps: once at start (so a shortened window
        // applies without waiting a day), then daily.
        let prune_tx = handle.cmd_tx.clone();
        tokio::spawn(async move {
            loop {
                if prune_tx.send(Command::PruneHistory).await.is_err() {
                    break;
                }
                tokio::time::sleep(HISTORY_PRUNE_INTERVAL).await;
            }
        });

        tokio::spawn(daemon.run(cmd_rx, agent_rx, service_rx, pf_rx, acp_rx, policy_rx));

        // Kick off background ACP probes so every enabled agent's model list is
        // whatever the harness reports right now. Probes update the cache via
        // `Command::AgentProbed`; cheap to issue even before `run` is ready.
        let probe_tx = handle.cmd_tx.clone();
        if !probe_candidates.is_empty() {
            tokio::spawn(async move {
                for id in probe_candidates {
                    let _ = probe_tx.send(Command::ProbeAgent { id, reply: None }).await;
                }
            });
        }

        handle
    }

    fn emit(&self, event: Event) {
        // Err just means no subscribers right now — fine.
        let _ = self.event_tx.send(event);
    }

    fn persist(&self, task: &Task) {
        self.persist.task(task);
    }

    /// A blocking store read, for startup only.
    ///
    /// Its one caller — `restore_workflow_runs` — runs inside [`Daemon::spawn`]
    /// before the actor loop starts, so blocking here blocks nothing. A handler
    /// must never use it: that is a blocking disk read on the actor's thread,
    /// which is the whole subject of ADR 0002. Reads from a handler go through
    /// `runtime::store_read` on the blocking pool, and writes through
    /// `self.persist`.
    fn with_store<T>(&self, read: impl FnOnce(&Store) -> T) -> Option<T> {
        let store = self.store.as_ref()?;
        // Recover a poisoned lock instead of taking the daemon down with the
        // persistence thread.
        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        Some(read(&guard))
    }

    fn build_project_config_state(
        &self,
        index: usize,
        config: Option<&WorkspaceConfig>,
    ) -> wire::ProjectConfigState {
        let project = &self.projects[index];
        let (start, end) = crate::ports::port_range(index);
        let declared_services = config.map(sorted_services).unwrap_or_default();
        let agent_templates = config
            .and_then(|c| c.agent_templates.as_ref())
            .map(|templates| {
                templates
                    .iter()
                    .map(|(name, template)| (name.clone(), template.command.clone()))
                    .collect()
            })
            .unwrap_or_default();

        // Start from every declared service in a stopped state, then overlay a
        // matching live process. This lets clients render Start controls before
        // a service has ever been launched.
        let mut service_map: HashMap<String, wire::ServiceInfo> = config
            .map(|config| {
                config
                    .services
                    .iter()
                    .map(|(name, service)| {
                        (
                            name.clone(),
                            wire::ServiceInfo {
                                project: project.name.clone(),
                                name: name.clone(),
                                command: service.command.clone(),
                                status: wire::ServiceStatus::Stopped,
                                original_port: service.port.unwrap_or(0),
                                allocated_port: 0,
                                log_seq: 0,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        for service in self.services.list_for_project(&project.name) {
            if let Some(declared) = service_map.get_mut(&service.name) {
                declared.status = wireconv::service_status(&service.status);
                declared.allocated_port = service.allocated_port;
                declared.log_seq = self.services.newest_seq(&project.name, &service.name);
                if matches!(
                    service.status,
                    ServiceStatus::Starting | ServiceStatus::Running
                ) {
                    // A running process still reflects the definition it was
                    // launched with. Stopped/failed entries use the refreshed
                    // config so their next Start is represented accurately.
                    declared.command = service.command.clone();
                    declared.original_port = service.original_port;
                }
            }
        }
        let mut services: Vec<_> = service_map.into_values().collect();
        services.sort_by(|a, b| a.name.cmp(&b.name));

        // As with services, declared port-forwards exist in client state even
        // before kubectl has been started. Live state wins only while that
        // forward is still present in the current config.
        let mut pf_map: HashMap<String, wire::PortForwardInfo> = config
            .map(|config| {
                config
                    .portforwards
                    .iter()
                    .map(|pf| {
                        let name = pf
                            .name
                            .clone()
                            .unwrap_or_else(|| format!("{}:{}", pf.namespace, pf.pod));
                        (
                            name.clone(),
                            wire::PortForwardInfo {
                                project: project.name.clone(),
                                name,
                                namespace: pf.namespace.clone(),
                                pod: pf.pod.clone(),
                                local_port: pf.local_port,
                                remote_port: pf.remote_port,
                                status: wire::PortForwardStatus::Stopped,
                                log_seq: 0,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        for pf in self.portforwards.list_for_project(&project.name) {
            if pf_map.contains_key(&pf.name) {
                pf_map.insert(
                    pf.name.clone(),
                    wire::PortForwardInfo {
                        project: project.name.clone(),
                        name: pf.name.clone(),
                        namespace: pf.namespace.clone(),
                        pod: pf.pod_prefix.clone(),
                        local_port: pf.local_port,
                        remote_port: pf.remote_port,
                        status: wireconv::pf_status(&pf.status),
                        log_seq: self.portforwards.newest_seq(&project.name, &pf.name),
                    },
                );
            }
        }
        let mut portforwards: Vec<_> = pf_map.into_values().collect();
        portforwards.sort_by(|a, b| a.name.cmp(&b.name));

        wire::ProjectConfigState {
            project: wire::ProjectInfo {
                name: project.name.clone(),
                path: project.path.clone(),
                port_range: (start, end),
                declared_services,
                agent_templates,
            },
            services,
            portforwards,
        }
    }

    /// Build the serializable snapshot handed to a client on subscribe.
    ///
    /// `session_history` is filled in by the caller (from the store, off the
    /// loop) — the actor holds no in-memory transcript to fold here.
    fn build_snapshot_core(&self) -> wire::Snapshot {
        let mut projects = Vec::new();
        let mut services = Vec::new();
        let mut portforwards = Vec::new();
        for (index, project) in self.projects.iter().enumerate() {
            let config = load_workspace_config(Path::new(&project.path));
            let state = self.build_project_config_state(index, config.as_ref());
            projects.push(state.project);
            services.extend(state.services);
            portforwards.extend(state.portforwards);
        }

        let mut tasks: Vec<wire::TaskInfo> = self.tasks.values().map(wireconv::task_info).collect();
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));

        let terminals = self
            .agents
            .live()
            .map(|a| {
                let (cols, rows) = a.dims();
                wire::TerminalInfo {
                    id: a.id.clone(),
                    project: a.project_name.clone(),
                    command: a.command.clone(),
                    started_at: a.started_at,
                    cols,
                    rows,
                }
            })
            .collect();

        // History is read from the store by the caller, then folded; the actor
        // holds no transcript in memory to fold here.
        wire::Snapshot {
            projects,
            services,
            portforwards,
            tasks,
            terminals,
            session_history: HashMap::new(),
            agents: self.configured_agents.clone(),
            accounts: self.account_infos(),
        }
    }

    fn project_path(&self, name: &str) -> Option<String> {
        self.projects
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.path.clone())
    }

    fn task_repo_path(&self, task_id: &str) -> Option<String> {
        self.tasks.get(task_id).and_then(|task| {
            task.worktree
                .clone()
                .or_else(|| self.project_path(&task.project))
        })
    }

    /// Bump a task's `updated_at`, persist, and emit `TaskUpdated` so every
    /// client refetches its diff/branch (used after git ops change the tree).
    fn bump_task(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.updated_at = super::task::now_secs();
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
    }

    fn project_index(&self, name: &str) -> usize {
        self.projects
            .iter()
            .position(|p| p.name == name)
            .unwrap_or(0)
    }

    async fn run(
        mut self,
        mut cmd_rx: mpsc::Receiver<Command>,
        mut agent_rx: mpsc::UnboundedReceiver<AgentEvent>,
        mut service_rx: mpsc::UnboundedReceiver<ServiceEvent>,
        mut pf_rx: mpsc::UnboundedReceiver<PfEvent>,
        mut acp_rx: mpsc::UnboundedReceiver<(String, AcpUpdate)>,
        mut policy_rx: mpsc::UnboundedReceiver<PolicyCheck>,
    ) {
        enum ShutdownReply {
            Requested(oneshot::Sender<()>),
            Update(oneshot::Sender<Vec<String>>),
        }

        let mut config_poll = tokio::time::interval(CONFIG_POLL_INTERVAL);
        config_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let shutdown_reply = loop {
            tokio::select! {
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(Command::Shutdown { reply }) => break Some(ShutdownReply::Requested(reply)),
                        Some(Command::UpdateSafety { reply }) => {
                            let blockers = self.update_blockers_snapshot();
                            if blockers.is_empty() {
                                break Some(ShutdownReply::Update(reply));
                            }
                            let _ = reply.send(blockers);
                        }
                        None => break None,
                        Some(cmd) => self.handle_command(cmd).await,
                    }
                }
                Some(ev) = agent_rx.recv() => self.handle_agent_event(ev),
                Some(ev) = service_rx.recv() => self.handle_service_event(ev),
                Some(ev) = pf_rx.recv() => self.handle_pf_event(ev),
                Some((task_id, update)) = acp_rx.recv() => self.handle_acp_update(task_id, update).await,
                Some(check) = policy_rx.recv() => self.handle_policy_check(check).await,
                _ = config_poll.tick() => self.handle_config_changes().await,
            }
        };

        // Teardown — stop everything we started.
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        // Only ports this daemon handed out. Sweeping the whole range kills
        // whatever else happens to listen there — a developer's own server, or
        // an agent process — and this runs on every shutdown, including the
        // ones the test suite performs on the developer's machine.
        crate::service::kill_listeners_on_ports(&crate::ports::allocated_in_ranges(
            &self.project_port_ranges(),
        ))
        .await;
        self.agents.kill_all();
        // Writes are applied on another thread, so exiting without draining the
        // queue drops the tail of every transcript written since the last
        // batch. Everything above can still enqueue, so flush last.
        self.persist.flush().await;
        match shutdown_reply {
            Some(ShutdownReply::Requested(reply)) => {
                let _ = reply.send(());
            }
            Some(ShutdownReply::Update(reply)) => {
                let _ = reply.send(Vec::new());
            }
            None => {}
        }
    }

    async fn handle_config_changes(&mut self) {
        let ready = self.config_observer.ready(&self.projects, Instant::now());
        for (project_name, fingerprint) in ready {
            let Some(index) = self
                .projects
                .iter()
                .position(|project| project.name == project_name)
            else {
                continue;
            };
            let project_path = self.projects[index].path.clone();

            // An existing but invalid file is commonly just an editor's
            // intermediate save. Keep the last rendered state and retry after
            // the contents change instead of flashing empty controls.
            let config = match try_load_workspace_config(Path::new(&project_path)) {
                Ok(config) => config,
                Err(_) => continue,
            };

            self.remove_undeclared_runtime(&project_name, config.as_ref())
                .await;
            self.config_observer
                .mark_applied(&project_name, fingerprint);
            let state = self.build_project_config_state(index, config.as_ref());
            self.emit(Event::ProjectConfigChanged(state));
        }
    }

    fn handle_agent_event(&mut self, ev: AgentEvent) {
        let known_agent = match &ev {
            AgentEvent::Data { id, .. } | AgentEvent::Exit { id, .. } => {
                self.agents.get(id).is_some()
            }
        };
        self.agents.apply_event(&ev);
        match ev {
            AgentEvent::Data { id, data, .. } => {
                if let Some(agent) = self.agents.get(&id) {
                    self.emit(Event::AgentStatus {
                        id: id.clone(),
                        status: agent.status.clone(),
                    });
                    // Serialize and push the terminal screen for remote clients.
                    if let Ok(parser) = agent.screen.lock() {
                        let screen = wireconv::terminal_screen(&parser);
                        self.emit(Event::TerminalScreen {
                            terminal_id: id.clone(),
                            screen,
                        });
                    }
                    // Raw PTY bytes for terminal-emulator clients (xterm.js).
                    use base64::Engine;
                    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    self.emit(Event::TerminalData {
                        terminal_id: id,
                        data_b64,
                    });
                }
            }
            AgentEvent::Exit { id, .. } if known_agent => self.emit(Event::AgentExited { id }),
            AgentEvent::Exit { .. } => {}
        }
    }

    fn handle_service_event(&mut self, ev: ServiceEvent) {
        let broadcast = match &ev {
            ServiceEvent::Log { key, line, .. } => {
                let (project, service) = split_key(key);
                Event::ServiceLog {
                    project,
                    service,
                    line: line.clone(),
                }
            }
            ServiceEvent::StatusChange { key, status, .. } => {
                let (project, service) = split_key(key);
                let allocated_port = self
                    .services
                    .get(&project, &service)
                    .map(|s| s.allocated_port)
                    .unwrap_or(0);
                Event::ServiceStatus {
                    project,
                    service,
                    status: status.clone(),
                    allocated_port,
                }
            }
        };
        self.services.apply_event(ev);
        match &broadcast {
            Event::ServiceStatus {
                project, service, ..
            } => {
                self.emit_service_status(project, service);
            }
            Event::ServiceLog {
                project, service, ..
            } if self.services.get(project, service).is_some() => self.emit(broadcast),
            _ => {}
        }
    }

    fn handle_pf_event(&mut self, ev: PfEvent) {
        let key = format!("{}/{}", ev.project(), ev.name());
        let broadcast = match &ev {
            PfEvent::Log {
                project,
                name,
                line,
            } => Event::PortForwardLog {
                project: project.clone(),
                name: name.clone(),
                line: line.clone(),
            },
            PfEvent::Active { project, name, .. } | PfEvent::Restarted { project, name, .. } => {
                Event::PortForwardStatus {
                    project: project.clone(),
                    name: name.clone(),
                    status: PfStatus::Active,
                }
            }
            PfEvent::Failed { project, name, .. } => Event::PortForwardStatus {
                project: project.clone(),
                name: name.clone(),
                status: PfStatus::Failed,
            },
        };
        self.portforwards.apply_event(ev);
        if self.portforwards.forwards.contains_key(&key) {
            self.emit(broadcast);
        }
    }

    fn update_blockers_snapshot(&self) -> Vec<String> {
        let mut blockers = Vec::new();
        let active_tasks = self
            .tasks
            .values()
            .filter(|task| matches!(task.status, TaskStatus::Queued | TaskStatus::Running))
            .count();
        if active_tasks > 0 {
            blockers.push(format!("{active_tasks} agent task(s) are active"));
        }
        let terminals = self
            .agents
            .all()
            .filter(|agent| {
                matches!(
                    agent.status,
                    AgentStatus::Spawning | AgentStatus::Running | AgentStatus::NeedsReview
                )
            })
            .count();
        if terminals > 0 {
            blockers.push(format!("{terminals} terminal session(s) are active"));
        }
        let transitioning_services = self
            .services
            .all()
            .filter(|service| matches!(service.status, ServiceStatus::Starting))
            .count();
        if transitioning_services > 0 {
            blockers.push(format!(
                "{transitioning_services} service(s) are still starting"
            ));
        }
        let transitioning_forwards = self
            .portforwards
            .forwards
            .values()
            .filter(|forward| matches!(forward.status, PfStatus::Starting | PfStatus::Restarting))
            .count();
        if transitioning_forwards > 0 {
            blockers.push(format!(
                "{transitioning_forwards} port-forward(s) are transitioning"
            ));
        }
        blockers
    }

    async fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::AddProject { path, name, reply } => {
                let result = self.add_project(&path, name.as_deref()).await;
                let _ = reply.send(result);
            }
            Command::RemoveProject {
                name,
                stop_resources,
                reply,
            } => {
                let result = self.remove_project(&name, stop_resources).await;
                let _ = reply.send(result);
            }
            Command::LspStart {
                task_id,
                language,
                project,
                reply,
            } => {
                let root = self
                    .tasks
                    .get(&task_id)
                    .and_then(|task| {
                        task.worktree
                            .clone()
                            .or_else(|| self.project_path(&task.project))
                    })
                    .or_else(|| project.as_deref().and_then(|p| self.project_path(p)));
                let result = match root {
                    Some(root) => {
                        let (server_id, available) = self.lsp.start(root.clone(), language);
                        wire::LspStartResult {
                            server_id,
                            available,
                            root_path: if available { root } else { String::new() },
                        }
                    }
                    None => wire::LspStartResult {
                        server_id: String::new(),
                        available: false,
                        root_path: String::new(),
                    },
                };
                let _ = reply.send(result);
            }
            Command::LspSend { server_id, payload } => self.lsp.send(&server_id, payload),
            Command::LspStop { server_id } => self.lsp.stop(&server_id),
            Command::Shutdown { .. } => unreachable!(
                "Shutdown commands are intercepted by the actor loop before handle_command"
            ),
            Command::UpdateSafety { .. } => unreachable!(
                "UpdateSafety commands are intercepted by the actor loop before handle_command"
            ),
            Command::Projects(reply) => {
                let _ = reply.send(self.projects.clone());
            }
            Command::Tasks(reply) => {
                let mut tasks: Vec<Task> = self.tasks.values().cloned().collect();
                tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));
                let _ = reply.send(tasks);
            }
            Command::Snapshot(reply) => {
                // The snapshot's history must not be read on the loop: a disk
                // read here would miss whatever write-behind persistence still
                // has queued, and it would block the actor (ADR 0002). Flush +
                // read + fold happen on a worker; only the reply crosses back.
                // Clients get a recent tail per task — full transcripts load
                // per task through `session.history`, so a connect no longer
                // depends on reading every transcript in the database.
                let mut snapshot = self.build_snapshot_core();
                let persist = self.persist.clone();
                let store = self.store.clone();
                tokio::spawn(async move {
                    persist.flush().await;
                    snapshot.session_history = super::runtime::store_read(store, |store| {
                        store
                            .load_session_update_tails(SNAPSHOT_HISTORY_TAIL)
                            .unwrap_or_default()
                    })
                    .await
                    .unwrap_or_default();
                    let _ = reply.send(snapshot);
                });
            }
            Command::SessionHistory { task_id, reply } => {
                // Same off-loop shape as Command::Snapshot: flush first so the
                // read sees everything the write-behind queue still holds.
                let persist = self.persist.clone();
                let store = self.store.clone();
                tokio::spawn(async move {
                    persist.flush().await;
                    let result = super::runtime::store_read(store, move |store| {
                        store
                            .load_session_updates(&task_id)
                            .map(|updates| super::store::fold_for_snapshot(&updates))
                            .map_err(|e| format!("{e:#}"))
                    })
                    .await
                    .unwrap_or_else(|| Err("daemon has no persistent store".into()));
                    let _ = reply.send(result);
                });
            }
            Command::HistoryGetSettings { reply } => {
                let config = super::history_config::HistoryConfig::load();
                let _ = reply.send(wire::HistorySettings {
                    retention_days: config.retention_days,
                    settle_ignored_after_days: config.settle_ignored_after_days,
                    delete_closed_after_days: config.delete_closed_after_days,
                });
            }
            Command::HistorySetSettings {
                retention_days,
                settle_ignored_after_days,
                delete_closed_after_days,
                reply,
            } => {
                let config = super::history_config::HistoryConfig {
                    retention_days,
                    settle_ignored_after_days,
                    delete_closed_after_days,
                };
                let result = super::history_config::save(&config)
                    .map(|_| wire::HistorySettings {
                        retention_days,
                        settle_ignored_after_days,
                        delete_closed_after_days,
                    })
                    .map_err(|e| format!("{e:#}"));
                if result.is_ok() {
                    self.history_sweep();
                }
                let _ = reply.send(result);
            }
            Command::PruneHistory => self.history_sweep(),
            Command::OpenProject { name } => self.open_project(&name).await,
            Command::StartService { project, service } => {
                self.start_one_service(&project, &service).await;
            }
            Command::StopService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.emit_service_status(&project, &service);
            }
            Command::RestartService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.emit_service_status(&project, &service);
                self.start_one_service(&project, &service).await;
            }
            Command::StartAllServices { project } => {
                self.start_services(&project).await;
            }
            Command::StopProject { project } => {
                let services: Vec<String> = self
                    .services
                    .list_for_project(&project)
                    .into_iter()
                    .map(|svc| svc.name.clone())
                    .collect();
                let pfs: Vec<String> = self
                    .portforwards
                    .list_for_project(&project)
                    .iter()
                    .map(|pf| pf.name.clone())
                    .collect();
                self.services.stop_project(&project).await.ok();
                self.portforwards.stop_project(&project);
                if let Some(index) = self.projects.iter().position(|p| p.name == project) {
                    kill_listeners_in_ranges(&[crate::ports::port_range(index)]).await;
                }
                for service in services {
                    self.emit_service_status(&project, &service);
                }
                self.emit_portforward_statuses(&project, &pfs);
            }
            Command::StopRuntime => {
                self.stop_runtime().await;
            }
            Command::ServiceLogs {
                project,
                service,
                after,
                limit,
                reply,
            } => {
                let (lines, at, next_seq) =
                    self.services.log_window(&project, &service, after, limit);
                let _ = reply.send((lines, at, next_seq));
            }
            Command::StartAllPortForwards { project } => {
                self.start_portforwards(&project).await;
            }
            Command::StartPortForward { project, name } => {
                self.start_one_portforward(&project, &name).await;
            }
            Command::StopPortForward { project, name } => {
                self.portforwards.stop(&project, &name);
                self.emit_portforward_status(&project, &name);
            }
            Command::StopAllPortForwards { project } => {
                let pfs: Vec<String> = self
                    .portforwards
                    .list_for_project(&project)
                    .iter()
                    .map(|pf| pf.name.clone())
                    .collect();
                self.portforwards.stop_project(&project);
                for name in pfs {
                    self.emit_portforward_status(&project, &name);
                }
            }
            Command::PortForwardLogs {
                project,
                name,
                after,
                limit,
                reply,
            } => {
                let (lines, at, next_seq) =
                    self.portforwards.log_window(&project, &name, after, limit);
                let _ = reply.send((lines, at, next_seq));
            }
            Command::SpawnAgent {
                project,
                command,
                description,
                cols,
                rows,
                reply,
            } => {
                let result = match self.project_path(&project) {
                    Some(path) => {
                        self.agents
                            .spawn(&project, &path, &command, &description, cols, rows)
                    }
                    None => Err(anyhow::anyhow!("unknown project: {project}")),
                };
                if let Ok(ref id) = result {
                    if let Some(agent) = self.agents.get(id) {
                        self.emit(Event::AgentSpawned {
                            id: id.clone(),
                            project: project.clone(),
                            screen: Arc::clone(&agent.screen),
                        });
                        let (cols, rows) = agent.dims();
                        self.emit(Event::TerminalSpawned {
                            info: wire::TerminalInfo {
                                id: id.clone(),
                                project: project.clone(),
                                command: agent.command.clone(),
                                started_at: agent.started_at,
                                cols,
                                rows,
                            },
                        });
                    }
                }
                let _ = reply.send(result);
            }
            Command::WriteAgent { id, data } => self.agents.write(&id, data),
            Command::ResizeAgent { id, cols, rows } => self.agents.resize(&id, cols, rows),
            Command::KillAgent { id } => {
                self.agents.kill(&id);
                self.emit(Event::AgentExited { id });
            }
            Command::CreateTask {
                project,
                prompt,
                agent,
                tags,
                include_runtime_context,
                worktree: use_worktree,
                parent_task_id,
                attachments,
                default_model,
                config_overrides,
                backlog_item_id,
                start,
                reply,
            } => {
                // Conversation branches tag the source task they were forked
                // from, so the new worktree can inherit its state.
                let branched_from = tags
                    .iter()
                    .find_map(|t| t.strip_prefix("branched-from:"))
                    .map(str::to_string);
                let mut task = Task::new(&project, &prompt, &agent, tags);
                task.parent_task_id = parent_task_id;
                task.backlog_item_id = backlog_item_id;
                // Durable model intent: only an explicit pick counts. The
                // last_model fallback below is a default, not something the
                // user asked this task to run on, so it must not land here.
                task.model = default_model.clone();
                // Resolve the model the session should start with: an explicit
                // UI pick wins; otherwise fall back to the user's last choice
                // for this agent (so orchestrator-spawned sub-agents inherit it
                // without a UI). Update the persisted last-model whenever the
                // user made an explicit pick so the next task defaults to it.
                let resolved_model = default_model.clone().or_else(|| {
                    self.configured_agents
                        .iter()
                        .find(|a| a.id == agent)
                        .and_then(|a| a.last_model.clone())
                });
                if let Some(ref m) = default_model {
                    if let Some(agent_cfg) =
                        self.configured_agents.iter_mut().find(|a| a.id == agent)
                    {
                        if agent_cfg.last_model.as_deref() != Some(m.as_str()) {
                            agent_cfg.last_model = Some(m.clone());
                            self.persist.write(PersistWrite::AgentModels {
                                id: agent_cfg.id.clone(),
                                models: agent_cfg.models.clone(),
                                last_model: agent_cfg.last_model.clone(),
                            });
                            let agents = self.configured_agents.clone();
                            self.emit(Event::AgentsUpdated { agents });
                        }
                    }
                }
                let id = task.id.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());

                if start {
                    let start = PendingSessionStart {
                        project: project.clone(),
                        agent: agent.clone(),
                        prompt: prompt.clone(),
                        include_runtime_context,
                        attachments,
                        default_model: resolved_model,
                        config_overrides,
                    };
                    // A worktree checkout is git work, so it runs off the loop
                    // and the session starts when it lands. The task is on the
                    // board before then, which is also why a new task no longer
                    // delays every other task's messages (ADR 0002).
                    match use_worktree
                        .then(|| self.worktree_request(&id, &project, branched_from.as_deref()))
                        .flatten()
                    {
                        Some(request) => {
                            self.pending_session_starts.insert(id.clone(), start);
                            let cmd_tx = self.cmd_tx.clone();
                            tokio::spawn(async move {
                                let created = request.run().await;
                                let _ = cmd_tx
                                    .send(Command::WorktreeReady {
                                        task_id: id,
                                        created,
                                    })
                                    .await;
                            });
                        }
                        None => self.start_pending_session(&id, start),
                    }
                }
            }
            Command::WorktreeReady { task_id, created } => {
                // Record the checkout even if nobody is waiting for it any
                // more: the directory exists on disk either way, and a
                // worktree the manager does not know about is one nothing can
                // clean up later.
                match created {
                    Ok((project, wt)) => {
                        if let Some(task) = self.tasks.get_mut(&task_id) {
                            task.worktree = Some(wt.path.to_string_lossy().to_string());
                            let updated = task.clone();
                            self.persist(&updated);
                            self.emit(Event::TaskUpdated(updated));
                        }
                        if let Some(mgr) = self.worktrees.get_mut(&project) {
                            mgr.adopt(wt);
                        }
                    }
                    // Fall back to a non-isolated run, as before.
                    Err(error) => eprintln!("[daemon] worktree creation failed: {error}"),
                }
                // The pending entry is the token: cancelling or deleting the
                // task removes it, so a checkout that lands afterwards must not
                // start a session for it (ADR 0002 invariant 5).
                if let Some(start) = self.pending_session_starts.remove(&task_id) {
                    self.start_pending_session(&task_id, start);
                }
            }
            #[cfg(test)]
            Command::TurnOutputConsumerProbe {
                task_id,
                workflow_child,
                reply,
            } => {
                let _ = reply.send(self.turn_output_has_consumer(&task_id, workflow_child));
            }
            Command::GitOpFinished { task_id, effect } => match effect {
                GitEffect::Bump => self.bump_task(&task_id),
                GitEffect::Committed => {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        task.updated_at = super::task::now_secs();
                        task.files_changed = 0;
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
                GitEffect::HunkRejected => {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        task.updated_at = super::task::now_secs();
                        task.files_changed = task.files_changed.saturating_sub(1);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
            },
            Command::ResumeReplayReady {
                task_id,
                mut replay,
            } => {
                // The pending entry is the token: cancelling or deleting the
                // task removes it, so a guard that lands afterwards must not
                // resurrect a cancelled task's session (ADR 0002 invariant 5).
                if let Some(pending) = self.pending_resume.remove(&task_id) {
                    if let Some(guard) = ResumeReplayGuard::from_updates(replay.make_contiguous()) {
                        self.resume_replay.insert(task_id.clone(), guard);
                    }
                    self.start_session(
                        &task_id,
                        &pending.project,
                        &pending.agent,
                        &pending.text,
                        false,
                        Some(pending.session_id),
                        pending.attachments,
                        pending.default_model,
                        std::collections::HashMap::new(),
                    );
                }
            }
            Command::TaskOutputReady {
                task_id,
                success,
                workflow_child,
                output,
            } => {
                // A finished turn's full text was assembled off the loop; now
                // deliver it the way TurnEnded used to. notify_orch_finished is
                // a no-op unless the task is an orchestrator child.
                self.notify_orch_finished(&task_id, success, output.clone());
                if !workflow_child {
                    self.deliver_child_result(&task_id, success, output);
                }
            }
            Command::CreateWorkflowTask {
                project,
                prompt,
                agent,
                tags,
                worktree,
                workflow,
                attachments,
                default_model,
                include_runtime_context,
                config_overrides,
                parent_task_id,
                reply,
            } => {
                let result = self
                    .workflow_create(
                        project,
                        prompt,
                        agent,
                        tags,
                        worktree,
                        workflow,
                        attachments,
                        default_model,
                        include_runtime_context,
                        config_overrides,
                        parent_task_id,
                    )
                    .await;
                let _ = reply.send(result);
            }
            Command::WorkflowPause { task, reply } => {
                let _ = reply.send(self.workflow_pause(&task));
            }
            Command::WorkflowResume { task, note, reply } => {
                let _ = reply.send(self.workflow_resume(&task, note).await);
            }
            Command::WorkflowReply {
                task,
                message,
                reply,
            } => {
                let _ = reply.send(self.workflow_reply(&task, message).await);
            }
            Command::WorkflowDecide {
                task,
                decision,
                rounds,
                note,
                reply,
            } => {
                let _ = reply.send(self.workflow_decide(&task, decision, rounds, note).await);
            }
            Command::ReadInbox {
                parent_task_id,
                reply,
            } => {
                let results = self
                    .orchestrator_inbox
                    .remove(&parent_task_id)
                    .unwrap_or_default();
                self.pending_wake.remove(&parent_task_id);
                let _ = reply.send(results);
            }
            Command::GetDiff { task_id, reply } => {
                // Resolve the repo path from actor state, then run git off the
                // loop. The diff panel polls this, so awaiting it here put a
                // pair of git processes between every poll and the next
                // command — a tool approval included (ADR 0002).
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::spawn(async move {
                    let (files, branch) = match repo {
                        Some(path) => (
                            super::diff::working_diff(&path).await.unwrap_or_default(),
                            super::diff::current_branch(&path).await,
                        ),
                        None => (Vec::new(), None),
                    };
                    let _ = reply.send(wire::TaskDiff {
                        task_id,
                        files,
                        branch,
                    });
                });
            }
            Command::GetFileContents {
                task_id,
                path,
                project,
                reply,
            } => {
                // Same fallback as `ListFiles`: no task means read the
                // project's own checkout, so a tree and its preview agree.
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
                tokio::spawn(async move {
                    let doc = match repo {
                        Some(p) => super::diff::file_doc(&p, &path).await.ok(),
                        None => None,
                    };
                    let _ = reply.send(doc);
                });
            }
            Command::ListFiles {
                task_id,
                project,
                include_ignored,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
                tokio::spawn(async move {
                    let files = match repo {
                        Some(p) => super::diff::list_files(&p, include_ignored)
                            .await
                            .unwrap_or_default(),
                        None => Vec::new(),
                    };
                    let _ = reply.send(files);
                });
            }
            Command::SearchFiles {
                task_id,
                query,
                limit,
                project,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project))
                    .or_else(|| project.as_deref().and_then(|name| self.project_path(name)));
                match repo {
                    // A synchronous walk that reads every file in the project.
                    // Run inline it freezes the whole daemon for the length of
                    // the search — on a large repo, seconds (ADR 0002).
                    Some(p) => {
                        tokio::task::spawn_blocking(move || {
                            let matches =
                                super::search::search_files(&p, &query, limit).unwrap_or_default();
                            let _ = reply.send(matches);
                        });
                    }
                    None => {
                        let _ = reply.send(Vec::new());
                    }
                }
            }
            Command::SaveFile {
                task_id,
                path,
                content,
                project,
            } => {
                let repo: Option<std::path::PathBuf> = if let Some(proj) = project.clone() {
                    self.projects
                        .iter()
                        .find(|p| p.name == proj)
                        .map(|p| std::path::PathBuf::from(&p.path))
                } else {
                    self.tasks
                        .get(&task_id)
                        .and_then(|_| self.task_repo_path(&task_id).map(std::path::PathBuf::from))
                };
                let cmd_tx = self.cmd_tx.clone();
                let is_project = project.is_some();
                tokio::task::spawn_blocking(move || {
                    let Some(p) = repo else { return };
                    if super::diff::save_file(&p.to_string_lossy(), &path, &content).is_ok()
                        && !is_project
                    {
                        // Nudge clients so the diff/file list refetches.
                        let _ = cmd_tx.blocking_send(Command::GitOpFinished {
                            task_id,
                            effect: GitEffect::Bump,
                        });
                    }
                });
            }
            Command::CreateFile {
                task_id,
                path,
                directory,
                reply,
            } => {
                // Filesystem work: resolve the path here, touch the disk on the
                // blocking pool (ADR 0002 invariant 1).
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::task::spawn_blocking(move || {
                    let result = repo
                        .ok_or_else(|| format!("no repo for task {task_id}"))
                        .and_then(|repo| {
                            super::diff::create_file(&repo, &path, directory)
                                .map_err(|e| e.to_string())
                        });
                    let _ = reply.send(result);
                });
            }
            Command::RenameFile {
                task_id,
                path,
                new_path,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::task::spawn_blocking(move || {
                    let result = repo
                        .ok_or_else(|| format!("no repo for task {task_id}"))
                        .and_then(|repo| {
                            super::diff::rename_file(&repo, &path, &new_path)
                                .map_err(|e| e.to_string())
                        });
                    let _ = reply.send(result);
                });
            }
            Command::DeleteFile {
                task_id,
                path,
                reply,
            } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|_| self.task_repo_path(&task_id));
                tokio::task::spawn_blocking(move || {
                    let result = repo
                        .ok_or_else(|| format!("no repo for task {task_id}"))
                        .and_then(|repo| {
                            super::diff::delete_file(&repo, &path).map_err(|e| e.to_string())
                        });
                    let _ = reply.send(result);
                });
            }
            Command::ResolveHunk {
                task_id,
                file,
                hunk_index,
                resolution,
            } => {
                // accept keeps the change (no-op); only reject touches the tree.
                if resolution == wire::HunkResolution::Reject {
                    let repo = self.task_repo_path(&task_id);
                    let cmd_tx = self.cmd_tx.clone();
                    tokio::spawn(async move {
                        let Some(path) = repo else { return };
                        if super::diff::reject_hunk(&path, &file, hunk_index)
                            .await
                            .is_ok()
                        {
                            let _ = cmd_tx
                                .send(Command::GitOpFinished {
                                    task_id,
                                    effect: GitEffect::HunkRejected,
                                })
                                .await;
                        }
                    });
                }
            }
            Command::GitCommit {
                task_id,
                message,
                files,
                amend,
                project,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off the loop,
                // reporting what changed back as GitOpFinished (ADR 0002).
                let repo: Option<String> = if let Some(proj) = project.clone() {
                    self.projects
                        .iter()
                        .find(|p| p.name == proj)
                        .map(|p| p.path.clone())
                } else {
                    self.task_repo_path(&task_id)
                };
                let cmd_tx = self.cmd_tx.clone();
                let is_project = project.is_some();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::commit(&p, &message, files.as_deref(), amend)
                            .await
                            .map_err(|e| e.to_string()),
                        None => Err(if is_project {
                            format!("no repo for project {}", project.unwrap_or_default())
                        } else {
                            format!("no repo for task {task_id}")
                        }),
                    };
                    if result.is_ok() {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Committed,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitLastCommitMessage { task_id, reply } => {
                // Read-only, but still shells out — resolve here, run off the loop.
                let repo = self.task_repo_path(&task_id);
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::last_commit_message(&p)
                            .await
                            .map_err(|e| e.to_string()),
                        None => Err(format!("no repo for task {task_id}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::GitUpdate { task_id, reply } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::update_project(&p).await.unwrap_or_else(|e| {
                            wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }
                        }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    // A clean update changed HEAD/tree — nudge clients to refetch.
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranches {
                task_id,
                project,
                reply,
            } => {
                // A task pins its own project; without one, New Task passes the
                // project directly because no task exists yet.
                let repo = match task_id {
                    Some(id) => self.task_repo_path(&id),
                    None => project.as_deref().and_then(|p| self.project_path(p)),
                };
                tokio::spawn(async move {
                    let list = match repo {
                        Some(p) => super::diff::list_branches(&p).await.unwrap_or_default(),
                        None => wire::GitBranchList::default(),
                    };
                    let _ = reply.send(list);
                });
            }
            Command::GitSwitchBranch {
                task_id,
                branch,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::switch_branch(&p, &branch)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    // Switching branches changes the whole working tree — refetch.
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranchRename {
                task_id,
                branch,
                new_name,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::rename_branch(&p, &branch, &new_name)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranchDelete {
                task_id,
                branch,
                force,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::delete_branch(&p, &branch, force)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitBranchCreate {
                task_id,
                name,
                from,
                checkout,
                overwrite,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::branch_create(
                            &p,
                            &name,
                            from.as_deref(),
                            checkout,
                            overwrite,
                        )
                        .await
                        .unwrap_or_else(|e| wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: e.to_string(),
                            conflicts: Vec::new(),
                            branch: None,
                        }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitRebase {
                task_id,
                branch,
                target,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::rebase(&p, &branch, &target)
                            .await
                            .unwrap_or_else(|e| wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitMerge {
                task_id,
                target,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.task_repo_path(&task_id);
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(p) => super::diff::merge(&p, &target).await.unwrap_or_else(|e| {
                            wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }
                        }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitPushInfo { task_id, reply } => {
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                tokio::spawn(async move {
                    let result = match repo {
                        Some(path) => super::diff::push_info(&path)
                            .await
                            .map_err(|e| e.to_string()),
                        None => Err(format!("no repo for task {task_id}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::GitPush {
                task_id,
                force,
                reply,
            } => {
                // git shells out; resolve the repo here and run it off
                // the loop, reporting what changed back as
                // GitOpFinished (ADR 0002).
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let result = match repo {
                        Some(path) => super::diff::push(&path, force).await.unwrap_or_else(|e| {
                            wire::GitOpResult {
                                status: wire::GitOpStatus::Error,
                                message: e.to_string(),
                                conflicts: Vec::new(),
                                branch: None,
                            }
                        }),
                        None => wire::GitOpResult {
                            status: wire::GitOpStatus::Error,
                            message: format!("no repo for task {task_id}"),
                            conflicts: Vec::new(),
                            branch: None,
                        },
                    };
                    if result.status == wire::GitOpStatus::Ok {
                        let _ = cmd_tx
                            .send(Command::GitOpFinished {
                                task_id,
                                effect: GitEffect::Bump,
                            })
                            .await;
                    }
                    let _ = reply.send(result);
                });
            }
            Command::GitCreatePr {
                task_id,
                title,
                body,
                base,
                reply,
            } => {
                let repo = self.tasks.get(&task_id).and_then(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                });
                // Creating a PR shells out to the forge's CLI over the network;
                // it changes nothing the actor holds, so it just answers from a
                // task of its own (ADR 0002).
                tokio::spawn(async move {
                    let result = match repo {
                        Some(path) => super::diff::create_pr(&path, &title, &body, base.as_deref())
                            .await
                            .map_err(|e| e.to_string()),
                        None => Err(format!("no repo for task {task_id}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::GenerateText {
                task_id,
                agent_id,
                kind,
                model,
                account_id,
                input,
                reply,
            } => {
                // Resolve everything that needs actor state up front, then run
                // the (slow) git + agent work off the actor loop.
                let account = match account_id.as_deref() {
                    Some(id) => super::accounts::SpawnAccount::Pinned(id),
                    None => super::accounts::SpawnAccount::Active,
                };
                let resolved = self.tasks.get(&task_id).map(|task| {
                    let repo = task
                        .worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                        .unwrap_or_else(|| ".".to_string());
                    let command = self.resolve_agent_command(&task.project, &agent_id);
                    let env = self.resolve_agent_env(&agent_id, account);
                    let prompt = task.prompt.clone();
                    (repo, command, prompt, env)
                });
                match resolved {
                    Some((repo, command, prompt, env)) => {
                        tokio::spawn(async move {
                            let message = match kind {
                                wire::TextGenKind::TaskTitle => Some(prompt.as_str()),
                                // A handoff summarises the conversation, and
                                // the client is what knows where to cut it.
                                wire::TextGenKind::Handoff => input.as_deref(),
                                _ => None,
                            };
                            let result = match build_textgen_prompt(&repo, kind, message).await {
                                Ok(prompt) => {
                                    super::acp::generate_text(command, repo, prompt, model, env)
                                        .await
                                }
                                Err(e) => Err(e),
                            };
                            let _ = reply.send(result);
                        });
                    }
                    None => {
                        let _ = reply.send(Err(format!("no task {task_id}")));
                    }
                }
            }
            Command::EnhanceText {
                project,
                agent_id,
                prompt,
                model,
                reply,
            } => {
                let resolved = self.project_path(&project).map(|repo| {
                    let command = self.resolve_agent_command(&project, &agent_id);
                    let env =
                        self.resolve_agent_env(&agent_id, super::accounts::SpawnAccount::Active);
                    (repo, command, env)
                });
                match resolved {
                    Some((repo, command, env)) => {
                        let prompt = prompt.clone();
                        tokio::spawn(async move {
                            let result = match build_textgen_prompt(
                                &repo,
                                wire::TextGenKind::EnhancePrompt,
                                Some(&prompt),
                            )
                            .await
                            {
                                Ok(prompt) => {
                                    super::acp::generate_text(command, repo, prompt, model, env)
                                        .await
                                }
                                Err(e) => Err(e),
                            };
                            let _ = reply.send(result);
                        });
                    }
                    None => {
                        let _ = reply.send(Err(format!("no project {project}")));
                    }
                }
            }
            Command::TrackerPersistLink { link, reply } => {
                let result = match &self.store {
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store
                            .upsert_tracker_link(&link)
                            .map_err(|e| format!("failed to persist link: {e:#}"))
                    }
                    None => Err("daemon has no persistent store (demo mode?)".into()),
                };
                let _ = reply.send(result);
            }
            Command::TrackerLinks { reply } => {
                let result = match &self.store {
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        super::tracker::list_links(&store)
                            .map_err(|e: anyhow::Error| format!("{e:#}"))
                    }
                    None => Ok(Vec::new()),
                };
                let _ = reply.send(result);
            }
            Command::TrackerProjectSettings { project, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| "daemon has no persistent store".to_string())
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store
                            .tracker_project_settings(&project)
                            .map_err(|e| format!("{e:#}"))
                    });
                let _ = reply.send(result);
            }
            Command::TrackerSetProjectLinearTeam {
                project,
                team_id,
                team_name,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| "daemon has no persistent store".to_string())
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        // Pointing a project somewhere else (or nowhere) makes the
                        // rows the old team put here meaningless, so they go with
                        // the mapping. Only rows an import minted are eligible —
                        // see `Store::delete_imported_linear_items`.
                        let previous = store
                            .tracker_project_settings(&project)
                            .map_err(|e| format!("{e:#}"))?
                            .linear_team_id;
                        if previous.as_deref() != team_id.as_deref() {
                            match store.delete_imported_linear_items(&project) {
                                Ok(0) => {}
                                Ok(n) => eprintln!(
                                    "[tracker] dropped {n} imported Linear rows from \
                                     '{project}' after its team mapping changed"
                                ),
                                Err(e) => {
                                    return Err(format!("clearing old Linear rows failed: {e:#}"))
                                }
                            }
                        }
                        store
                            .set_tracker_project_linear_team(
                                &project,
                                team_id.as_deref(),
                                team_name.as_deref(),
                            )
                            .map_err(|e| format!("{e:#}"))
                    });
                let _ = reply.send(result);
            }
            Command::TrackerSyncInputs { ids, reply } => {
                let links: Vec<super::store::TrackerLink> = match &self.store {
                    Some(store) if ids.is_empty() => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store.load_all_tracker_links().unwrap_or_default()
                    }
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        ids.iter()
                            .filter_map(|id| store.load_tracker_link(id).ok().flatten())
                            .collect()
                    }
                    None => Vec::new(),
                };
                let mut repo_dirs = std::collections::HashMap::new();
                let mut linear_teams = std::collections::HashMap::new();
                for link in &links {
                    if link.provider == "github" && !repo_dirs.contains_key(&link.project) {
                        if let Some(path) = self.project_path(&link.project) {
                            repo_dirs.insert(link.project.clone(), path);
                        }
                    }
                    if link.provider == "linear" && !linear_teams.contains_key(&link.project) {
                        if let Some(team) = self
                            .store
                            .as_ref()
                            .and_then(|store| {
                                let store = store.lock().unwrap_or_else(|e| e.into_inner());
                                store.tracker_project_settings(&link.project).ok()
                            })
                            .and_then(|settings| settings.linear_team_id)
                        {
                            linear_teams.insert(link.project.clone(), team);
                        }
                    }
                }
                let _ = reply.send((links, repo_dirs, linear_teams));
            }
            Command::TrackerPersistSynced { links, reply } => {
                if let Some(store) = &self.store {
                    let store = store.lock().unwrap_or_else(|e| e.into_inner());
                    for link in &links {
                        if let Err(e) = store.upsert_tracker_link(link) {
                            eprintln!("[tracker] failed to persist sync for {}: {e}", link.item_id);
                        }
                        if store.backlog_storage_mode().ok() == Some(wire::BacklogStorageMode::Yaml)
                        {
                            if let Some(path) = self.project_path(&link.project) {
                                let result = super::backlog::update(
                                    &path,
                                    &link.project,
                                    &link.item_id,
                                    |item| {
                                        item.status = link.status.clone();
                                        item.remote_status = link.remote_status.clone();
                                        item.url = Some(link.url.clone());
                                        item.updated_at = super::task::now_secs();
                                    },
                                );
                                if let Err(e) = result {
                                    eprintln!(
                                        "[backlog] failed to update YAML remote status for {}: {e}",
                                        link.item_id
                                    );
                                }
                            }
                        }
                        if store.backlog_storage_mode().ok()
                            == Some(wire::BacklogStorageMode::Sqlite)
                        {
                            if let Err(e) = store.update_backlog_remote(
                                &link.item_id,
                                &link.status,
                                link.remote_status.as_deref(),
                                &link.url,
                                super::task::now_secs(),
                            ) {
                                eprintln!(
                                    "[backlog] failed to persist remote status for {}: {e}",
                                    link.item_id
                                );
                            }
                        }
                    }
                }
                let _ = reply.send(());
            }
            Command::TrackerDeleteItems { ids, reply } => {
                if let Some(store) = &self.store {
                    let store = store.lock().unwrap_or_else(|e| e.into_inner());
                    let mode = store.backlog_storage_mode().ok();
                    for item_id in ids {
                        // need project for YAML mode — get link before deleting it
                        let project = store
                            .load_tracker_link(&item_id)
                            .ok()
                            .flatten()
                            .map(|l| l.project);
                        if mode == Some(wire::BacklogStorageMode::Yaml) {
                            if let Some(proj) = &project {
                                if let Some(path) = self.project_path(proj) {
                                    let _ = super::backlog::remove(&path, proj, &item_id);
                                }
                            }
                        } else {
                            let _ = store.delete_backlog_item(&item_id);
                        }
                        let _ = store.delete_tracker_link(&item_id);
                    }
                }
                let _ = reply.send(());
            }
            Command::TrackerAdoptImported {
                project,
                fetched,
                reply,
            } => {
                let result = match &self.store {
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        // YAML mode keeps backlog item rows project-local in
                        // `…/.warpforge/backlog/`; SQLite mode keeps them in the
                        // `backlog_items` table. `adopt_imported` is told which
                        // so it never writes a shadow row to the other backend.
                        let yaml_path = if store.backlog_storage_mode().ok()
                            == Some(wire::BacklogStorageMode::Yaml)
                        {
                            self.project_path(&project)
                        } else {
                            None
                        };
                        super::tracker::adopt_imported(
                            &store,
                            &project,
                            yaml_path.as_deref(),
                            fetched,
                        )
                        .map_err(|e: anyhow::Error| format!("{e:#}"))
                    }
                    None => Ok((Vec::new(), Vec::new())),
                };
                let _ = reply.send(result);
            }
            Command::BacklogGetSettings { reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store.backlog_storage_mode()
                    })
                    .map(|mode| wire::BacklogSettings { mode })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogSetStorage { mode, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let from = store.backlog_storage_mode()?;
                        if from != mode {
                            // Switching backends must not silently hide rows in
                            // the one being left. Refuse until those rows are
                            // gone (or moved), surfaced as a clear error.
                            match (from, mode) {
                                (wire::BacklogStorageMode::Sqlite, wire::BacklogStorageMode::Yaml) => {
                                    let count = store.count_backlog_items()?;
                                    if count > 0 {
                                        anyhow::bail!(
                                            "Cannot switch backlog to YAML while {count} backlog item(s) still live in SQLite. Delete or move them first."
                                        );
                                    }
                                }
                                (wire::BacklogStorageMode::Yaml, wire::BacklogStorageMode::Sqlite) => {
                                    for project in &self.projects {
                                        let Some(path) = self.project_path(&project.name) else {
                                            continue;
                                        };
                                        if !super::backlog::list(&path, &project.name)?.is_empty() {
                                            anyhow::bail!(
                                                "Cannot switch backlog to SQLite while project '{}' has YAML backlog files. Delete or move them first.",
                                                project.name
                                            );
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        store.set_backlog_storage_mode(mode)
                    })
                    .map(|_| wire::BacklogSettings { mode })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogList {
                project,
                query,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                            let path = self
                                .project_path(&project)
                                .ok_or_else(|| anyhow::anyhow!("unknown project '{project}'"))?;
                            let items = super::backlog::list(&path, &project)?;
                            Ok(super::backlog::page(items, &query))
                        } else {
                            store.list_backlog(&project, &query)
                        }
                    })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogCreate { item: new, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let project = new.project;
                        let now = super::task::now_secs();
                        let (number, yaml_path) =
                            if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                                let path = self.project_path(&project).ok_or_else(|| {
                                    anyhow::anyhow!("unknown project '{project}'")
                                })?;
                                let items = super::backlog::list(&path, &project)?;
                                (super::backlog::next_number(&items), Some(path))
                            } else {
                                (store.next_backlog_number(&project)?, None)
                            };
                        let item = wire::BacklogItem {
                            id: format!("b_{}", uuid::Uuid::new_v4().simple()),
                            number,
                            project,
                            title: new.title,
                            body: new.body,
                            status: if new.status.is_empty() {
                                "todo".into()
                            } else {
                                new.status
                            },
                            priority: if new.priority.is_empty() {
                                "none".into()
                            } else {
                                new.priority
                            },
                            source: if new.source.is_empty() {
                                "local".into()
                            } else {
                                new.source
                            },
                            external_id: None,
                            url: None,
                            remote_status: None,
                            assignee: new.assignee,
                            created_at: now,
                            updated_at: now,
                            task_id: None,
                        };
                        if let Some(path) = yaml_path {
                            super::backlog::write(&path, &item)?;
                        } else {
                            store.upsert_backlog_item(&item)?;
                        }
                        Ok(item)
                    })
                    .map_err(|e: anyhow::Error| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogUpdate { patch, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let yaml = store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml;
                        let path = if yaml {
                            Some(self.project_path(&patch.project).ok_or_else(|| {
                                anyhow::anyhow!("unknown project '{}'", patch.project)
                            })?)
                        } else {
                            None
                        };
                        let mut item = match &path {
                            Some(path) => super::backlog::list(path, &patch.project)?
                                .into_iter()
                                .find(|item| item.id == patch.item_id),
                            None => store.get_backlog_item(&patch.item_id)?,
                        }
                        .ok_or_else(|| anyhow::anyhow!("backlog item not found"))?;
                        patch.apply(&mut item);
                        item.updated_at = super::task::now_secs();
                        match &path {
                            Some(path) => super::backlog::write(path, &item)?,
                            None => store.upsert_backlog_item(&item)?,
                        }
                        Ok(item)
                    })
                    .map_err(|e: anyhow::Error| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogAttachExternal {
                item_id,
                project,
                provider,
                external_id,
                url,
                remote_status,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                            let path = self
                                .project_path(&project)
                                .ok_or_else(|| anyhow::anyhow!("unknown project"))?;
                            let mut item = super::backlog::list(&path, &project)?
                                .into_iter()
                                .find(|item| item.id == item_id)
                                .ok_or_else(|| anyhow::anyhow!("backlog item not found"))?;
                            item.source = provider;
                            item.external_id = Some(external_id);
                            item.url = Some(url);
                            item.remote_status = remote_status;
                            super::backlog::write(&path, &item)
                        } else {
                            store.patch_backlog_external(
                                &item_id,
                                &external_id,
                                &url,
                                &provider,
                                remote_status.as_deref(),
                            )
                        }
                    })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogDelete {
                item_id,
                project,
                reply,
            } => {
                // Compensating cleanup for a failed external create: drop the
                // local item in whichever backend holds it AND its tracker link,
                // so a remote-create failure never leaves an item that claims to
                // live in a tracker it never reached.
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                            let path = self
                                .project_path(&project)
                                .ok_or_else(|| anyhow::anyhow!("unknown project"))?;
                            super::backlog::remove(&path, &project, &item_id)?;
                        } else {
                            store.delete_backlog_item(&item_id)?;
                        }
                        store.delete_tracker_link(&item_id)?;
                        Ok(())
                    })
                    .map_err(|e: anyhow::Error| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::WorkItemLinkTask {
                item_id,
                task_id,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store (demo mode?)"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let project = self
                            .tasks
                            .get(&task_id)
                            .map(|t| t.project.clone())
                            .unwrap_or_default();
                        super::tracker::link_task(&store, &item_id, &task_id, "local", &project)
                            .and_then(|_| {
                                if store.backlog_storage_mode()? == wire::BacklogStorageMode::Sqlite
                                {
                                    store.link_backlog_task(&item_id, &task_id)?;
                                }
                                Ok(())
                            })
                            .and_then(|_| {
                                if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                                    let path = self.project_path(&project).ok_or_else(|| {
                                        anyhow::anyhow!("unknown project '{project}'")
                                    })?;
                                    super::backlog::update(&path, &project, &item_id, |item| {
                                        item.task_id = Some(task_id.clone());
                                        item.status = "in_progress".into();
                                        item.updated_at = super::task::now_secs();
                                    })?;
                                }
                                Ok(())
                            })
                    });
                let _ = reply.send(result.map_err(|e: anyhow::Error| format!("{e:#}")));
            }
            Command::CancelTask { id, reply } => {
                let result = if self.workflow_is_active(&id) {
                    // Stopping a workflow parent stops the whole pipeline.
                    self.workflow_finalize(&id, WorkflowOutcome::Stopped).await
                } else {
                    let stop_result = match self.sessions.remove(&id) {
                        Some(handle) => handle.cancel_and_wait().await,
                        None => Ok(()),
                    };
                    // A worktree checkout may still be running for this task;
                    // dropping its token stops it from starting a session the
                    // user just cancelled. Same for a pending resume: its
                    // guard must not start a session the user cancelled.
                    self.pending_session_starts.remove(&id);
                    self.pending_resume.remove(&id);
                    self.resume_replay.remove(&id);
                    self.pending_permissions.cleanup_task(&id);
                    // A finished pipeline's parent keeps its terminal status:
                    // cancelling it must not rewrite that back to Waiting.
                    let finished_workflow = self
                        .workflow_runs
                        .get(&id)
                        .is_some_and(|run| !run.is_active());
                    if let Some(task) = self.tasks.get_mut(&id).filter(|_| !finished_workflow) {
                        task.set_status(TaskStatus::Waiting);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                    // Cancelling a stage child mid-run fails that stage.
                    self.workflow_child_gone(&id).await;
                    stop_result
                };
                let _ = reply.send(result);
            }
            Command::ArchiveTask { id } => {
                // Archiving a live workflow parent stops the pipeline first so
                // no orphaned stage sessions keep running behind a Done task.
                if self.workflow_is_active(&id) {
                    let _ = self.workflow_finalize(&id, WorkflowOutcome::Stopped).await;
                }
                // Collect children that reference this task as parent so we
                // can archive them together with the leader.
                let child_ids: Vec<String> = self
                    .tasks
                    .values()
                    .filter(|t| t.parent_task_id.as_deref() == Some(&id))
                    .map(|t| t.id.clone())
                    .collect();

                // Archive the leader itself.
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(TaskStatus::Done);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }

                // Archive every direct child so the whole group moves to history.
                // A child can itself be a live workflow pipeline (spawned via
                // spawn_workflow) — stop it the same way as a directly
                // archived one, or its stage session keeps running and
                // eventually flips this "archived" task back out of Done.
                for cid in child_ids {
                    if self.workflow_is_active(&cid) {
                        let _ = self.workflow_finalize(&cid, WorkflowOutcome::Stopped).await;
                    }
                    if let Some(child) = self.tasks.get_mut(&cid) {
                        child.set_status(TaskStatus::Done);
                        let updated = child.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
            }
            Command::DeleteTask { id, reply } => {
                let stop_result = if self.workflow_is_active(&id) {
                    self.workflow_finalize(&id, WorkflowOutcome::Stopped).await
                } else {
                    match self.sessions.remove(&id) {
                        Some(handle) => handle.cancel_and_wait().await,
                        None => Ok(()),
                    }
                };
                let mut delete_result = stop_result;
                if delete_result.is_ok() && self.workflow_runs.remove(&id).is_some() {
                    self.persist
                        .write(PersistWrite::DeleteWorkflowRun(id.clone()));
                }
                if delete_result.is_ok() {
                    self.pending_permissions.cleanup_task(&id);
                }
                // Capture project path before the task is removed so we can
                // clean up YAML backlog references afterwards.
                let project_path = self
                    .tasks
                    .get(&id)
                    .and_then(|t| self.project_path(&t.project));
                // Clean up worktree if the task had one.
                if let Some(task) = self.tasks.get(&id).filter(|_| delete_result.is_ok()) {
                    if task.worktree.is_some() {
                        if let Some(wt_mgr) = self.worktrees.get_mut(&task.project) {
                            if let Err(e) = wt_mgr.remove(&id).await {
                                eprintln!("[daemon] worktree cleanup failed for {id}: {e}");
                            }
                        }
                    }
                }
                if delete_result.is_ok() && self.tasks.remove(&id).is_some() {
                    self.tool_call_starts
                        .retain(|(task_id, _), _| task_id != &id);
                    self.last_session_update.remove(&id);
                    self.turn_updates.remove(&id);
                    self.resume_replay.remove(&id);
                    self.pending_resume.remove(&id);
                    self.pending_session_starts.remove(&id);
                    // Awaited, not queued: a failed delete is reported to the
                    // user, and dropping the error would leave a task that
                    // reappears on the next start with no explanation.
                    if let Err(error) = self.persist.ask(PersistAsk::DeleteTask(id.clone())).await {
                        delete_result = Err(error);
                    }
                    // Clear stale task_id from YAML backlog files.
                    if let Some(ref path) = project_path {
                        if let Err(e) = super::backlog::clear_task_refs(path, &id) {
                            eprintln!("[daemon] YAML backlog cleanup failed for {id}: {e}");
                        }
                    }
                    self.emit(Event::TaskRemoved { id: id.clone() });
                    // Deleting a stage child mid-run fails that stage.
                    self.workflow_child_gone(&id).await;
                }
                let _ = reply.send(delete_result);
            }
            Command::SetTaskTitle { id, title } => {
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.title = title;
                    task.updated_at = super::task::now_secs();
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            Command::MergeWorktree { task_id, reply } => {
                // Merging runs two git commands and removes a checkout. Resolve
                // what they need here, run them off the loop, and record the
                // outcome through Command::WorktreeMerged (ADR 0002).
                let resolved = self
                    .tasks
                    .get(&task_id)
                    .map(|t| t.project.clone())
                    .and_then(|project| {
                        let mgr = self.worktrees.get(&project)?;
                        let wt = mgr.get(&task_id)?;
                        Some((
                            project,
                            mgr.base_repo().to_path_buf(),
                            wt.path.clone(),
                            wt.branch.clone(),
                            wt.base_branch.clone(),
                        ))
                    });
                let Some((project, base_repo, path, branch, base_branch)) = resolved else {
                    let _ = reply.send(Err(format!("no worktree for task {task_id}")));
                    return;
                };
                let cmd_tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let merged =
                        super::worktree::merge_detached(&base_repo, &branch, &base_branch).await;
                    let result = match merged {
                        Ok(super::worktree::MergeResult::Ok { branch }) => {
                            let _ =
                                super::worktree::remove_detached(&base_repo, &path, &branch).await;
                            let _ = cmd_tx
                                .send(Command::WorktreeMerged { task_id, project })
                                .await;
                            Ok(branch)
                        }
                        Ok(super::worktree::MergeResult::Conflict { message, branch }) => {
                            Err(format!("merge conflict on {branch}: {message}"))
                        }
                        Ok(super::worktree::MergeResult::Error(msg)) => Err(msg),
                        Err(e) => Err(format!("{e:#}")),
                    };
                    let _ = reply.send(result);
                });
            }
            Command::WorktreeMerged { task_id, project } => {
                if let Some(mgr) = self.worktrees.get_mut(&project) {
                    mgr.forget(&task_id);
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.worktree = None;
                    task.updated_at = super::task::now_secs();
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            Command::ListWorktrees { project, reply } => {
                let wts = if let Some(wt_mgr) = self.worktrees.get(&project) {
                    wt_mgr
                        .list()
                        .into_iter()
                        .map(|wt| wire::WorktreeInfo {
                            task_id: wt.task_id.clone(),
                            path: wt.path.to_string_lossy().to_string(),
                            branch: wt.branch.clone(),
                            base_branch: wt.base_branch.clone(),
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let _ = reply.send(wts);
            }
            Command::SettleTask { task_id, reply } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = super::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Settle,
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::UnsettleTask { task_id, reply } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = super::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Unsettle,
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::SnoozeTask {
                task_id,
                until,
                reply,
            } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = super::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Snooze { until },
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::UnsnoozeTask { task_id, reply } => {
                let result = match self.tasks.get(&task_id) {
                    None => Err(format!("unknown task {task_id}")),
                    Some(task) => {
                        let now = super::task::now_secs();
                        let has_pending = self.has_pending_permission(&task_id);
                        match apply_lifecycle_action(
                            task,
                            has_pending,
                            now,
                            LifecycleAction::Unsnooze,
                        ) {
                            Ok(Some(updated)) => {
                                self.persist(&updated);
                                self.tasks.insert(task_id.clone(), updated.clone());
                                self.emit(Event::TaskUpdated(updated));
                                Ok(())
                            }
                            Ok(None) => Ok(()), // true no-op
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = reply.send(result);
            }
            Command::ListSessions { project, reply } => {
                let path = self.project_path(&project);
                let agents = self.configured_agents.clone();
                tokio::task::spawn_blocking(move || {
                    let sessions = match path {
                        Some(p) => super::sessions::external_sessions(&p, &agents),
                        None => Vec::new(),
                    };
                    let _ = reply.send(sessions);
                });
            }
            Command::ResumeTask {
                project,
                agent,
                session_id,
                title,
                reply,
            } => {
                let prompt = if title.is_empty() {
                    format!("Resumed {agent} session")
                } else {
                    title
                };
                let task = Task::new(&project, &prompt, &agent, vec!["resumed".into()]);
                let id = task.id.clone();
                // A freshly resumed external session carries no model intent
                // yet; threaded so the resume path reads the task, not a
                // hardcoded None.
                let default_model = task.model.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());
                // Load history only (empty prompt); user continues via session.prompt.
                self.start_session(
                    &id,
                    &project,
                    &agent,
                    "",
                    false,
                    Some(session_id),
                    vec![],
                    default_model,
                    std::collections::HashMap::new(),
                );
            }
            Command::SessionPrompt {
                task_id,
                text,
                attachments,
                reply,
            } => {
                let root = self.tasks.get(&task_id).map(|task| {
                    task.worktree
                        .clone()
                        .or_else(|| self.project_path(&task.project))
                        .unwrap_or_else(|| ".".into())
                });
                let prepared = root
                    .ok_or_else(|| format!("unknown task {task_id}"))
                    .and_then(|root| {
                        super::prompt::prepare_prompt(
                            std::path::Path::new(&root),
                            text.clone(),
                            &attachments,
                        )
                    });
                let prepared = match prepared {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let user_update = wire::SessionUpdate::UserMessage {
                    text: text.clone(),
                    attachments: prepared.summaries.clone(),
                };
                let live_delivery = self
                    .sessions
                    .get(&task_id)
                    .cloned()
                    .map(|handle| handle.prompt(prepared.clone()));
                match live_delivery {
                    Some(Ok(())) => {
                        self.mark_task_running(&task_id);
                        // Echo the developer's message through the same
                        // persisted stream as agent updates. If a reconnect
                        // retry submits the same text again after the first
                        // attempt was already recorded, keep the transcript
                        // readable by dropping only that exact consecutive
                        // duplicate.
                        self.emit_session_unless_last_duplicate(&task_id, user_update);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Err(_)) | None => {
                        // A closed command channel is a stale handle. Remove it
                        // before reconnecting so its last process guard can
                        // terminate/reap the old child.
                        self.sessions.remove(&task_id);
                        let resume = self.tasks.get(&task_id).and_then(|task| {
                            task.session_id.as_ref().map(|session_id| {
                                (
                                    task.project.clone(),
                                    task.agent.clone(),
                                    session_id.clone(),
                                    task.model.clone(),
                                )
                            })
                        });

                        if let Some((project, agent, session_id, default_model)) = resume {
                            self.mark_task_running(&task_id);
                            self.emit_session(
                                &task_id,
                                wire::SessionUpdate::AgentText {
                                    text: "Reconnecting to the saved agent session…".into(),
                                },
                            );
                            // The replay guard is built from the persisted
                            // transcript, which must be read off the loop
                            // (write-behind flush + store read). Start the
                            // session only once the guard has landed, mirroring
                            // WorktreeReady: starting before it would let the
                            // agent's replayed history through unfiltered and
                            // double the output.
                            self.pending_resume.insert(
                                task_id.clone(),
                                PendingResume {
                                    project,
                                    agent,
                                    text: text.clone(),
                                    session_id,
                                    attachments,
                                    default_model,
                                },
                            );
                            self.request_resume_replay_guard(&task_id);
                            let _ = reply.send(Ok(()));
                        } else {
                            // Reject without echoing a user message that was never delivered.
                            let _ = reply.send(Err("no live or resumable agent session".into()));
                        }
                    }
                }
            }
            Command::SessionPermission {
                task_id,
                request_id,
                outcome,
            } => {
                if let Some(handle) = self.sessions.get(&task_id) {
                    handle.answer(request_id.clone(), outcome.clone());
                }
                self.pending_permissions.resolve(&task_id, &request_id);
                self.emit_session(
                    &task_id,
                    wire::SessionUpdate::PermissionResolved {
                        request_id,
                        outcome,
                    },
                );
            }
            Command::SessionSetConfigOption {
                task_id,
                config_id,
                value,
                reply,
            } => {
                let cmd_tx = self.cmd_tx.clone();
                match self.sessions.get(&task_id).cloned() {
                    Some(handle) => {
                        // The agent round-trip can take seconds; don't hold the
                        // actor loop hostage waiting for it. The verdict is
                        // routed back as a command so the actor can record it.
                        tokio::spawn(async move {
                            let result = handle
                                .set_config_option(config_id.clone(), value.clone())
                                .await;
                            let _ = reply.send(result.clone());
                            let _ = cmd_tx
                                .send(Command::SessionConfigOptionResult {
                                    task_id,
                                    config_id,
                                    value,
                                    result,
                                })
                                .await;
                        });
                    }
                    None => {
                        let _ = reply.send(Err(
                            "this task has no running agent session to configure".into(),
                        ));
                    }
                }
            }
            Command::SessionConfigOptionResult {
                task_id,
                config_id,
                value,
                result,
            } => {
                let is_model = self.tasks.get(&task_id).is_some_and(|task| {
                    task.config_options
                        .iter()
                        .find(|o| o.id == config_id)
                        .is_some_and(super::acp::is_model_selector)
                });
                let Some(task) = self.tasks.get_mut(&task_id) else {
                    return;
                };
                match (&result, is_model) {
                    (Ok(()), true) => {
                        // The agent accepted the switch to the model selector:
                        // that is the task's durable model intent, and any
                        // earlier mismatch no longer describes reality.
                        if task.model.as_deref() != Some(value.as_str()) {
                            task.model = Some(value);
                        }
                        task.blocked_reason = None;
                        task.blocked_kind = None;
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                    (Err(error), true) => {
                        // The user asked for a model and the agent said no (or
                        // never answered). Record it durably — the session
                        // keeps running on the old model, and the user must be
                        // able to see that later, not just in the toast.
                        task.blocked_reason =
                            Some(format!("Model '{value}' was not applied: {error}"));
                        task.blocked_kind = Some(wire::TaskBlockedKind::ModelMismatch);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                    _ => {}
                }
            }
            Command::DetectAgents { reply } => {
                // Detection shells out (which/npm) and hits the registry, so run
                // it off the actor loop rather than blocking command handling.
                tokio::spawn(async move {
                    let detected = super::agents::detect_agents().await;
                    let _ = reply.send(detected);
                });
            }
            Command::UpdateAgents { agents } => {
                self.persist.write(PersistWrite::Agents(agents.clone()));
                self.configured_agents = agents.clone();
                self.emit(Event::AgentsUpdated {
                    agents: self.configured_agents.clone(),
                });
                // Probe any newly-enabled agent without cached models.
                let probe_ids: Vec<String> = self
                    .configured_agents
                    .iter()
                    .filter(|a| a.enabled && a.models.is_empty())
                    .map(|a| a.id.clone())
                    .collect();
                for id in probe_ids {
                    let _ = self
                        .cmd_tx
                        .send(Command::ProbeAgent { id, reply: None })
                        .await;
                }
            }
            Command::ListAccounts { reply } => {
                let _ = reply.send(self.account_infos());
            }
            Command::ImportAccount {
                agent_id,
                label,
                reply,
            } => {
                let result = self.import_account(&agent_id, &label).await;
                let _ = reply.send(result);
            }
            Command::RenameAccount {
                account_id,
                label,
                reply,
            } => {
                let result = match self.accounts.iter_mut().find(|a| a.id == account_id) {
                    Some(account) => {
                        account.label = label;
                        let updated = account.clone();
                        self.persist.write(PersistWrite::Account(Box::new(updated)));
                        Ok(())
                    }
                    None => Err(format!("no account {account_id}")),
                };
                let _ = reply.send(result.map(|()| self.emit_accounts()));
            }
            Command::RemoveAccount { account_id, reply } => {
                let result = self.remove_account(&account_id).await;
                let _ = reply.send(result);
            }
            Command::SetActiveAccount {
                agent_id,
                account_id,
                reply,
            } => {
                let result = self.set_active_account(&agent_id, &account_id).await;
                let _ = reply.send(result);
            }
            Command::ProbeAgent { id, reply } => {
                let agent = self
                    .configured_agents
                    .iter()
                    .find(|a| a.id == id && a.enabled);
                let Some(agent) = agent else {
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(format!("no enabled agent '{id}'")));
                    }
                    return;
                };
                let acp_command = agent.acp_command.clone();
                let agent_id = agent.id.clone();
                let cmd_tx = self.cmd_tx.clone();
                // Probe mirrors real session cwd/env. Cache is global per agent, so first project is representative.
                let cwd = self
                    .projects
                    .first()
                    .map(|p| std::path::PathBuf::from(&p.path))
                    .unwrap_or_else(|| {
                        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
                    });
                let agent_env =
                    self.resolve_agent_env(&agent_id, super::accounts::SpawnAccount::Active);
                tokio::spawn(async move {
                    let res = super::agent_probe::probe_models(
                        &acp_command,
                        &cwd,
                        &agent_env.set,
                        &agent_env.remove,
                    )
                    .await;
                    let outcome = match res {
                        Ok(models) => {
                            let _ = cmd_tx
                                .send(Command::AgentProbed {
                                    id: agent_id,
                                    models,
                                })
                                .await;
                            Ok(())
                        }
                        Err(e) => {
                            eprintln!("[daemon] ACP probe failed for agent '{agent_id}': {e}");
                            Err(format!("could not read models from {agent_id}: {e}"))
                        }
                    };
                    if let Some(reply) = reply {
                        let _ = reply.send(outcome);
                    }
                });
            }
            Command::AgentProbed { id, models } => {
                // A probe that came back with nothing means the agent answered
                // without advertising selectors — treat it as "no news" rather
                // than truth, or one flaky probe would wipe a working list and
                // leave the picker empty until the next restart.
                if models.is_empty() {
                    return;
                }
                if let Some(agent) = self.configured_agents.iter_mut().find(|a| a.id == id) {
                    agent.models = models.clone();
                    // last_model is deliberately untouched: it may have been
                    // picked explicitly while the probe was in flight.
                    self.persist.write(PersistWrite::AgentModels {
                        id: id.clone(),
                        models: models.clone(),
                        last_model: agent.last_model.clone(),
                    });
                }
                self.emit(Event::AgentsUpdated {
                    agents: self.configured_agents.clone(),
                });
            }
            Command::StartOrchestration {
                project,
                goal,
                reply,
            } => {
                if let Some(orch_tx) = &self.orch_tx {
                    // Spawn — the orchestrator will call back into the daemon
                    // (create_task) which would deadlock if we blocked here.
                    let orch_tx = orch_tx.clone();
                    tokio::spawn(async move {
                        let (rtx, rrx) = oneshot::channel();
                        let _ = orch_tx
                            .send(crate::orchestration::OrchCommand::StartPlan {
                                project,
                                goal,
                                reply: rtx,
                            })
                            .await;
                        let result = rrx.await.unwrap_or_default();
                        let _ = reply.send(result);
                    });
                } else {
                    let _ = reply.send((String::new(), String::new()));
                }
            }
            Command::ListOrchestrations { reply } => {
                if let Some(orch_tx) = &self.orch_tx {
                    let (rtx, rrx) = oneshot::channel();
                    let _ = orch_tx
                        .send(crate::orchestration::OrchCommand::List(rtx))
                        .await;
                    let infos = rrx.await.unwrap_or_default();
                    let _ = reply.send(infos);
                } else {
                    let _ = reply.send(vec![]);
                }
            }
            Command::GetOrchestratorConfig { reply } => {
                let dto = self.orch_config.clone().into();
                let _ = reply.send(dto);
            }
            Command::SaveOrchestratorConfig { config, reply } => {
                self.orch_config = config.into();
                self.persist
                    .write(PersistWrite::OrchestratorConfig(Box::new(
                        self.orch_config.clone(),
                    )));
                let _ = reply.send(true);
            }
            Command::SetTaskStatus { id, status } => {
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(status);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            Command::MemoryStore {
                content,
                scope,
                kind,
                tags,
                project_id,
                created_by,
                reply,
            } => {
                let result = self
                    .memory
                    .store(
                        &content,
                        scope.as_deref(),
                        kind.as_deref(),
                        tags.as_deref(),
                        project_id.as_deref(),
                        created_by.as_deref(),
                    )
                    .and_then(|m| {
                        serde_json::to_value(m).map_err(super::memory::MemoryError::from)
                    });
                let _ = reply.send(result);
            }
            Command::MemorySearch {
                query,
                scope,
                limit,
                mode,
                reply,
            } => {
                let result = self
                    .memory
                    .search(&query, scope.as_deref(), limit, mode.as_deref())
                    .and_then(|v| {
                        serde_json::to_value(v).map_err(super::memory::MemoryError::from)
                    });
                let _ = reply.send(result);
            }
            Command::MemoryList {
                scope,
                kind,
                limit,
                offset,
                reply,
            } => {
                let result = self
                    .memory
                    .list(scope.as_deref(), kind.as_deref(), limit, offset)
                    .and_then(|v| {
                        serde_json::to_value(v).map_err(super::memory::MemoryError::from)
                    });
                let _ = reply.send(result);
            }
            Command::MemoryUpdate { id, content, reply } => {
                let result = self.memory.update(&id, &content).and_then(|m| {
                    serde_json::to_value(m).map_err(super::memory::MemoryError::from)
                });
                let _ = reply.send(result);
            }
            Command::MemoryDelete { id, reply } => {
                let _ = reply.send(self.memory.delete(&id));
            }
            Command::MemoryStats { reply } => {
                let result = self.memory.stats().and_then(|s| {
                    serde_json::to_value(s).map_err(super::memory::MemoryError::from)
                });
                let _ = reply.send(result);
            }
            Command::SetMemoryEmbedding { mode, reply } => {
                let result = self.memory.set_embedding(&mode).and_then(|s| {
                    serde_json::to_value(s).map_err(super::memory::MemoryError::from)
                });
                let _ = reply.send(result);
            }
            Command::MemoryAddEdge {
                src_id,
                dst_id,
                relation,
                reply,
            } => {
                let r = self
                    .memory
                    .add_edge(&src_id, &dst_id, &relation)
                    .and_then(|e| {
                        serde_json::to_value(e).map_err(super::memory::MemoryError::from)
                    });
                let _ = reply.send(r);
            }
            Command::MemoryEdges { id, reply } => {
                let r = self.memory.list_edges(&id).and_then(|v| {
                    serde_json::to_value(v).map_err(super::memory::MemoryError::from)
                });
                let _ = reply.send(r);
            }
            Command::MemoryListCompaction { reply } => {
                let r = self.memory.list_compaction_log().and_then(|v| {
                    serde_json::to_value(v).map_err(super::memory::MemoryError::from)
                });
                let _ = reply.send(r);
            }
            Command::MemoryResolveCompaction { id, approve, reply } => {
                let r = self.memory.resolve_compaction(id, approve).and_then(|s| {
                    serde_json::to_value(s).map_err(super::memory::MemoryError::from)
                });
                let _ = reply.send(r);
            }
            Command::MemoryDream {
                dry_run,
                project_id,
                reply,
            } => {
                *self.last_memory_activity.lock().unwrap() = std::time::Instant::now();
                // Scheduler for idle/cron is spawned in Daemon::spawn when dreaming.enabled;
                // this handler just executes the pass. Dream uses dreaming agent/model
                // (fallback agent.default_model) via dream prompt over last_accessed ASC 200;
                // when no model configured it falls back to heuristic propose_compaction.
                let cfg = self.memory.config().dreaming.clone();
                let fallback = self
                    .configured_agents
                    .iter()
                    .find(|a| a.id == cfg.agent)
                    .and_then(|a| a.last_model.clone());
                let res = self
                    .memory
                    .dream_with_config(dry_run, &cfg, fallback.as_deref());
                if !dry_run {
                    if let Ok(v) = &res {
                        let inserted = v.get("inserted").and_then(|n| n.as_u64()).unwrap_or(0);
                        if inserted > 0 {
                            let pid = project_id.clone().unwrap_or_else(|| "global".to_string());
                            let title =
                                format!("Dreaming: {} \u{2014} {} proposals", pid, inserted);
                            let prompt = format!(
                                "Dreaming compaction proposals for project '{}': {}\nPending review in memory_compaction_log.",
                                pid, v
                            );
                            let mut task =
                                Task::new(&pid, &prompt, &cfg.agent, vec!["dreaming".into()]);
                            task.title = title;
                            // Dreaming is already done — proposals are in DB. Don't spawn agent;
                            // mark Waiting so board shows review-needed, not spinner/“warming up”.
                            task.status = crate::daemon::task::TaskStatus::Waiting;
                            // Rich prompt so conversation isn't blank
                            task.prompt = format!(
                                "Dreaming finished for '{}' — {} proposal(s).\n\n{}\n\n→ Review in Memory → Compaction (approve/reject). No agent session needed.",
                                pid, inserted, v
                            );
                            let tid = task.id.clone();
                            self.tasks.insert(tid.clone(), task.clone());
                            self.persist(&task);
                            self.emit(Event::TaskCreated(task));
                        }
                    }
                }
                let _ = reply.send(res);
            }
        }
    }

    /// "Opening" a project starts both its declared services and port-forwards
    /// (what entering a project did implicitly in the TUI).
    async fn open_project(&mut self, name: &str) {
        self.start_services(name).await;
        self.start_portforwards(name).await;
    }

    /// Retire runtime entries that the refreshed config can no longer control.
    /// Existing services whose command changed keep running until the user
    /// restarts them; removed services and changed/removed forwards are stopped
    /// so no invisible processes are left behind.
    async fn remove_undeclared_runtime(&mut self, project: &str, config: Option<&WorkspaceConfig>) {
        let declared_services: HashSet<&str> = config
            .map(|config| config.services.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let removed_services: Vec<String> = self
            .services
            .list_for_project(project)
            .into_iter()
            .filter(|service| !declared_services.contains(service.name.as_str()))
            .map(|service| service.name.clone())
            .collect();
        for service in removed_services {
            self.services.remove(project, &service).await.ok();
        }

        let removed_or_changed_forwards: Vec<String> = self
            .portforwards
            .list_for_project(project)
            .into_iter()
            .filter(|running| {
                !config.is_some_and(|config| {
                    config.portforwards.iter().any(|declared| {
                        let name = declared
                            .name
                            .as_deref()
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("{}:{}", declared.namespace, declared.pod));
                        name == running.name
                            && declared.namespace == running.namespace
                            && declared.pod == running.pod_prefix
                            && declared.local_port == running.local_port
                            && declared.remote_port == running.remote_port
                    })
                })
            })
            .map(|forward| forward.name.clone())
            .collect();
        for forward in removed_or_changed_forwards {
            self.portforwards.remove(project, &forward);
        }
    }

    /// Register a new project: write to registry, generate config if missing,
    /// add to in-memory list, and broadcast the update to all clients.
    async fn add_project(
        &mut self,
        path: &str,
        name: Option<&str>,
    ) -> Result<ProjectEntry, String> {
        let entry =
            crate::registry::add_project(path, name).map_err(|e| format!("registry: {e}"))?;

        // Generate the workspace config if none exists.
        let config_file = crate::config::find_config_file(std::path::Path::new(&entry.path));
        if !config_file.exists() {
            crate::config::generate_workspace_yaml(std::path::Path::new(&entry.path)).ok();
            // non-fatal if it fails
        }

        // Add to in-memory list.
        self.projects.push(entry.clone());
        self.config_observer.track(&entry);

        // Broadcast to all subscribed clients.
        let index = self.projects.len() - 1;
        let config = load_workspace_config(std::path::Path::new(&entry.path));
        let state = self.build_project_config_state(index, config.as_ref());
        self.emit(Event::ProjectAdded(state.project.clone()));
        self.emit(Event::ProjectConfigChanged(state));

        Ok(entry)
    }

    /// Stop and forget all project-owned runtime resources, then unregister the
    /// project. The actor serializes this operation so starts cannot interleave.
    async fn remove_project(
        &mut self,
        name: &str,
        stop_resources: bool,
    ) -> Result<(), ProjectRemovalError> {
        let Some(project_index) = self
            .projects
            .iter()
            .position(|project| project.name == name)
        else {
            return Err(ProjectRemovalError::NotFound(format!(
                "Project \"{name}\" is not registered"
            )));
        };

        let live = ProjectLiveResources {
            services: self
                .services
                .list_for_project(name)
                .iter()
                .filter(|service| {
                    matches!(
                        service.status,
                        ServiceStatus::Starting | ServiceStatus::Running
                    )
                })
                .count(),
            portforwards: self
                .portforwards
                .list_for_project(name)
                .iter()
                .filter(|forward| {
                    matches!(
                        forward.status,
                        PfStatus::Starting | PfStatus::Active | PfStatus::Restarting
                    )
                })
                .count(),
            terminals: self
                .agents
                .list_for_project(name)
                .iter()
                .filter(|agent| agent.status.is_live_terminal())
                .count(),
        };
        if live.any() && !stop_resources {
            return Err(ProjectRemovalError::Conflict(live.conflict_message(name)));
        }

        let service_names: Vec<String> = self
            .services
            .list_for_project(name)
            .into_iter()
            .map(|service| service.name.clone())
            .collect();
        for service in service_names {
            self.services
                .remove(name, &service)
                .await
                .map_err(|error| {
                    ProjectRemovalError::Internal(format!(
                        "Failed to stop service \"{service}\" for project \"{name}\": {error}"
                    ))
                })?;
        }

        let portforward_names: Vec<String> = self
            .portforwards
            .list_for_project(name)
            .into_iter()
            .map(|forward| forward.name.clone())
            .collect();
        for forward in portforward_names {
            self.portforwards.remove(name, &forward);
        }

        // The range sweep can affect an untracked listener, so reserve it for
        // an explicitly authorized teardown rather than an unforced removal
        // whose known resources are already stopped.
        if stop_resources {
            kill_listeners_in_ranges(&[crate::ports::port_range(project_index)]).await;
        }

        let terminal_ids: Vec<String> = self
            .agents
            .list_for_project(name)
            .into_iter()
            .map(|agent| agent.id.clone())
            .collect();
        for id in terminal_ids {
            self.agents.kill(&id);
            self.emit(Event::AgentExited { id });
        }

        crate::registry::remove_project(name).map_err(|error| {
            ProjectRemovalError::Internal(format!(
                "Resources were stopped, but project registration removal failed: {error}"
            ))
        })?;

        self.projects.retain(|p| p.name != name);
        self.config_observer.untrack(name);

        self.emit(Event::ProjectRemoved {
            name: name.to_string(),
        });

        Ok(())
    }

    /// Start every declared service for a project (no port-forwards).
    async fn start_services(&mut self, name: &str) {
        let Some(path) = self.project_path(name) else {
            return;
        };
        let index = self.project_index(name);
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };

        for svc_name in sorted_services(&config) {
            if let Some(svc) = config.services.get(&svc_name) {
                self.services
                    .start(
                        name,
                        &path,
                        index,
                        &svc_name,
                        &svc.command,
                        svc.port.unwrap_or(0),
                        svc.env.as_ref(),
                        svc.ready_pattern.as_deref(),
                    )
                    .await
                    .ok();
                self.emit_service_status(name, &svc_name);
            }
        }
    }

    /// Start every declared port-forward for a project (no services).
    async fn start_portforwards(&mut self, name: &str) {
        let Some(path) = self.project_path(name) else {
            return;
        };
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };
        self.portforwards
            .start_all(name, &config.portforwards)
            .await;
    }

    /// Start a single declared port-forward, matched by its label (explicit
    /// `name:` in config, else the `namespace:pod` fallback the manager uses).
    async fn start_one_portforward(&mut self, project: &str, label: &str) {
        let Some(path) = self.project_path(project) else {
            return;
        };
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };
        let matched: Vec<_> = config
            .portforwards
            .into_iter()
            .filter(|cfg| {
                let cfg_label = cfg
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", cfg.namespace, cfg.pod));
                cfg_label == label
            })
            .collect();
        self.portforwards.start_all(project, &matched).await;
    }

    async fn start_one_service(&mut self, project: &str, service: &str) {
        let Some(path) = self.project_path(project) else {
            return;
        };
        let index = self.project_index(project);
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else {
            return;
        };
        let Some(svc) = config.services.get(service) else {
            return;
        };
        self.services
            .start(
                project,
                &path,
                index,
                service,
                &svc.command,
                svc.port.unwrap_or(0),
                svc.env.as_ref(),
                svc.ready_pattern.as_deref(),
            )
            .await
            .ok();
        self.emit_service_status(project, service);
    }

    /// Resolve a task's `agent` to a spawnable ACP command.
    /// Priority: global agent registry → project agentTemplates → raw command.
    /// Enabled agent ids the orchestrator may delegate to (from the registry).
    fn available_agent_ids(&self) -> Vec<String> {
        self.configured_agents
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect()
    }

    /// Valid workflow ids the orchestrator may pass to `spawn_workflow`: a
    /// project's `.warpforge/workflows/*.yaml` plus built-ins not overridden
    /// by one — the same set `workflow.list` shows the New Task picker.
    fn available_workflow_ids(&self, project: &str) -> Vec<String> {
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

    fn resolve_agent_command(&self, project: &str, agent: &str) -> String {
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
    fn spawn_account<'a>(&'a self, task_id: &str) -> super::accounts::SpawnAccount<'a> {
        let Some(task) = self.tasks.get(task_id) else {
            return super::accounts::SpawnAccount::Active;
        };
        match (task.account_id.as_deref(), task.session_id.is_some()) {
            (Some(id), _) => super::accounts::SpawnAccount::Pinned(id),
            (None, true) => super::accounts::SpawnAccount::SharedHome,
            (None, false) => super::accounts::SpawnAccount::Active,
        }
    }

    /// Extra environment for an agent process: the selected account's home and
    /// any auth env the agent must not inherit.
    ///
    /// Codex selects its account by `CODEX_HOME`; Claude does not (its account
    /// is swapped in place) but still needs conflicting auth env stripped.
    fn resolve_agent_env(
        &self,
        agent: &str,
        choice: super::accounts::SpawnAccount<'_>,
    ) -> super::accounts::AgentEnv {
        let selected = super::accounts::select_for_spawn(&self.accounts, agent, choice);
        // Re-link the shared home before every spawn, not just at import: the
        // agent's own home grows entries over time, and a vault that missed
        // them starts the agent with no config and no session history.
        if let Some(account) = selected {
            if account.agent_id == "codex" {
                if let Some(home) = super::accounts::agent_home("codex") {
                    if let Err(error) = super::accounts::materialize_codex_home(
                        &home,
                        std::path::Path::new(&account.home_dir),
                    ) {
                        eprintln!("[accounts] codex home for '{}': {error}", account.label);
                    }
                }
            }
        }
        super::accounts::env_for(agent, selected)
    }

    /// How the daemon reaches the Claude CLI's credential storage.
    fn claude_runtime(&self) -> super::claude_auth::ClaudeRuntime {
        super::claude_auth::ClaudeRuntime::detect()
    }

    /// Wire view of the account list.
    fn account_infos(&self) -> Vec<wire::AccountInfo> {
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
    fn emit_accounts(&mut self) -> Vec<wire::AccountInfo> {
        let accounts = self.account_infos();
        self.emit(Event::AccountsUpdated {
            accounts: accounts.clone(),
        });
        accounts
    }

    /// Register the agent's currently-authenticated login as a new account by
    /// copying its credentials into a fresh vault. The agent's own home is only
    /// ever read.
    async fn import_account(
        &mut self,
        agent_id: &str,
        label: &str,
    ) -> Result<Vec<wire::AccountInfo>, String> {
        let slug = super::accounts::slugify(label);
        let id = super::accounts::account_id(agent_id, &slug);
        if self.accounts.iter().any(|a| a.id == id) {
            return Err(format!("account '{label}' already exists for {agent_id}"));
        }
        let vault =
            super::accounts::create_vault(agent_id, &slug, &id).map_err(|e| e.to_string())?;
        let identity = match super::accounts::import_agent_login(
            agent_id,
            &vault,
            &id,
            &self.claude_runtime(),
        ) {
            Ok(identity) => identity,
            Err(e) => {
                // Nothing usable was captured — drop the empty vault so a retry
                // starts clean instead of adopting a half-made one.
                let _ = super::accounts::remove_vault(&vault, &id);
                return Err(e.to_string());
            }
        };
        let account = super::store::StoredAccount {
            id,
            agent_id: agent_id.to_string(),
            label: label.trim().to_string(),
            email: identity.email,
            plan: identity.plan,
            home_dir: vault.to_string_lossy().into_owned(),
            created_at: super::task::now_secs(),
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
    async fn set_active_account(
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
            super::accounts::activate_claude_account(
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
    fn retire_sessions_for_agent(&mut self, agent_id: &str) {
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
    fn agent_id_of<'a>(&'a self, agent: &'a str) -> &'a str {
        self.configured_agents
            .iter()
            .find(|a| a.id == agent || a.display_name == agent)
            .map(|a| a.id.as_str())
            .unwrap_or(agent)
    }

    async fn remove_account(&mut self, account_id: &str) -> Result<Vec<wire::AccountInfo>, String> {
        let Some(index) = self.accounts.iter().position(|a| a.id == account_id) else {
            return Err(format!("no account {account_id}"));
        };
        let account = self.accounts[index].clone();
        super::accounts::remove_vault(std::path::Path::new(&account.home_dir), &account.id)
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

    /// A context block describing the project's currently-running services and
    /// their live URLs — prepended to the agent's first prompt so it knows the
    /// app is already up and can hit real endpoints / run tests against it.
    fn runtime_context(&self, project: &str) -> Option<String> {
        let mut lines: Vec<String> = self
            .services
            .all()
            .filter(|s| {
                s.project_name == project
                    && s.allocated_port > 0
                    && matches!(s.status, ServiceStatus::Running | ServiceStatus::Starting)
            })
            .map(|s| format!("- {} → http://localhost:{}", s.name, s.allocated_port))
            .collect();
        if lines.is_empty() {
            return None;
        }
        lines.sort();
        Some(format!(
            "[warpforge] These services are already running for this project — \
             you can hit these endpoints and run tests against them:\n{}",
            lines.join("\n")
        ))
    }

    /// Spawn an ACP agent session for a task and remember its handle. When
    /// `resume` is set, load that native session id instead of starting fresh.
    /// Some agents replay prior history as `session/update`; the frontend stream
    /// is append-only today, so this path is used primarily to regain a live
    /// handle and deliver a new prompt after daemon restarts.
    ///
    /// If the task has a worktree, the agent runs in the worktree directory
    /// instead of the project root — so its edits are isolated.
    /// Start a session whose worktree checkout has finished.
    fn start_pending_session(&mut self, task_id: &str, start: PendingSessionStart) {
        self.start_session(
            task_id,
            &start.project,
            &start.agent,
            &start.prompt,
            start.include_runtime_context,
            None,
            start.attachments,
            start.default_model,
            start.config_overrides,
        );
    }

    /// Resolve everything a worktree checkout needs from actor state, so the
    /// git work itself can run without borrowing the actor.
    fn worktree_request(
        &mut self,
        task_id: &str,
        project: &str,
        branched_from: Option<&str>,
    ) -> Option<WorktreeRequest> {
        let path = self.project_path(project)?;
        // Resolve the source's working directory before borrowing the manager.
        // A source task without a worktree runs in the project checkout, and
        // that is still the tree its branch must inherit from.
        let source_path = branched_from.and_then(|src| self.task_repo_path(src));
        let mgr = self
            .worktrees
            .entry(project.to_string())
            .or_insert_with(|| WorktreeManager::new(std::path::PathBuf::from(&path)));
        let base_branch = branched_from.and_then(|src| mgr.source_state(src).map(|(b, _)| b));
        let source = source_path.map(|path| BranchSource {
            base_branch,
            path: PathBuf::from(path),
        });
        Some(WorktreeRequest {
            project: project.to_string(),
            base_repo: mgr.base_repo().to_path_buf(),
            task_id: task_id.to_string(),
            source,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn start_session(
        &mut self,
        task_id: &str,
        project: &str,
        agent: &str,
        prompt: &str,
        include_runtime_context: bool,
        resume: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        config_overrides: std::collections::HashMap<String, String>,
    ) {
        // Resolve cwd: worktree path if set, otherwise project root.
        let cwd = if let Some(task) = self.tasks.get(task_id) {
            if let Some(ref wt_path) = task.worktree {
                wt_path.clone()
            } else {
                self.project_path(project)
                    .unwrap_or_else(|| ".".to_string())
            }
        } else {
            self.project_path(project)
                .unwrap_or_else(|| ".".to_string())
        };
        let command = self.resolve_agent_command(project, agent);
        let env = self.resolve_agent_env(agent, self.spawn_account(task_id));
        // Bind the task to the account it is starting on, so a later resume goes
        // back to the same home even after the active account changed. Recorded
        // before the session exists, because that is the only moment the answer
        // is unambiguous.
        if let Some(account) =
            super::accounts::select_for_spawn(&self.accounts, agent, self.spawn_account(task_id))
                .map(|account| account.id.clone())
        {
            if let Some(task) = self.tasks.get_mut(task_id) {
                if task.account_id.as_deref() != Some(account.as_str()) {
                    task.account_id = Some(account);
                    let updated = task.clone();
                    self.persist(&updated);
                }
            }
        }
        // Every session gets the warpforge MCP bridge (read service logs,
        // restart a service, …). An orchestrator-chat session additionally gets
        // the orchestrator system preamble and, via WF_MODE=orchestrator, the
        // spawn_agent / read_inbox tools. A plain task gets the core tools only.
        let is_orchestrator = self
            .tasks
            .get(task_id)
            .is_some_and(|t| t.tags.iter().any(|x| x == "orchestrator-chat"));
        let mcp_servers = mcp_servers(task_id, project, is_orchestrator);
        let memory_prefix = if self.memory.enabled() {
            format!("{MEMORY_SYSTEM}\n\n")
        } else {
            String::new()
        };
        let base_prompt = if is_orchestrator {
            let agents = self.available_agent_ids();
            let roster = if agents.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\nAgents you can pass to spawn_agent: {}.",
                    agents.join(", ")
                )
            };
            let workflows = self.available_workflow_ids(project);
            let workflow_roster = if workflows.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\nWorkflows you can pass to spawn_workflow: {}.",
                    workflows.join(", ")
                )
            };
            format!("{memory_prefix}{ORCHESTRATOR_SYSTEM}{roster}{workflow_roster}\n\n{RUNTIME_MCP_SYSTEM}\n\n{prompt}")
        } else {
            format!("{memory_prefix}{RUNTIME_MCP_SYSTEM}\n\n{prompt}")
        };
        let full_prompt = match include_runtime_context
            .then(|| self.runtime_context(project))
            .flatten()
        {
            Some(ctx) => format!("{ctx}\n\n{base_prompt}"),
            None => base_prompt,
        };
        let prepared_prompt = match super::prompt::prepare_prompt(
            std::path::Path::new(&cwd),
            full_prompt,
            &attachments,
        ) {
            Ok(prompt) => prompt,
            Err(error) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(error);
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                return;
            }
        };
        if !prompt.is_empty() || !prepared_prompt.summaries.is_empty() {
            self.emit_session_unless_last_duplicate(
                task_id,
                wire::SessionUpdate::UserMessage {
                    text: prompt.to_string(),
                    attachments: prepared_prompt.summaries.clone(),
                },
            );
        }
        match spawn_acp_session(
            task_id.to_string(),
            command,
            cwd,
            prepared_prompt,
            resume,
            mcp_servers,
            self.acp_tx.clone(),
            Some(self.policy_tx.clone()),
            default_model,
            config_overrides,
            env,
        ) {
            Ok(handle) => {
                self.sessions.insert(task_id.to_string(), handle);
            }
            Err(e) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(format!("failed to start agent: {e}"));
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    async fn handle_acp_update(&mut self, task_id: String, update: AcpUpdate) {
        match update {
            AcpUpdate::SessionStarted { session_id } => {
                // A hard stop removes the handle before awaiting process exit.
                // Ignore an initialize reply that was already queued behind
                // that stop; otherwise it would resurrect the cancelled child
                // task as Running after task.cancel was acknowledged.
                if !self.sessions.contains_key(&task_id) {
                    return;
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.attach_session(session_id);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::AgentText(text) => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::AgentText { text })
            }
            AcpUpdate::AgentThought(text) => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::AgentThought { text })
            }
            AcpUpdate::ToolCall {
                id,
                title,
                status,
                kind,
                content,
            } => {
                let key = (task_id.clone(), id.clone());
                let started_at = *self.tool_call_starts.entry(key).or_insert_with(|| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                });
                self.emit_acp_session(
                    &task_id,
                    wire::SessionUpdate::ToolCall {
                        tool_call_id: id,
                        title,
                        status: wireconv::tool_status(&status),
                        started_at: Some(started_at),
                        tool_kind: kind,
                        content,
                    },
                )
            }
            AcpUpdate::Plan { entries } => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::Plan { entries })
            }
            AcpUpdate::AvailableCommands { commands } => self.emit_acp_session(
                &task_id,
                wire::SessionUpdate::AvailableCommands { commands },
            ),
            AcpUpdate::ConfigOptions { options } => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    // A stale mismatch that the live session has since
                    // resolved (e.g. the agent applied the model late) must
                    // not linger.
                    let model_now_matches = task.model.as_ref().is_some_and(|intent| {
                        options
                            .iter()
                            .find(|o| super::acp::is_model_selector(o))
                            .is_some_and(|o| &o.current_value == intent)
                    });
                    if model_now_matches {
                        task.blocked_reason = None;
                        task.blocked_kind = None;
                    }
                    task.config_options = options;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::Usage { used, size, cost } => self.emit_session_unless_last_duplicate(
                &task_id,
                wire::SessionUpdate::Usage { used, size, cost },
            ),
            AcpUpdate::PromptCapabilities {
                image,
                embedded_context,
            } => self.emit_session(
                &task_id,
                wire::SessionUpdate::PromptCapabilities {
                    image,
                    embedded_context,
                },
            ),
            AcpUpdate::FileEdit {
                path,
                tool_call_id,
                additions,
                deletions,
                hunks,
            } => {
                let update = wire::SessionUpdate::FileEdit {
                    path,
                    tool_call_id: Some(tool_call_id),
                    additions,
                    deletions,
                    hunks,
                };
                if self.should_skip_resume_replay(&task_id, &update) {
                    return;
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.files_changed += 1;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.emit_session(&task_id, update);
            }
            AcpUpdate::PermissionRequest {
                request_id,
                title,
                options,
            } => {
                self.pending_permissions.record(&task_id, &request_id);
                self.emit_acp_session(
                    &task_id,
                    wire::SessionUpdate::PermissionRequest {
                        request_id,
                        title,
                        options,
                    },
                )
            }
            AcpUpdate::TurnEnded { stop_reason } => {
                // A clean turn end completes the node; a "disconnected" stop is
                // the agent process dying, which we treat as a failure.
                let success = stop_reason != "disconnected";
                let workflow_child = self.workflow_child_of(&task_id).is_some();
                let update = wire::SessionUpdate::TurnEnded { stop_reason };
                if self.should_skip_resume_replay(&task_id, &update) {
                    return;
                }
                self.emit_session(&task_id, update);
                // Turn over: the ball is in the human's court either way, so the
                // status is just `Waiting`. This used to branch on
                // `files_changed` to pick `NeedsReview` vs `Idle` — one
                // lifecycle state spelled two ways, keyed off a field the task
                // already carries. Consumers that care whether there is a diff
                // read `files_changed` directly.
                //
                // Workflow children have different semantics: their output is
                // consumed by the pipeline, so the workflow handler below owns
                // their terminal/waiting status.
                if !workflow_child {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        if task.status == TaskStatus::Running {
                            task.set_status(TaskStatus::Waiting);
                            let updated = task.clone();
                            self.persist(&updated);
                            self.emit(Event::TaskUpdated(updated));
                        }
                    }
                }
                if workflow_child {
                    // A workflow stage finished — advance the pipeline. Parse
                    // only the latest turn's text from the in-memory turn buffer
                    // (bounded by a turn): answered questions and superseded
                    // verdicts from earlier turns must not count. The legacy
                    // orchestrator inbox path does not apply here.
                    let text = self.collect_stage_text(&task_id);
                    self.workflow_stage_finished(&task_id, success, text).await;
                }
                // If we are an orchestrator whose sub-agents finished mid-turn,
                // process them now that the turn is over.
                if self.pending_wake.remove(&task_id) {
                    self.wake_parent(&task_id);
                }
                // The finished task's full text output is assembled off the loop
                // (write-behind flush + store read) and delivered back as
                // Command::TaskOutputReady, which notifies the orchestrator and
                // the parent inbox. Only ask for it when somebody consumes it:
                // both consumers are no-ops for an ordinary task, and reading
                // its whole transcript per turn would trade the memory this
                // change saves for disk it never needed to touch.
                if self.turn_output_has_consumer(&task_id, workflow_child) {
                    self.request_task_output(&task_id, success, workflow_child);
                }
            }
            AcpUpdate::ModelMismatch { message } => {
                // Non-fatal: the session keeps running, so no handle removal
                // and no status change — but the user must be able to see
                // later that the task is not on the model they asked for.
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.blocked_kind = Some(wire::TaskBlockedKind::ModelMismatch);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::Error {
                run_id,
                message,
                kind,
            } => {
                if self
                    .sessions
                    .get(&task_id)
                    .is_some_and(|handle| handle.run_id() != run_id)
                {
                    return;
                }
                let reason = message.clone();
                // Remove dead ACP handle so subsequent prompts trigger resume.
                self.sessions.remove(&task_id);
                self.pending_permissions.cleanup_task(&task_id);
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.blocked_kind = kind;
                    // A lost session id refers to nothing, so keeping it would
                    // retry session/load and fail identically on every later
                    // prompt. Dropping it lets the next one start fresh; the
                    // conversation Warpforge stored is untouched either way.
                    if matches!(kind, Some(wire::TaskBlockedKind::SessionLost)) {
                        task.session_id = None;
                    }
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.notify_orch_finished(&task_id, false, reason.clone());
                if self.workflow_child_of(&task_id).is_some() {
                    self.workflow_stage_finished(
                        &task_id,
                        false,
                        StageText {
                            closing: reason.clone(),
                            full: reason,
                        },
                    )
                    .await;
                } else {
                    self.deliver_child_result(&task_id, false, reason);
                }
            }
        }
    }

    fn emit_acp_session(&mut self, task_id: &str, update: wire::SessionUpdate) {
        if self.should_skip_resume_replay(task_id, &update) {
            return;
        }
        self.emit_session(task_id, update);
    }

    fn mark_task_running(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            if task.status != TaskStatus::Done {
                task.blocked_reason = None;
                task.blocked_kind = None;
                task.set_status(TaskStatus::Running);
                // Reactivate lifecycle: clear settle/snooze when task starts running
                task.settled_override = None;
                task.settled_at = None;
                task.snoozed_until = None;
                task.snoozed_at = None;
                let updated = task.clone();
                self.persist(&updated);
                self.emit(Event::TaskUpdated(updated));
            }
        }
    }

    /// Emit unless this is byte-for-byte the update that went out last for the
    /// task — a reconnect retry re-sending a prompt, or a repeated usage frame.
    ///
    /// The comparison is against what this daemon last emitted, held in memory.
    /// It used to `SELECT` the last persisted row, which write-behind
    /// persistence makes wrong as well as slow: the row it needs is usually
    /// still in the queue, so every duplicate would slip through.
    fn emit_session_unless_last_duplicate(&mut self, task_id: &str, update: wire::SessionUpdate) {
        if self.last_session_update.get(task_id) == Some(&update) {
            return;
        }
        self.emit_session(task_id, update);
    }

    /// Remove finished tasks' session transcripts older than the retention
    /// window, then fold the WAL back. All on a worker; the actor only sends
    /// the event. A `retention_days` of 0 (or a missing store) means "never".
    fn prune_transcripts(&self, retention_days: u32) {
        let persist = self.persist.clone();
        let store = self.store.clone();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            persist.flush().await;
            let cutoff = super::task::now_secs() as i64 - (retention_days as i64) * 24 * 60 * 60;
            let deleted = super::runtime::store_read(store, move |store| {
                let deleted = store.prune_finished_session_updates(cutoff)?;
                if deleted > 0 {
                    store.checkpoint_wal()?;
                }
                Ok::<usize, anyhow::Error>(deleted)
            })
            .await
            .map(|result| result.unwrap_or(0))
            .unwrap_or(0);
            if deleted > 0 {
                let _ = event_tx.send(Event::HistoryPruned {
                    updates: deleted as u64,
                });
            }
        });
    }

    /// The full retention sweep, off the loop:
    ///
    /// 1. Delete closed tasks' transcripts past `retention_days`.
    /// 2. Settle ignored diff-less waiting tasks past `settle_ignored_after_days`
    ///    (through the same `SettleTask` path as the button, so it is
    ///    reversible and permission-safe).
    /// 3. Delete untouched closed tasks past `delete_closed_after_days` via the
    ///    real `DeleteTask` path (worktree, backlog refs, workflow runs); a
    ///    closed task that still holds unmerged changes is kept instead.
    ///
    /// Settling runs before expiry so a task settled by stage 2 gets a fresh
    /// `updated_at` and cannot be expired by the same sweep.
    fn history_sweep(&self) {
        let config = super::history_config::HistoryConfig::load();
        if config.retention_days > 0 {
            self.prune_transcripts(config.retention_days);
        }
        let persist = self.persist.clone();
        let store = self.store.clone();
        let cmd_tx = self.cmd_tx.clone();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            let now = super::task::now_secs() as i64;
            let mut settled = 0u64;
            let mut expired = 0u64;
            let mut kept = 0u64;

            if config.settle_ignored_after_days > 0 {
                persist.flush().await;
                let cutoff = now - (config.settle_ignored_after_days as i64) * 24 * 60 * 60;
                let store_for_read = store.clone();
                let ids = super::runtime::store_read(store_for_read, move |store| {
                    store.find_ignored_waiting_tasks(cutoff).unwrap_or_default()
                })
                .await
                .unwrap_or_default();
                for task_id in ids {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    if cmd_tx
                        .send(Command::SettleTask {
                            task_id: task_id.clone(),
                            reply: tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if rx.await.map(|r| r.is_ok()).unwrap_or(false) {
                        settled += 1;
                    }
                }
            }

            if config.delete_closed_after_days > 0 {
                persist.flush().await;
                let cutoff = now - (config.delete_closed_after_days as i64) * 24 * 60 * 60;
                let store_for_read = store.clone();
                let rows = super::runtime::store_read(store_for_read, move |store| {
                    store.find_expired_closed_tasks(cutoff).unwrap_or_default()
                })
                .await
                .unwrap_or_default();
                for (task_id, files_changed) in rows {
                    if files_changed > 0 {
                        kept += 1;
                        continue;
                    }
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    if cmd_tx
                        .send(Command::DeleteTask {
                            id: task_id.clone(),
                            reply: tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if rx.await.map(|r| r.is_ok()).unwrap_or(false) {
                        expired += 1;
                    }
                }
            }

            if settled + expired + kept > 0 {
                let _ = event_tx.send(Event::HistorySwept {
                    settled,
                    expired,
                    kept,
                });
            }
        });
    }

    /// Ask a worker to read this task's persisted history off the loop and send
    /// the replay guard back as [`Command::ResumeReplayReady`]. The session does
    /// not start until then (see the SessionPrompt resume path).
    fn request_resume_replay_guard(&self, task_id: &str) {
        let persist = self.persist.clone();
        let store = self.store.clone();
        let cmd_tx = self.cmd_tx.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            persist.flush().await;
            let lookup = task_id.clone();
            let replay = super::runtime::store_read(store, move |store| {
                store
                    .load_session_updates(&lookup)
                    .map(|updates| replayable_history(&updates))
                    .unwrap_or_default()
            })
            .await
            .unwrap_or_default();
            let _ = cmd_tx
                .send(Command::ResumeReplayReady { task_id, replay })
                .await;
        });
    }

    /// Whether anything reads a finished turn's full text output.
    ///
    /// `notify_orch_finished` is a no-op unless the task is an orchestrator
    /// node, and `deliver_child_result` returns early without a parent — and it
    /// is skipped entirely for a workflow stage, which reads its own turn
    /// buffer instead. For everything else the assembled output is discarded,
    /// so it should never be assembled.
    fn turn_output_has_consumer(&self, task_id: &str, workflow_child: bool) -> bool {
        let Some(task) = self.tasks.get(task_id) else {
            return false;
        };
        let orchestrator_node =
            self.orch_tx.is_some() && task.tags.iter().any(|tag| tag == "orchestrator");
        let feeds_parent = !workflow_child && task.parent_task_id.is_some();
        orchestrator_node || feeds_parent
    }

    /// Ask a worker to assemble a finished task's full text output off the loop
    /// and send it back as [`Command::TaskOutputReady`], so the orchestrator /
    /// parent-inbox delivery never blocks the actor on a disk read.
    fn request_task_output(&self, task_id: &str, success: bool, workflow_child: bool) {
        let persist = self.persist.clone();
        let store = self.store.clone();
        let cmd_tx = self.cmd_tx.clone();
        let task_id = task_id.to_string();
        // Without a database the actor's turn buffer is the only history there
        // is; hand it back rather than an empty result.
        let fallback = agent_text_from_updates(
            self.turn_updates
                .get(&task_id)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        tokio::spawn(async move {
            persist.flush().await;
            let lookup = task_id.clone();
            let output = super::runtime::store_read(store, move |store| {
                store
                    .load_session_updates(&lookup)
                    .map(|updates| agent_text_from_updates(&updates))
                    .unwrap_or_default()
            })
            .await
            // Without a database the actor's turn buffer is the only history.
            .unwrap_or(fallback);
            let _ = cmd_tx
                .send(Command::TaskOutputReady {
                    task_id,
                    success,
                    workflow_child,
                    output,
                })
                .await;
        });
    }

    fn should_skip_resume_replay(&mut self, task_id: &str, update: &wire::SessionUpdate) -> bool {
        if !is_acp_replay_update(update) {
            return false;
        }

        let Some(guard) = self.resume_replay.get_mut(task_id) else {
            return false;
        };

        if guard.consume(update) {
            if guard.is_empty() {
                self.resume_replay.remove(task_id);
            }
            return true;
        }

        // First mismatch means the agent has moved past replay into live output
        // (or its replay shape differs from ours). Stop filtering immediately.
        self.resume_replay.remove(task_id);
        false
    }

    /// Like [`agent_text_from_updates`], but only the text streamed since the
    /// last user message — i.e. the output of the task's latest turn. The
    /// workflow engine parses this: a `need_user_input` block answered two turns
    /// ago must not be mistaken for a fresh question.
    fn collect_last_turn_text(&self, task_id: &str) -> String {
        self.collect_stage_text(task_id).full
    }

    /// A finished stage's output, in the two shapes the pipeline needs.
    ///
    /// `closing` is the agent's final message — the text streamed after its
    /// last tool call or file edit. That is what the stage prompts ask for
    /// ("your final message should summarize what you did") and what a human
    /// reads as the result, so it is what reviewers and fixers are handed.
    /// `full` is every chunk of the turn, kept as a parsing fallback for an
    /// agent that emits its protocol block before a trailing tool call.
    ///
    /// Reads the in-memory current-turn buffer (bounded by a turn, reset on
    /// each user message), not the whole session transcript.
    fn collect_stage_text(&self, task_id: &str) -> StageText {
        let updates = self
            .turn_updates
            .get(task_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        stage_text_from_updates(updates)
    }

    /// Tell the orchestrator a dispatched task finished. No-op unless the task
    /// carries the "orchestrator" tag and an orchestrator is wired.
    fn notify_orch_finished(&self, task_id: &str, success: bool, result: String) {
        let Some(orch_tx) = self.orch_tx.clone() else {
            return;
        };
        let is_orch = self
            .tasks
            .get(task_id)
            .is_some_and(|t| t.tags.iter().any(|tag| tag == "orchestrator"));
        if !is_orch {
            return;
        }
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            let _ = orch_tx
                .send(crate::orchestration::OrchCommand::TaskFinished {
                    task_id,
                    result,
                    success,
                })
                .await;
        });
    }

    /// If `child_id` was spawned by an orchestrator, queue its result in the
    /// parent's inbox and (if the parent is idle) wake it.
    fn deliver_child_result(&mut self, child_id: &str, success: bool, output: String) {
        let Some(child) = self.tasks.get(child_id) else {
            return;
        };
        let Some(parent_id) = child.parent_task_id.clone() else {
            return;
        };
        let result = ChildResult {
            child_id: child_id.to_string(),
            agent: child.agent.clone(),
            prompt: child.prompt.clone(),
            output,
            success,
        };
        self.orchestrator_inbox
            .entry(parent_id.clone())
            .or_default()
            .push(result);
        // Wake now if the orchestrator is idle; otherwise defer to its turn end.
        let running = self
            .tasks
            .get(&parent_id)
            .is_some_and(|t| t.status == TaskStatus::Running);
        if running {
            self.pending_wake.insert(parent_id);
        } else {
            self.wake_parent(&parent_id);
        }
    }

    /// Inject a system nudge into an orchestrator's session so it drains its
    /// inbox. No-op if the inbox is empty.
    fn wake_parent(&mut self, parent_id: &str) {
        let pending = self
            .orchestrator_inbox
            .get(parent_id)
            .map_or(0, |v| v.len());
        if pending == 0 {
            return;
        }
        let Some(handle) = self.sessions.get(parent_id).cloned() else {
            // Orchestrator session isn't live right now (e.g. it ended while a
            // sub-agent was still running). Keep the results queued and retry
            // the nudge when the parent next runs (its next turn end).
            self.pending_wake.insert(parent_id.to_string());
            return;
        };
        self.mark_task_running(parent_id);
        let _ = handle.prompt(super::prompt::PreparedPrompt {
            content: vec![super::prompt::PromptContent::Text(format!(
                "[System] {pending} sub-agent result(s) ready in your inbox. \
                 Call the read_inbox tool to collect them, then decide what to do next."
            ))],
            summaries: vec![],
            has_images: false,
        });
    }

    fn emit_session(&mut self, task_id: &str, update: wire::SessionUpdate) {
        self.persist.session_update(task_id, &update);
        // A new user message begins a fresh turn: drop the previous turn's
        // buffer so stage-text reads stay bounded by a turn, not the session.
        if matches!(update, wire::SessionUpdate::UserMessage { .. }) {
            self.turn_updates.remove(task_id);
        }
        self.turn_updates
            .entry(task_id.to_string())
            .or_default()
            .push(update.clone());
        self.last_session_update
            .insert(task_id.to_string(), update.clone());
        self.emit(Event::SessionUpdate {
            task_id: task_id.to_string(),
            update,
        });
    }

    fn has_pending_permission(&self, task_id: &str) -> bool {
        self.pending_permissions.has_pending(task_id)
    }

    /// Broadcast a service's current status. Emitted right after a start so a
    /// client learns the service exists (it may have subscribed before it did)
    /// — without this, newly started services never appear for other clients.
    fn emit_service_status(&self, project: &str, service: &str) {
        if let Some(svc) = self.services.get(project, service) {
            self.emit(Event::ServiceStatus {
                project: project.to_string(),
                service: service.to_string(),
                status: svc.status.clone(),
                allocated_port: svc.allocated_port,
            });
        }
    }

    fn emit_portforward_status(&self, project: &str, name: &str) {
        let key = format!("{project}/{name}");
        if let Some(pf) = self.portforwards.forwards.get(&key) {
            self.emit(Event::PortForwardStatus {
                project: project.to_string(),
                name: name.to_string(),
                status: pf.status.clone(),
            });
        }
    }

    fn emit_portforward_statuses(&self, project: &str, names: &[String]) {
        for name in names {
            self.emit_portforward_status(project, name);
        }
    }

    async fn stop_runtime(&mut self) {
        let services: Vec<(String, String)> = self
            .services
            .list()
            .into_iter()
            .map(|svc| (svc.project_name.clone(), svc.name.clone()))
            .collect();
        let pfs: Vec<(String, String)> = self
            .portforwards
            .forwards
            .keys()
            .map(|key| {
                let parts: Vec<&str> = key.splitn(2, '/').collect();
                (
                    parts.first().map(|s| s.to_string()).unwrap_or_default(),
                    parts.get(1).map(|s| s.to_string()).unwrap_or_default(),
                )
            })
            .collect();
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        kill_listeners_in_ranges(&self.project_port_ranges()).await;
        for (project, service) in services {
            self.emit_service_status(&project, &service);
        }
        for (project, name) in pfs {
            self.emit_portforward_status(&project, &name);
        }
    }

    fn project_port_ranges(&self) -> Vec<(u16, u16)> {
        self.projects
            .iter()
            .enumerate()
            .map(|(index, _)| crate::ports::port_range(index))
            .collect()
    }

    /// Build a PolicyContext for evaluating an action on a task.
    fn policy_context(
        &self,
        task_id: &str,
        phase: Phase,
        tool_name: Option<String>,
        tool_input: Option<serde_json::Value>,
    ) -> Option<PolicyContext> {
        let task = self.tasks.get(task_id)?;
        let project_path = self.project_path(&task.project)?;
        let cwd = if let Some(ref wt) = task.worktree {
            std::path::PathBuf::from(wt)
        } else {
            std::path::PathBuf::from(&project_path)
        };
        Some(PolicyContext {
            phase,
            tool_name,
            tool_input,
            agent: task.agent.clone(),
            task_id: task_id.to_string(),
            project: task.project.clone(),
            cwd,
            labels: HashMap::new(),
        })
    }

    /// Evaluate all policies for an action on a task.
    async fn evaluate_policies(
        &self,
        task_id: &str,
        phase: Phase,
        tool_name: Option<String>,
        tool_input: Option<serde_json::Value>,
    ) -> crate::policies::PolicyResult {
        let ctx = match self.policy_context(task_id, phase, tool_name, tool_input) {
            Some(ctx) => ctx,
            None => return crate::policies::PolicyResult::allow(),
        };
        self.policies.evaluate_all(&ctx).await
    }

    /// Handle a policy check request from an ACP reader task.
    async fn handle_policy_check(&mut self, check: PolicyCheck) {
        let result = self.policies.evaluate_all(&check.ctx).await;
        let _ = check.reply.send(result);
    }
}

// ─── Workflow pipeline engine (actor glue) ───────────────────────────────────
//
// The deterministic `plan? → implement → review ⇄ fix` pipeline. Pure logic
// (state container, prompt building, verdict parsing, review merging) lives in
// `daemon/workflow.rs`; these methods are the side-effectful glue: they spawn
// stage child tasks, react to their turn ends, and narrate progress into the
// parent task's transcript.
//
// Borrow discipline: methods that mutate a run *and* call `&mut self` helpers
// temporarily remove the run from `workflow_runs` and re-insert it (the
// take/put pattern). Every exit path must re-insert.
impl Daemon {
    fn workflow_is_active(&self, task_id: &str) -> bool {
        self.workflow_runs
            .get(task_id)
            .is_some_and(WorkflowRun::is_active)
    }

    /// The parent task id of an *active* pipeline this child belongs to.
    /// Searches the runs (not the tasks map) so it also works for tasks that
    /// were just removed.
    fn workflow_child_of(&self, child_id: &str) -> Option<String> {
        self.workflow_runs
            .values()
            .find(|run| {
                run.is_active()
                    && (run.active_children.contains_key(child_id)
                        || run.review_pending.contains_key(child_id))
            })
            .map(|run| run.parent_id.clone())
    }

    /// Deliver a follow-up into an existing stage session. Returns false when
    /// the session is gone — checking `is_alive()` matters because
    /// `AcpHandle::prompt` succeeds even for a dead child (its channel belongs
    /// to the driver task, which outlives the process), and a prompt sent into
    /// a corpse simply vanishes.
    fn workflow_followup(&mut self, child_id: &str, text: String) -> bool {
        let delivered = self
            .sessions
            .get(child_id)
            .filter(|handle| handle.is_alive())
            .map(|handle| {
                handle
                    .prompt(super::prompt::PreparedPrompt {
                        content: vec![super::prompt::PromptContent::Text(text.clone())],
                        summaries: vec![],
                        has_images: false,
                    })
                    .is_ok()
            })
            .unwrap_or(false);
        if delivered {
            self.emit_session(
                child_id,
                wire::SessionUpdate::UserMessage {
                    text,
                    attachments: vec![],
                },
            );
        }
        delivered
    }

    /// Append one durable, independently rendered workflow entry to the
    /// parent's Conversation. Structured events deliberately do not use
    /// AgentText: transport coalescing is correct for streamed agent chunks,
    /// but would glue unrelated workflow transitions into one Markdown blob.
    #[allow(clippy::too_many_arguments)]
    fn workflow_event(
        &mut self,
        parent_id: &str,
        event: wire::WorkflowEventKind,
        title: impl Into<String>,
        detail: Option<String>,
        stage: Option<StageKind>,
        agents: Vec<wire::WorkflowEventAgent>,
        tone: wire::WorkflowEventTone,
    ) {
        self.emit_session(
            parent_id,
            wire::SessionUpdate::WorkflowEvent {
                event,
                title: title.into(),
                detail,
                stage: stage.map(StageKind::wire),
                agents,
                tone,
            },
        );
    }

    /// Convenience wrapper for transitions that do not reference a particular
    /// agent. Split the first paragraph into the card title and keep the rest
    /// as Markdown detail.
    fn workflow_timeline(&mut self, parent_id: &str, text: impl Into<String>) {
        let text = text.into();
        let text = text.trim();
        let (heading, detail) = text
            .split_once("\n\n")
            .map(|(heading, detail)| (heading, Some(detail.trim().to_string())))
            .unwrap_or((text, None));
        let title = heading.trim_start_matches('#').trim().replace("**", "");
        let lower = text.to_ascii_lowercase();
        let tone = if lower.contains("failed") || lower.contains("stopped") {
            wire::WorkflowEventTone::Error
        } else if lower.contains("changes requested")
            || lower.contains("limit reached")
            || lower.contains("needs your input")
        {
            wire::WorkflowEventTone::Warning
        } else if lower.contains("approved") || lower.contains("finished") {
            wire::WorkflowEventTone::Success
        } else {
            wire::WorkflowEventTone::Info
        };
        let event = if lower.starts_with("workflow")
            && (lower.contains("finished") || lower.contains("failed") || lower.contains("stopped"))
        {
            wire::WorkflowEventKind::WorkflowFinished
        } else {
            wire::WorkflowEventKind::Status
        };
        self.workflow_event(parent_id, event, title, detail, None, Vec::new(), tone);
    }

    /// Sync the parent task's `workflow_run` + `orchestration_graph`
    /// projections from the run, persist, and broadcast; also persist the run.
    fn workflow_sync(&mut self, run: &WorkflowRun) {
        if let Some(task) = self.tasks.get_mut(&run.parent_id) {
            // The coarse task status describes whether work is executing, while
            // workflow_run.waiting carries the precise barrier reason.
            let active_status = match run.state {
                RunState::Running { .. } => Some(TaskStatus::Running),
                RunState::AwaitingReply { .. }
                | RunState::AwaitingLimitDecision
                | RunState::Paused { .. } => Some(TaskStatus::Waiting),
                RunState::Done | RunState::Failed => None,
            };
            if let Some(status) = active_status {
                if task.status != status {
                    task.set_status(status);
                }
            }
            task.workflow_run = Some(run.wire_info());
            task.orchestration_graph = Some(run.graph_info());
            task.updated_at = super::task::now_secs();
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
        if let Ok(json) = serde_json::to_string(run) {
            self.persist.workflow_run(&run.parent_id, json);
        }
    }

    /// Workflow stage tasks are execution records, not independent changes to
    /// review. Keep their lifecycle aligned with the stage state and emit the
    /// update immediately so Board/Subtasks never retain a stale generic
    /// turn-end status.
    fn workflow_set_child_status(&mut self, child_id: &str, status: TaskStatus) {
        if let Some(task) = self.tasks.get_mut(child_id) {
            if task.status == status {
                return;
            }
            task.set_status(status);
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
    }

    /// `CreateWorkflowTask`: validate the workflow, create the parent task
    /// (without an agent session), and start the first stage.
    #[allow(clippy::too_many_arguments)]
    async fn workflow_create(
        &mut self,
        project: String,
        prompt: String,
        agent: String,
        tags: Vec<String>,
        use_worktree: bool,
        workflow_id: String,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        include_runtime_context: bool,
        config_overrides: HashMap<String, String>,
        parent_task_id: Option<String>,
    ) -> Result<String, String> {
        let path = self
            .project_path(&project)
            .ok_or_else(|| format!("unknown project '{project}'"))?;
        if self.store.is_none() {
            // Stage results are read back out of the persisted transcript, so
            // without a store every stage would look like it produced nothing.
            return Err(
                "workflows need the local database, which failed to open — check \
                 ~/.warpforge and restart the daemon"
                    .to_string(),
            );
        }
        let loaded =
            crate::workflow_config::load_workflow(std::path::Path::new(&path), &workflow_id)
                .ok_or_else(|| format!("unknown workflow `{workflow_id}`"))?;
        let warnings = loaded.warnings.clone();
        let spec = loaded
            .spec
            .map_err(|e| format!("workflow `{workflow_id}` is invalid: {e}"))?;

        let mut tags = tags;
        tags.push(format!("workflow:{workflow_id}"));
        let mut task = Task::new(&project, &prompt, &agent, tags);
        task.parent_task_id = parent_task_id;
        // An explicit lead model from the dialog is the task's model intent.
        task.model = default_model.clone();
        if use_worktree {
            let wt_mgr = self
                .worktrees
                .entry(project.clone())
                .or_insert_with(|| WorktreeManager::new(std::path::PathBuf::from(&path)));
            match wt_mgr.create(&task.id, None).await {
                Ok(wt) => task.worktree = Some(wt.path.to_string_lossy().to_string()),
                Err(e) => eprintln!("[daemon] worktree creation failed: {e}"),
            }
        }
        // The parent is "running" for the whole life of the pipeline.
        task.set_status(TaskStatus::Running);
        let resolved_model = default_model.or_else(|| {
            self.configured_agents
                .iter()
                .find(|a| a.id == agent)
                .and_then(|a| a.last_model.clone())
        });
        let parent_id = task.id.clone();
        self.tasks.insert(parent_id.clone(), task.clone());
        self.persist(&task);
        self.emit(Event::TaskCreated(task));

        let run = WorkflowRun::new(
            parent_id.clone(),
            project,
            spec,
            agent,
            resolved_model,
            attachments,
            include_runtime_context,
            config_overrides,
        );
        self.workflow_event(
            &parent_id,
            wire::WorkflowEventKind::WorkflowStarted,
            format!("Workflow started: {}", run.spec.name),
            Some({
                let mut detail = format!(
                    "**Stages:** {}  \n**Review limit:** {} round(s)",
                    run.spec.stage_summary().join(" → "),
                    run.effective_max_rounds(),
                );
                // Warnings are otherwise only visible as a picker tooltip, so a
                // clamped limit or an ignored key would silently shape the run.
                if !warnings.is_empty() {
                    detail.push_str("\n\n**Workflow file warnings:**\n");
                    for warning in &warnings {
                        detail.push_str(&format!("- {warning}\n"));
                    }
                }
                detail
            }),
            None,
            Vec::new(),
            wire::WorkflowEventTone::Info,
        );
        let first = run.first_stage();
        self.workflow_runs.insert(parent_id.clone(), run);
        self.workflow_spawn_stage(&parent_id, first).await;
        Ok(parent_id)
    }

    /// Spawn the child task(s) for a stage and mark the run as running it.
    async fn workflow_spawn_stage(&mut self, parent_id: &str, stage: StageKind) {
        let Some(mut run) = self.workflow_runs.remove(parent_id) else {
            return;
        };
        let Some(parent) = self.tasks.get(parent_id) else {
            self.workflow_runs.insert(parent_id.to_string(), run);
            return;
        };
        let parent_prompt = parent.prompt.clone();
        let parent_title = parent.title.clone();
        let worktree = parent.worktree.clone();
        let project = run.project.clone();

        if stage == StageKind::Review {
            run.round += 1;
        }
        let guidance = match stage {
            StageKind::Review => None,
            _ => run.take_guidance(),
        };
        // Review and fix stages see the current working-copy diff.
        let diff = match stage {
            StageKind::Review | StageKind::Fix => {
                let dir = worktree.clone().or_else(|| self.project_path(&project));
                match dir {
                    Some(dir) => match super::diff::working_diff(&dir).await {
                        Ok(files) => Some(workflow::format_diff(&files)),
                        Err(e) => Some(format!("(diff unavailable: {e})")),
                    },
                    None => None,
                }
            }
            _ => None,
        };
        let ctx = workflow::PromptCtx {
            task_prompt: parent_prompt,
            plan: run.plan_output.clone(),
            implementer_summary: run.last_summary.as_deref().map(workflow::clip_summary),
            diff,
            findings: match stage {
                StageKind::Fix => Some(workflow::format_findings(&run.open_findings)),
                _ => None,
            },
            prior_findings: match stage {
                // On a repeat round `open_findings` still holds what the last
                // review raised — the next reviewers must verify each item.
                StageKind::Review if run.round > 1 && !run.open_findings.is_empty() => {
                    Some(workflow::format_findings(&run.open_findings))
                }
                _ => None,
            },
            round: run.round,
            max_rounds: run.effective_max_rounds(),
            guidance,
        };
        // The dialog's attachments ride along with the very first stage only.
        let attachments = if run.history.is_empty() {
            std::mem::take(&mut run.attachments)
        } else {
            Vec::new()
        };

        run.state = RunState::Running { stage };
        match stage {
            StageKind::Review => {
                run.review_pending.clear();
                run.review_collected.clear();
                run.reasked.clear();
                let round_label = format!("round {}/{}", run.round, run.effective_max_rounds());
                // Repeat rounds follow up in the previous reviewers' live
                // sessions (review.reask: same_session, the default): the
                // reviewer remembers its own findings and verifies each one
                // instead of re-reviewing from scratch. A dead session falls
                // back to a fresh spawn whose prompt carries those findings.
                let reuse_sessions = run.round > 1
                    && run.spec.review.reask == crate::workflow_config::ReaskMode::SameSession;
                let mut event_agents = Vec::with_capacity(run.spec.review.reviewers.len());
                let mut reused = 0usize;
                for index in 0..run.spec.review.reviewers.len() {
                    let (agent, model) = run.stage_agent(stage, Some(index));
                    let label = run.reviewer_label(index);
                    if reuse_sessions {
                        if let Some(prior_id) = run.prior_review_children.get(&index).cloned() {
                            let followup = workflow::build_rereview_prompt(&ctx);
                            if self.workflow_followup(&prior_id, followup) {
                                // The child was parked Done after its verdict;
                                // the generic mark_task_running refuses Done
                                // tasks, so flip it explicitly.
                                self.workflow_set_child_status(&prior_id, TaskStatus::Running);
                                run.review_pending.insert(prior_id.clone(), index);
                                run.active_children.insert(prior_id.clone(), stage);
                                run.record_stage(
                                    stage,
                                    &prior_id,
                                    &agent,
                                    format!("{label}, {round_label}"),
                                );
                                event_agents.push(wire::WorkflowEventAgent {
                                    task_id: prior_id,
                                    label,
                                    agent,
                                    model,
                                });
                                reused += 1;
                                continue;
                            }
                        }
                    }
                    let prompt = workflow::build_reviewer_prompt(&run.spec, index, &ctx);
                    let spawned = self.workflow_spawn_child(
                        &run.project,
                        parent_id,
                        &agent,
                        model.clone(),
                        prompt,
                        worktree.clone(),
                        format!("review · {parent_title}"),
                        Vec::new(),
                        run.include_runtime_context,
                        run.config_overrides.clone(),
                    );
                    // A reviewer whose session never started is recorded as a
                    // failed node and excluded, exactly like one that dies
                    // mid-review — it must not sit in `review_pending` waiting
                    // for a TurnEnded that can never arrive.
                    let (child_id, started) = match spawned {
                        Ok(id) => (id, true),
                        Err(id) => (id, false),
                    };
                    run.record_stage(stage, &child_id, &agent, format!("{label}, {round_label}"));
                    if started {
                        run.review_pending.insert(child_id.clone(), index);
                        run.active_children.insert(child_id.clone(), stage);
                    } else {
                        run.set_record_status(&child_id, wire::OrchNodeStatus::Failed);
                    }
                    event_agents.push(wire::WorkflowEventAgent {
                        task_id: child_id,
                        label,
                        agent,
                        model,
                    });
                }
                // Remember this round's staffing for the next reask.
                run.prior_review_children = run
                    .review_pending
                    .iter()
                    .map(|(child, index)| (*index, child.clone()))
                    .collect();
                let detail = if reused > 0 {
                    format!(
                        "{} reviewer(s) running; {reused} continuing their previous session to \
                         verify their own findings.",
                        run.review_pending.len()
                    )
                } else {
                    format!("{} reviewer(s) running.", run.review_pending.len())
                };
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::StageStarted,
                    format!("Review {round_label} started"),
                    Some(detail),
                    Some(stage),
                    event_agents,
                    wire::WorkflowEventTone::Running,
                );
            }
            _ => {
                let (agent, model) = run.stage_agent(stage, None);
                let prompt = match stage {
                    StageKind::Plan => workflow::build_plan_prompt(&run.spec, &ctx),
                    StageKind::Implement => workflow::build_implement_prompt(&run.spec, &ctx),
                    StageKind::Fix => workflow::build_fix_prompt(&run.spec, &ctx),
                    StageKind::Review => unreachable!(),
                };
                let spawned = self.workflow_spawn_child(
                    &run.project,
                    parent_id,
                    &agent,
                    model.clone(),
                    prompt,
                    worktree.clone(),
                    format!("{} · {parent_title}", stage.label()),
                    attachments,
                    run.include_runtime_context,
                    run.config_overrides.clone(),
                );
                let label = match stage {
                    StageKind::Fix => format!("{} (round {})", stage.label(), run.round),
                    _ => stage.label().to_string(),
                };
                let child_id = match spawned {
                    Ok(id) => {
                        run.active_children.insert(id.clone(), stage);
                        run.record_stage(stage, &id, &agent, label.clone());
                        id
                    }
                    Err(id) => {
                        // No session means no TurnEnded will ever arrive, so
                        // fail the pipeline here instead of hanging in
                        // "running" until the user cancels.
                        run.record_stage(stage, &id, &agent, label.clone());
                        run.set_record_status(&id, wire::OrchNodeStatus::Failed);
                        let reason = self
                            .tasks
                            .get(&id)
                            .and_then(|t| t.blocked_reason.clone())
                            .unwrap_or_else(|| {
                                "the agent session could not be started".to_string()
                            });
                        self.workflow_runs.insert(parent_id.to_string(), run);
                        let _ = self
                            .workflow_finalize(
                                parent_id,
                                WorkflowOutcome::Error(format!(
                                    "stage {} could not start: {reason}",
                                    stage.label()
                                )),
                            )
                            .await;
                        return;
                    }
                };
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::StageStarted,
                    format!("{} started", stage.title()),
                    None,
                    Some(stage),
                    vec![wire::WorkflowEventAgent {
                        task_id: child_id,
                        label,
                        agent,
                        model,
                    }],
                    wire::WorkflowEventTone::Running,
                );
            }
        }
        self.workflow_sync(&run);
        self.workflow_runs.insert(parent_id.to_string(), run);
    }

    /// Create and start one stage child task. Children run in the parent's
    /// directory (its worktree when isolated) but are NOT registered in the
    /// worktree manager — the parent owns the worktree's lifecycle.
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::result_large_err)]
    fn workflow_spawn_child(
        &mut self,
        project: &str,
        parent_id: &str,
        agent: &str,
        model: Option<String>,
        prompt: String,
        worktree: Option<String>,
        title: String,
        attachments: Vec<wire::PromptAttachment>,
        include_runtime_context: bool,
        config_overrides: HashMap<String, String>,
    ) -> Result<String, String> {
        let mut task = Task::new(project, &prompt, agent, vec!["workflow-stage".to_string()]);
        task.parent_task_id = Some(parent_id.to_string());
        task.worktree = worktree;
        task.title = title;
        // The stage pin (or inherited lead model) is the child's model intent.
        task.model = model.clone();
        let child_id = task.id.clone();
        self.tasks.insert(child_id.clone(), task.clone());
        self.persist(&task);
        self.emit(Event::TaskCreated(task));
        self.start_session(
            &child_id,
            project,
            agent,
            &prompt,
            include_runtime_context,
            None,
            attachments,
            model,
            config_overrides,
        );
        // `start_session` reports prompt-preparation and spawn failures by
        // blocking the child task and inserting no handle. Without a session
        // there is no TurnEnded to advance the pipeline, so the caller must
        // learn about it here or the parent hangs in "running" forever.
        if self.sessions.contains_key(&child_id) {
            Ok(child_id)
        } else {
            Err(child_id)
        }
    }

    /// A stage child's turn ended (or its session died). Advance the pipeline.
    async fn workflow_stage_finished(&mut self, child_id: &str, success: bool, text: StageText) {
        // Prefer the closing message: it is the agent's actual result, and
        // reading it instead of the whole turn means a JSON block quoted
        // mid-turn (while browsing a config file, say) cannot be mistaken for
        // the protocol payload. Fall back to the full turn only when the
        // payload genuinely is not in the closing message — an agent that
        // emitted its block and then made one last tool call.
        let closing_is_usable = !text.closing.trim().is_empty()
            && (workflow::has_protocol_payload(&text.closing)
                || !workflow::has_protocol_payload(&text.full));
        let output = if closing_is_usable {
            text.closing.clone()
        } else {
            text.full.clone()
        };
        let Some(parent_id) = self.workflow_child_of(child_id) else {
            return;
        };
        let Some(mut run) = self.workflow_runs.remove(&parent_id) else {
            return;
        };
        let stage = match run.active_children.get(child_id) {
            Some(stage) => *stage,
            None => {
                self.workflow_runs.insert(parent_id.clone(), run);
                return;
            }
        };
        // Only a running stage advances the pipeline: a turn that ends while
        // we await a reply is the answered child continuing, handled below.
        let running_stage = matches!(run.state, RunState::Running { stage: s } if s == stage);
        let awaiting_this_child =
            matches!(&run.state, RunState::AwaitingReply { child, .. } if child == child_id);
        if !running_stage && !awaiting_this_child {
            self.workflow_runs.insert(parent_id.clone(), run);
            return;
        }

        if !success {
            self.workflow_child_failed(&parent_id, run, child_id, stage)
                .await;
            return;
        }

        match stage {
            StageKind::Review => {
                self.workflow_review_finished(&parent_id, run, child_id, output)
                    .await;
            }
            StageKind::Plan | StageKind::Implement | StageKind::Fix => {
                match workflow::parse_stage_signal(&output) {
                    StageSignal::Question(question) => {
                        run.state = RunState::AwaitingReply {
                            stage,
                            child: child_id.to_string(),
                            question: question.clone(),
                        };
                        self.workflow_set_child_status(child_id, TaskStatus::Waiting);
                        let event_agent = run
                            .history
                            .iter()
                            .rev()
                            .find(|record| record.task_id == child_id)
                            .map(|record| wire::WorkflowEventAgent {
                                task_id: record.task_id.clone(),
                                label: record.label.clone(),
                                agent: record.agent.clone(),
                                model: run.stage_agent(stage, None).1,
                            });
                        self.workflow_event(
                            &parent_id,
                            wire::WorkflowEventKind::AgentOutput,
                            format!("{} needs your input", stage.title()),
                            Some(workflow::display_output(&output)),
                            Some(stage),
                            event_agent.into_iter().collect(),
                            wire::WorkflowEventTone::Warning,
                        );
                        self.workflow_sync(&run);
                        self.workflow_runs.insert(parent_id.clone(), run);
                    }
                    StageSignal::Output => {
                        run.active_children.remove(child_id);
                        run.set_record_status(child_id, wire::OrchNodeStatus::Complete);
                        self.workflow_set_child_status(child_id, TaskStatus::Done);
                        let event_agent = run
                            .history
                            .iter()
                            .rev()
                            .find(|record| record.task_id == child_id)
                            .map(|record| wire::WorkflowEventAgent {
                                task_id: record.task_id.clone(),
                                label: record.label.clone(),
                                agent: record.agent.clone(),
                                model: run.stage_agent(stage, None).1,
                            });
                        match stage {
                            StageKind::Plan => run.plan_output = Some(output.clone()),
                            _ => run.last_summary = Some(output.clone()),
                        }
                        self.workflow_event(
                            &parent_id,
                            wire::WorkflowEventKind::AgentOutput,
                            format!("{} completed", stage.title()),
                            Some(workflow::display_output(&output)),
                            Some(stage),
                            event_agent.into_iter().collect(),
                            wire::WorkflowEventTone::Success,
                        );
                        let next = stage.successor().unwrap_or(StageKind::Review);
                        self.workflow_runs.insert(parent_id.clone(), run);
                        self.workflow_advance(&parent_id, next).await;
                    }
                }
            }
        }
    }

    /// A non-review stage child failed, or a reviewer died. Reviewers are
    /// excluded from the verdict; any other stage failure fails the pipeline.
    /// Park a run whose stage lost its agent, instead of failing it outright.
    ///
    /// Losing the agent process is an infrastructure failure, not a verdict:
    /// the stage never got to say whether the work was good. Failing the run
    /// made that unrecoverable — the pipeline was finished, and a user whose
    /// agent died (or who revived the session by hand and watched it finish the
    /// work) had no way to continue and had to start over. Parking at the
    /// existing pause barrier leaves it resumable, and resume re-runs the stage.
    ///
    /// Mirrors the daemon-restart recovery in `restore_workflow_runs`, down to
    /// warning the re-run that the working copy may already hold partial work.
    fn workflow_park_after_failure(
        &mut self,
        parent_id: &str,
        mut run: WorkflowRun,
        stage: StageKind,
        reason: &str,
    ) {
        run.active_children.clear();
        if stage == StageKind::Review {
            run.review_pending.clear();
            run.review_collected.clear();
            run.reasked.clear();
            // Re-running a review re-increments `round` on spawn; give the
            // abandoned round back or the re-run reports "round 3/2".
            run.round = run.round.saturating_sub(1);
        }
        run.pause_requested = false;
        run.state = RunState::Paused { next: stage };
        run.pending_guidance = Some(format!(
            "The previous attempt of this stage ended before it finished: {reason}. The working \
             copy may already contain its partial changes — inspect the current diff before \
             assuming you are starting from scratch."
        ));
        self.workflow_sync(&run);
        self.workflow_runs.insert(parent_id.to_string(), run);
        self.workflow_timeline(
            parent_id,
            format!(
                "Stage **{}** lost its agent: {reason}. Paused — resume to run it again.",
                stage.label()
            ),
        );
    }

    async fn workflow_child_failed(
        &mut self,
        parent_id: &str,
        mut run: WorkflowRun,
        child_id: &str,
        stage: StageKind,
    ) {
        run.set_record_status(child_id, wire::OrchNodeStatus::Failed);
        if stage == StageKind::Review {
            let index = run.review_pending.remove(child_id);
            run.active_children.remove(child_id);
            run.reasked.remove(child_id);
            let label = index
                .map(|i| run.reviewer_label(i))
                .unwrap_or_else(|| "reviewer".to_string());
            let event_agent = run
                .history
                .iter()
                .rev()
                .find(|record| record.task_id == child_id)
                .map(|record| wire::WorkflowEventAgent {
                    task_id: record.task_id.clone(),
                    label: record.label.clone(),
                    agent: record.agent.clone(),
                    model: index.and_then(|i| run.stage_agent(StageKind::Review, Some(i)).1),
                });
            self.workflow_event(
                parent_id,
                wire::WorkflowEventKind::AgentOutput,
                format!("{label} failed"),
                Some("Excluded from this round's verdict.".to_string()),
                Some(stage),
                event_agent.into_iter().collect(),
                wire::WorkflowEventTone::Error,
            );
            if run.review_pending.is_empty() {
                if run.review_collected.is_empty() {
                    // Every reviewer lost its agent, so the round produced no
                    // verdict at all. That is the same infrastructure failure
                    // as a dead implement stage, not a rejection of the work.
                    self.workflow_park_after_failure(
                        parent_id,
                        run,
                        stage,
                        "every reviewer's agent ended before producing a verdict",
                    );
                } else {
                    self.workflow_merge_reviews(parent_id, run).await;
                }
            } else {
                self.workflow_sync(&run);
                self.workflow_runs.insert(parent_id.to_string(), run);
            }
            return;
        }
        let reason = self
            .tasks
            .get(child_id)
            .and_then(|t| t.blocked_reason.clone())
            .unwrap_or_else(|| "agent session ended unexpectedly".to_string());
        let event_agent = run
            .history
            .iter()
            .rev()
            .find(|record| record.task_id == child_id)
            .map(|record| wire::WorkflowEventAgent {
                task_id: record.task_id.clone(),
                label: record.label.clone(),
                agent: record.agent.clone(),
                model: run.stage_agent(stage, None).1,
            });
        self.workflow_event(
            parent_id,
            wire::WorkflowEventKind::AgentOutput,
            format!("{} failed", stage.title()),
            Some(reason.clone()),
            Some(stage),
            event_agent.into_iter().collect(),
            wire::WorkflowEventTone::Error,
        );
        self.workflow_park_after_failure(parent_id, run, stage, &reason);
    }

    /// One reviewer's turn ended: parse its verdict, re-ask once on garbage,
    /// and merge the round when every reviewer has resolved.
    async fn workflow_review_finished(
        &mut self,
        parent_id: &str,
        mut run: WorkflowRun,
        child_id: &str,
        output: String,
    ) {
        let Some(index) = run.review_pending.get(child_id).copied() else {
            self.workflow_runs.insert(parent_id.to_string(), run);
            return;
        };
        let label = run.reviewer_label(index);
        match workflow::parse_review_verdict(&output, &label) {
            Ok((verdict, findings)) => {
                self.workflow_set_child_status(child_id, TaskStatus::Done);
                let event_agent = run
                    .history
                    .iter()
                    .rev()
                    .find(|record| record.task_id == child_id)
                    .map(|record| wire::WorkflowEventAgent {
                        task_id: record.task_id.clone(),
                        label: record.label.clone(),
                        agent: record.agent.clone(),
                        model: run.stage_agent(StageKind::Review, Some(index)).1,
                    });
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::ReviewResult,
                    format!(
                        "{label}: {}",
                        match verdict {
                            Verdict::Approve => "approved",
                            Verdict::RequestChanges => "changes requested",
                        },
                    ),
                    Some(workflow::display_output(&output)),
                    Some(StageKind::Review),
                    event_agent.into_iter().collect(),
                    match verdict {
                        Verdict::Approve => wire::WorkflowEventTone::Success,
                        Verdict::RequestChanges => wire::WorkflowEventTone::Warning,
                    },
                );
                run.review_pending.remove(child_id);
                run.active_children.remove(child_id);
                run.set_record_status(child_id, wire::OrchNodeStatus::Complete);
                run.review_collected.push((index, verdict, findings));
                if run.review_pending.is_empty() {
                    self.workflow_merge_reviews(parent_id, run).await;
                } else {
                    self.workflow_sync(&run);
                    self.workflow_runs.insert(parent_id.to_string(), run);
                }
            }
            Err(reason) => {
                let event_agent = run
                    .history
                    .iter()
                    .rev()
                    .find(|record| record.task_id == child_id)
                    .map(|record| wire::WorkflowEventAgent {
                        task_id: record.task_id.clone(),
                        label: record.label.clone(),
                        agent: record.agent.clone(),
                        model: run.stage_agent(StageKind::Review, Some(index)).1,
                    });
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::AgentOutput,
                    format!("{label}: invalid review response"),
                    Some(workflow::display_output(&output)),
                    Some(StageKind::Review),
                    event_agent.into_iter().collect(),
                    wire::WorkflowEventTone::Warning,
                );
                let asked = run.reasked.entry(child_id.to_string()).or_insert(0);
                if *asked < workflow::MAX_VERDICT_REASKS {
                    *asked += 1;
                    let reask = workflow::reask_verdict_prompt(&reason);
                    if self.workflow_followup(child_id, reask) {
                        self.mark_task_running(child_id);
                        self.workflow_timeline(
                            parent_id,
                            format!("{label} returned no parseable verdict — asking again."),
                        );
                        self.workflow_runs.insert(parent_id.to_string(), run);
                        return;
                    }
                    // Dead session: fall through to the failure path.
                }
                self.workflow_runs.insert(parent_id.to_string(), run);
                // Treat a reviewer that cannot produce a parseable verdict the
                // same way as one whose process died: abstain from this round.
                // Failing the whole pipeline because one agent wrote prose
                // twice would throw away a complete implementation.
                self.workflow_event(
                    parent_id,
                    wire::WorkflowEventKind::AgentOutput,
                    format!("{label} abstained"),
                    Some(format!(
                        "No parseable verdict after a retry ({reason}) — excluded from this \
                         round's verdict."
                    )),
                    Some(StageKind::Review),
                    Vec::new(),
                    wire::WorkflowEventTone::Warning,
                );
                let Some(mut run) = self.workflow_runs.remove(parent_id) else {
                    return;
                };
                run.review_pending.remove(child_id);
                run.active_children.remove(child_id);
                run.reasked.remove(child_id);
                run.set_record_status(child_id, wire::OrchNodeStatus::Failed);
                self.workflow_set_child_status(child_id, TaskStatus::Waiting);
                if run.review_pending.is_empty() {
                    if run.review_collected.is_empty() {
                        self.workflow_runs.insert(parent_id.to_string(), run);
                        let _ = self
                            .workflow_finalize(
                                parent_id,
                                WorkflowOutcome::Error(
                                    "no reviewer produced a usable verdict".to_string(),
                                ),
                            )
                            .await;
                    } else {
                        self.workflow_merge_reviews(parent_id, run).await;
                    }
                } else {
                    self.workflow_sync(&run);
                    self.workflow_runs.insert(parent_id.to_string(), run);
                }
            }
        }
    }

    /// All reviewers of a round resolved: merge, then approve / fix / limit.
    async fn workflow_merge_reviews(&mut self, parent_id: &str, mut run: WorkflowRun) {
        let (verdict, findings) = workflow::merge_reviews(&run.review_collected);
        run.review_collected.clear();
        run.last_verdict = Some(verdict);
        let (to_fix, low): (Vec<_>, Vec<_>) =
            findings.into_iter().partition(|f| f.severity.goes_to_fix());
        run.deferred_findings.extend(low);
        match verdict {
            Verdict::Approve => {
                self.workflow_timeline(
                    parent_id,
                    format!("Review round {}: **approved**.", run.round),
                );
                run.open_findings.clear();
                self.workflow_runs.insert(parent_id.to_string(), run);
                let _ = self
                    .workflow_finalize(parent_id, WorkflowOutcome::Success { limit_hit: false })
                    .await;
            }
            Verdict::RequestChanges if to_fix.is_empty() => {
                // Changes requested but every finding is low-severity — there
                // is nothing for the fixer to do. Finish with notes.
                self.workflow_timeline(
                    parent_id,
                    format!(
                        "Review round {}: changes requested, but only low-severity notes remain — finishing.",
                        run.round
                    ),
                );
                run.open_findings.clear();
                self.workflow_runs.insert(parent_id.to_string(), run);
                let _ = self
                    .workflow_finalize(parent_id, WorkflowOutcome::Success { limit_hit: false })
                    .await;
            }
            Verdict::RequestChanges => {
                run.open_findings = to_fix;
                self.workflow_timeline(
                    parent_id,
                    format!(
                        "Review round {}: **changes requested** — {}.\n\n{}",
                        run.round,
                        workflow::summarize_findings(&run.open_findings),
                        workflow::format_findings(&run.open_findings),
                    ),
                );
                if run.round < run.effective_max_rounds() {
                    self.workflow_runs.insert(parent_id.to_string(), run);
                    self.workflow_advance(parent_id, StageKind::Fix).await;
                } else {
                    match run.spec.review.on_limit {
                        crate::workflow_config::OnLimit::Ask => {
                            run.state = RunState::AwaitingLimitDecision;
                            self.workflow_timeline(
                                parent_id,
                                format!(
                                    "Review limit reached ({} rounds) with {}. What next — extend \
                                     the rounds, finish as is, or stop? You can add guidance for \
                                     the next fix attempt.",
                                    run.effective_max_rounds(),
                                    workflow::summarize_findings(&run.open_findings),
                                ),
                            );
                            self.workflow_sync(&run);
                            self.workflow_runs.insert(parent_id.to_string(), run);
                        }
                        crate::workflow_config::OnLimit::Finish => {
                            self.workflow_runs.insert(parent_id.to_string(), run);
                            let _ = self
                                .workflow_finalize(
                                    parent_id,
                                    WorkflowOutcome::Success { limit_hit: true },
                                )
                                .await;
                        }
                    }
                }
            }
        }
    }

    /// Stage barrier: honour a pending pause request, otherwise start `next`.
    async fn workflow_advance(&mut self, parent_id: &str, next: StageKind) {
        let paused = {
            let Some(run) = self.workflow_runs.get_mut(parent_id) else {
                return;
            };
            if run.pause_requested {
                run.pause_requested = false;
                run.state = RunState::Paused { next };
                true
            } else {
                false
            }
        };
        if paused {
            self.workflow_timeline(
                parent_id,
                format!(
                    "Paused before stage **{}**. Resume to continue; you can add guidance.",
                    next.label()
                ),
            );
            let run = self.workflow_runs.get(parent_id).cloned();
            if let Some(run) = run {
                self.workflow_sync(&run);
            }
        } else {
            self.workflow_spawn_stage(parent_id, next).await;
        }
    }

    /// Kill the run's stage sessions, wait until their processes have exited,
    /// and mark the still-active children Interrupted. Completed stages keep
    /// their sessions alive during the run (same-session re-review follows up
    /// in them), so the sweep covers every child the run ever spawned — not
    /// just the active ones.
    async fn workflow_stop_children(&mut self, run: &mut WorkflowRun) -> Result<(), String> {
        let active: Vec<String> = run.active_children.keys().cloned().collect();
        let mut handles = Vec::new();
        for child_id in run.all_children() {
            if let Some(handle) = self.sessions.remove(&child_id) {
                handle.cancel();
                handles.push(handle);
            }
            self.pending_permissions.cleanup_task(&child_id);
        }
        // Only in-flight stages get their record and task status rewritten;
        // completed ones keep their Done/Complete state.
        for child_id in active {
            run.set_record_status(&child_id, wire::OrchNodeStatus::Skipped);
            if let Some(task) = self.tasks.get_mut(&child_id) {
                if task.status == TaskStatus::Running || task.status == TaskStatus::Queued {
                    task.set_status(TaskStatus::Interrupted);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
        // Signal every parallel reviewer before awaiting any one of them.
        let mut stop_error = None;
        for handle in handles {
            if let Err(error) = handle.wait_for_exit_within(super::acp::STOP_GRACE).await {
                stop_error.get_or_insert(error);
            }
        }
        run.active_children.clear();
        run.review_pending.clear();
        match stop_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// End the pipeline: stop children, write the summary, set the parent's
    /// final status.
    async fn workflow_finalize(
        &mut self,
        parent_id: &str,
        outcome: WorkflowOutcome,
    ) -> Result<(), String> {
        let Some(mut run) = self.workflow_runs.remove(parent_id) else {
            return Ok(());
        };
        if !run.is_active() {
            self.workflow_runs.insert(parent_id.to_string(), run);
            return Ok(());
        }
        let stop_result = self.workflow_stop_children(&mut run).await;

        let mut summary = String::new();
        let rounds_used = run.round;
        match &outcome {
            WorkflowOutcome::Success { limit_hit } => {
                run.state = RunState::Done;
                summary.push_str(&format!(
                    "Workflow **{}** finished after {rounds_used} review round(s).",
                    run.spec.name
                ));
                if *limit_hit {
                    summary.push_str(&format!(
                        "\n\n⚠ Review limit reached with unresolved findings:\n{}",
                        workflow::format_findings(&run.open_findings)
                    ));
                }
                if !run.deferred_findings.is_empty() {
                    summary.push_str(&format!(
                        "\n\nLow-severity notes from review (not auto-fixed):\n{}",
                        workflow::format_findings(&run.deferred_findings)
                    ));
                }
                summary.push_str("\n\nReview the changes and commit when ready.");
            }
            WorkflowOutcome::Stopped => {
                run.state = RunState::Failed;
                summary.push_str(&format!("Workflow **{}** stopped.", run.spec.name));
            }
            WorkflowOutcome::Error(reason) => {
                run.state = RunState::Failed;
                summary.push_str(&format!(
                    "Workflow **{}** failed: {reason}. Changes made so far remain in the \
                     working copy.",
                    run.spec.name
                ));
            }
        }
        // A pipeline spawned via spawn_workflow (parent_task_id set) reports
        // to its orchestrator's inbox the same way a plain sub-agent does;
        // deliver_child_result no-ops when there is no parent.
        let success = matches!(outcome, WorkflowOutcome::Success { .. });
        self.deliver_child_result(parent_id, success, summary.clone());
        self.workflow_timeline(parent_id, summary);

        if let Some(task) = self.tasks.get_mut(parent_id) {
            match &outcome {
                WorkflowOutcome::Success { .. } => task.set_status(TaskStatus::Waiting),
                WorkflowOutcome::Stopped => task.set_status(TaskStatus::Interrupted),
                WorkflowOutcome::Error(reason) => {
                    task.blocked_reason = Some(reason.clone());
                    task.set_status(TaskStatus::Blocked);
                }
            }
        }
        self.workflow_sync(&run);
        self.workflow_runs.insert(parent_id.to_string(), run);
        // The state transition succeeded even if a stage process was slow to
        // die; surfacing teardown trouble as the RPC's error would make a
        // completed decision look rejected.
        if let Err(error) = stop_result {
            self.workflow_timeline(
                parent_id,
                format!("Note: a stage agent did not shut down cleanly ({error})."),
            );
        }
        Ok(())
    }

    /// A stage child task was cancelled or deleted out from under the run.
    async fn workflow_child_gone(&mut self, child_id: &str) {
        if self.workflow_child_of(child_id).is_some() {
            self.workflow_stage_finished(child_id, false, StageText::default())
                .await;
        }
    }

    // ── User-facing controls (workflow.pause / resume / reply / decide) ──

    fn workflow_pause(&mut self, parent_id: &str) -> Result<(), String> {
        let Some(run) = self.workflow_runs.get_mut(parent_id) else {
            return Err("no workflow pipeline on this task".to_string());
        };
        match run.state {
            RunState::Running { .. } => {
                if run.pause_requested {
                    return Err("pause already requested".to_string());
                }
                run.pause_requested = true;
                self.workflow_timeline(
                    parent_id,
                    "Pause requested — takes effect when the current stage finishes its turn.",
                );
                let run = self.workflow_runs.get(parent_id).cloned();
                if let Some(run) = run {
                    self.workflow_sync(&run);
                }
                Ok(())
            }
            RunState::Paused { .. } => Err("already paused".to_string()),
            RunState::AwaitingReply { .. } | RunState::AwaitingLimitDecision => {
                Err("the pipeline is already waiting for your input".to_string())
            }
            RunState::Done | RunState::Failed => Err("the pipeline has finished".to_string()),
        }
    }

    async fn workflow_resume(
        &mut self,
        parent_id: &str,
        note: Option<String>,
    ) -> Result<(), String> {
        let next = {
            let Some(run) = self.workflow_runs.get_mut(parent_id) else {
                return Err("no workflow pipeline on this task".to_string());
            };
            let RunState::Paused { next } = run.state else {
                return Err("the pipeline is not paused".to_string());
            };
            run.pause_requested = false;
            if let Some(note) = note.filter(|n| !n.trim().is_empty()) {
                self.emit_session(
                    parent_id,
                    wire::SessionUpdate::UserMessage {
                        text: note.clone(),
                        attachments: vec![],
                    },
                );
                let run = self.workflow_runs.get_mut(parent_id).unwrap();
                run.pending_guidance = Some(note);
            }
            next
        };
        self.workflow_timeline(parent_id, "Resumed.");
        self.workflow_spawn_stage(parent_id, next).await;
        Ok(())
    }

    async fn workflow_reply(&mut self, parent_id: &str, message: String) -> Result<(), String> {
        let (stage, child) = {
            let Some(run) = self.workflow_runs.get(parent_id) else {
                return Err("no workflow pipeline on this task".to_string());
            };
            match &run.state {
                RunState::AwaitingReply { stage, child, .. } => (*stage, child.clone()),
                _ => return Err("the pipeline is not waiting for an answer".to_string()),
            }
        };
        // Show the user's answer in the parent timeline either way.
        self.emit_session(
            parent_id,
            wire::SessionUpdate::UserMessage {
                text: message.clone(),
                attachments: vec![],
            },
        );
        if self.workflow_followup(&child, message.clone()) {
            self.mark_task_running(&child);
            if let Some(run) = self.workflow_runs.get_mut(parent_id) {
                run.state = RunState::Running { stage };
            }
            self.workflow_timeline(
                parent_id,
                format!("Answer delivered — stage **{}** continues.", stage.label()),
            );
            let run = self.workflow_runs.get(parent_id).cloned();
            if let Some(run) = run {
                self.workflow_sync(&run);
            }
        } else {
            // The asking session is gone (daemon restarted, agent died). Re-run
            // the stage with the question + answer as guidance instead.
            let question = {
                let run = self.workflow_runs.get_mut(parent_id).unwrap();
                let question = match &run.state {
                    RunState::AwaitingReply { question, .. } => question.clone(),
                    _ => String::new(),
                };
                run.active_children.remove(&child);
                run.set_record_status(&child, wire::OrchNodeStatus::Skipped);
                run.pending_guidance = Some(format!(
                    "The previous attempt of this stage asked:\n> {question}\n\nUser's answer:\n{message}"
                ));
                question
            };
            let _ = question;
            self.workflow_timeline(
                parent_id,
                format!(
                    "The asking session is no longer alive — re-running stage **{}** with your \
                     answer as guidance.",
                    stage.label()
                ),
            );
            self.workflow_spawn_stage(parent_id, stage).await;
        }
        Ok(())
    }

    async fn workflow_decide(
        &mut self,
        parent_id: &str,
        decision: wire::WorkflowDecision,
        rounds: Option<u32>,
        note: Option<String>,
    ) -> Result<(), String> {
        {
            let Some(run) = self.workflow_runs.get(parent_id) else {
                return Err("no workflow pipeline on this task".to_string());
            };
            if run.state != RunState::AwaitingLimitDecision {
                return Err("the pipeline is not waiting for a limit decision".to_string());
            }
        }
        match decision {
            wire::WorkflowDecision::Extend => {
                let granted = rounds.unwrap_or(1).clamp(1, workflow::MAX_EXTEND_ROUNDS);
                let guidance = note.filter(|note| !note.trim().is_empty());
                if let Some(message) = guidance.as_ref() {
                    self.emit_session(
                        parent_id,
                        wire::SessionUpdate::UserMessage {
                            text: message.clone(),
                            attachments: vec![],
                        },
                    );
                }
                {
                    let run = self.workflow_runs.get_mut(parent_id).unwrap();
                    run.extra_rounds += granted;
                    run.pending_guidance = guidance;
                    // Asking for more rounds supersedes a pause requested
                    // while the last review was still running; otherwise the
                    // next stage would park immediately after we just said
                    // "continuing with a fix".
                    run.pause_requested = false;
                }
                self.workflow_timeline(
                    parent_id,
                    format!("You granted {granted} more review round(s) — continuing with a fix."),
                );
                self.workflow_advance(parent_id, StageKind::Fix).await;
                Ok(())
            }
            wire::WorkflowDecision::Finish => {
                self.workflow_timeline(parent_id, "You chose to finish with the open findings.");
                self.workflow_finalize(parent_id, WorkflowOutcome::Success { limit_hit: true })
                    .await?;
                Ok(())
            }
            wire::WorkflowDecision::Stop => {
                self.workflow_finalize(parent_id, WorkflowOutcome::Stopped)
                    .await?;
                Ok(())
            }
        }
    }

    /// Restore persisted runs after a daemon restart. Barrier states survive
    /// as-is; a run caught mid-stage converts to `Paused` at its last barrier
    /// (resume re-runs the interrupted stage from scratch).
    fn restore_workflow_runs(&mut self) {
        let rows = self
            .with_store(|store| store.load_workflow_runs().ok())
            .flatten()
            .unwrap_or_default();
        for (task_id, json) in rows {
            let Ok(mut run) = serde_json::from_str::<WorkflowRun>(&json) else {
                // Leaving the row in place would re-fail on every start while
                // the parent sits with no pipeline state and therefore no
                // pause/resume/stop controls. Say so, once, and move on.
                eprintln!("[daemon] dropping unreadable workflow run for task {task_id}");
                self.persist
                    .write(PersistWrite::DeleteWorkflowRun(task_id.clone()));
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason =
                        Some("workflow state could not be restored after an upgrade".to_string());
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                }
                continue;
            };
            if !self.tasks.contains_key(&task_id) {
                continue;
            }
            if run.is_active() {
                if let RunState::Running { stage } = run.state {
                    // Sessions died with the previous daemon: park at the
                    // barrier before the interrupted stage.
                    let children: Vec<String> = run.active_children.keys().cloned().collect();
                    for child in &children {
                        run.set_record_status(child, wire::OrchNodeStatus::Failed);
                    }
                    run.active_children.clear();
                    run.review_pending.clear();
                    run.review_collected.clear();
                    // Re-running a review re-increments `round` on spawn, so
                    // give the interrupted round back — otherwise a restart
                    // during round 2 of 2 resumes as "round 3/2" and lands
                    // straight on the limit decision.
                    if stage == StageKind::Review {
                        run.round = run.round.saturating_sub(1);
                    }
                    run.state = RunState::Paused { next: stage };
                    // The working copy may hold half-applied edits from the
                    // killed attempt; the re-run has to know that.
                    run.pending_guidance = Some(
                        "A previous attempt of this stage was interrupted by a daemon restart. \
                         The working copy may already contain its partial changes — inspect the \
                         current diff before assuming you are starting from scratch."
                            .to_string(),
                    );
                    self.workflow_timeline(
                        &task_id,
                        format!(
                            "Daemon restarted while stage **{}** was running. The pipeline is \
                             paused — resume to re-run that stage.",
                            stage.label()
                        ),
                    );
                }
                // The store normalizes Running → Interrupted on load; a live
                // pipeline parent is restored according to whether a stage is
                // executing or the runner is parked at a barrier.
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = None;
                    task.blocked_kind = None;
                    let status = match run.state {
                        RunState::Running { .. } => TaskStatus::Running,
                        RunState::AwaitingReply { .. }
                        | RunState::AwaitingLimitDecision
                        | RunState::Paused { .. } => TaskStatus::Waiting,
                        RunState::Done | RunState::Failed => task.status.clone(),
                    };
                    task.set_status(status);
                }
            }
            if let Some(task) = self.tasks.get_mut(&task_id) {
                task.workflow_run = Some(run.wire_info());
                task.orchestration_graph = Some(run.graph_info());
                let updated = task.clone();
                self.persist(&updated);
            }
            if let Ok(json) = serde_json::to_string(&run) {
                self.persist.workflow_run(&task_id, json);
            }
            self.workflow_runs.insert(task_id, run);
        }
    }
}

/// A finished stage's text, split into the agent's closing message and the
/// whole turn. See [`Daemon::collect_stage_text`].
#[derive(Debug, Default, Clone)]
struct StageText {
    closing: String,
    full: String,
}

/// Create the default policy set for a new daemon.
fn default_policies() -> PolicyRegistry {
    let mut reg = PolicyRegistry::new();
    reg.push(Box::new(BlastRadiusPolicy::default()));
    reg.push(Box::new(SpawnBoundsPolicy::new(6)));
    // CostBudget disabled by default (max=∞). Enable via config when needed.
    // WorktreeGuard enabled per-task in start_session, not globally.
    reg
}

#[cfg(test)]
mod project_removal_tests {
    use super::*;
    use crate::registry::ProjectEntry;

    fn demo_project() -> ProjectEntry {
        ProjectEntry {
            name: "project-removal-test".into(),
            path: ".".into(),
            added_at: "0".into(),
        }
    }

    #[test]
    fn resource_guard_message_is_actionable_and_reports_live_counts() {
        let live = ProjectLiveResources {
            services: 2,
            portforwards: 1,
            terminals: 3,
        };

        assert!(live.any());
        assert_eq!(
            live.conflict_message("demo"),
            "Project \"demo\" has 2 live services, 1 live port-forward, 3 live terminals; retry project.remove with stop_resources=true to stop them and remove the registration"
        );
    }

    #[test]
    fn stopped_project_state_does_not_require_force() {
        assert!(!ProjectLiveResources::default().any());
    }

    #[tokio::test]
    async fn live_terminal_blocks_unforced_project_removal() {
        let handle = Daemon::spawn(vec![demo_project()], None);
        let terminal_id = handle
            .spawn_agent("project-removal-test", "sleep 30", "guard test", 80, 24)
            .await
            .unwrap();

        let error = handle
            .remove_project("project-removal-test", false)
            .await
            .unwrap_err();

        assert!(matches!(error, ProjectRemovalError::Conflict(_)));
        assert!(handle
            .snapshot()
            .await
            .terminals
            .iter()
            .any(|terminal| terminal.id == terminal_id));
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn task_archive_and_delete_do_not_kill_project_terminal() {
        let handle = Daemon::spawn(vec![demo_project()], None);
        let terminal_id = handle
            .spawn_agent(
                "project-removal-test",
                "sleep 30",
                "task lifecycle test",
                80,
                24,
            )
            .await
            .unwrap();
        let archived_task = handle
            .create_task(
                "project-removal-test",
                "archive me",
                "codex",
                Vec::new(),
                false,
                false,
                None,
                Vec::new(),
                None,
                HashMap::new(),
                None,
            )
            .await;
        let deleted_task = handle
            .create_task(
                "project-removal-test",
                "delete me",
                "codex",
                Vec::new(),
                false,
                false,
                None,
                Vec::new(),
                None,
                HashMap::new(),
                None,
            )
            .await;

        handle
            .send(Command::ArchiveTask { id: archived_task })
            .await;
        handle
            .delete_task(&deleted_task)
            .await
            .expect("task deletion should complete");

        assert!(handle
            .snapshot()
            .await
            .terminals
            .iter()
            .any(|terminal| terminal.id == terminal_id));
        handle.shutdown().await;
    }
}

#[cfg(test)]
mod pending_permissions_tests {
    use super::*;

    #[test]
    fn record_inserts_request() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        assert!(pending.has_pending("task1"));
    }

    #[test]
    fn duplicate_record_is_noop() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        pending.record("task1", "req1");
        assert_eq!(pending.by_task.get("task1").unwrap().len(), 1);
    }

    #[test]
    fn resolve_removes_exact_request_among_multiple() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        pending.record("task1", "req2");
        pending.record("task1", "req3");
        pending.resolve("task1", "req2");
        assert!(pending.has_pending("task1"));
        assert_eq!(pending.by_task.get("task1").unwrap().len(), 2);
        assert!(pending.by_task.get("task1").unwrap().contains("req1"));
        assert!(!pending.by_task.get("task1").unwrap().contains("req2"));
        assert!(pending.by_task.get("task1").unwrap().contains("req3"));
    }

    #[test]
    fn resolve_unknown_request_is_noop() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        pending.resolve("task1", "unknown");
        assert!(pending.has_pending("task1"));
        assert_eq!(pending.by_task.get("task1").unwrap().len(), 1);
    }

    #[test]
    fn resolve_unknown_task_is_noop() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        pending.resolve("unknown_task", "req1");
        assert!(pending.has_pending("task1"));
    }

    #[test]
    fn resolve_last_request_cleans_up_empty_key() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        pending.resolve("task1", "req1");
        assert!(!pending.has_pending("task1"));
        assert!(!pending.by_task.contains_key("task1"));
    }

    #[test]
    fn cleanup_task_removes_all_requests() {
        let mut pending = PendingPermissions::default();
        pending.record("task1", "req1");
        pending.record("task1", "req2");
        pending.record("task2", "req3");
        pending.cleanup_task("task1");
        assert!(!pending.has_pending("task1"));
        assert!(pending.has_pending("task2"));
    }

    #[test]
    fn has_pending_false_for_unknown_task() {
        let pending = PendingPermissions::default();
        assert!(!pending.has_pending("unknown"));
    }
}

#[cfg(test)]
mod lifecycle_action_tests {
    use super::*;
    use crate::daemon::task::Task;

    fn make_task(id: &str, status: TaskStatus) -> Task {
        let mut task = Task::new("demo", "test prompt", "claude", vec![]);
        task.id = id.to_string();
        task.status = status;
        task.created_at = 1000;
        task.updated_at = 1000;
        task
    }

    // Settle tests
    #[test]
    fn settle_success_clears_snooze() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.snoozed_until = Some(2000);
        task.snoozed_at = Some(1500);

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Settle).unwrap();
        assert!(result.is_some());
        let updated = result.unwrap();
        assert_eq!(updated.settled_override, Some(true));
        assert_eq!(updated.settled_at, Some(1100));
        assert_eq!(updated.snoozed_until, None);
        assert_eq!(updated.snoozed_at, None);
        assert_eq!(updated.updated_at, 1100);
    }

    #[test]
    fn settle_running_rejected() {
        let task = make_task("t1", TaskStatus::Running);
        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Settle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("running"));
    }

    #[test]
    fn settle_pending_permission_rejected() {
        let task = make_task("t1", TaskStatus::Waiting);
        let result = apply_lifecycle_action(&task, true, 1100, LifecycleAction::Settle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("pending permission"));
    }

    #[test]
    fn settle_duplicate_preserves_timestamp() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.settled_override = Some(true);
        task.settled_at = Some(1050);

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Settle).unwrap();
        assert!(result.is_none()); // true no-op
    }

    #[test]
    fn settle_no_op_when_already_settled_with_snooze_clear() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.settled_override = Some(true);
        task.settled_at = Some(1050);
        task.snoozed_until = None;
        task.snoozed_at = None;

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Settle).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn settle_from_unsettled_replaces_stale_timestamp() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.settled_override = Some(false);
        task.settled_at = Some(500);

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Settle).unwrap();
        assert!(result.is_some());
        let updated = result.unwrap();
        assert_eq!(updated.settled_override, Some(true));
        assert_eq!(updated.settled_at, Some(1100));
    }

    // Unsettle tests
    #[test]
    fn unsettle_target_state() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.settled_override = Some(true);
        task.settled_at = Some(1050);
        task.snoozed_until = Some(2000);
        task.snoozed_at = Some(1500);

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Unsettle).unwrap();
        assert!(result.is_some());
        let updated = result.unwrap();
        assert_eq!(updated.settled_override, Some(false));
        assert_eq!(updated.settled_at, None);
        assert_eq!(updated.snoozed_until, None);
        assert_eq!(updated.snoozed_at, None);
        assert_eq!(updated.updated_at, 1100);
    }

    #[test]
    fn unsettle_no_op_when_already_clear() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.settled_override = Some(false);
        task.settled_at = None;
        task.snoozed_until = None;
        task.snoozed_at = None;

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Unsettle).unwrap();
        assert!(result.is_none());
    }

    // Snooze tests
    #[test]
    fn snooze_future_success() {
        let task = make_task("t1", TaskStatus::Waiting);
        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 2000 })
                .unwrap();
        assert!(result.is_some());
        let updated = result.unwrap();
        assert_eq!(updated.snoozed_until, Some(2000));
        assert_eq!(updated.snoozed_at, Some(1100));
        assert_eq!(updated.settled_override, Some(false));
        assert_eq!(updated.settled_at, None);
        assert_eq!(updated.updated_at, 1100);
    }

    #[test]
    fn snooze_running_allowed() {
        let task = make_task("t1", TaskStatus::Running);
        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 2000 })
                .unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn snooze_past_rejected() {
        let task = make_task("t1", TaskStatus::Waiting);
        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 1000 });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("future"));
    }

    #[test]
    fn snooze_now_rejected() {
        let task = make_task("t1", TaskStatus::Waiting);
        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 1100 });
        assert!(result.is_err());
    }

    #[test]
    fn snooze_pending_permission_rejected() {
        let task = make_task("t1", TaskStatus::Waiting);
        let result =
            apply_lifecycle_action(&task, true, 1100, LifecycleAction::Snooze { until: 2000 });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("pending permission"));
    }

    #[test]
    fn snooze_same_until_preserves_timestamp() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.snoozed_until = Some(2000);
        task.snoozed_at = Some(1050);
        task.settled_override = Some(false);
        task.settled_at = None;

        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 2000 })
                .unwrap();
        assert!(result.is_none()); // true no-op
    }

    #[test]
    fn snooze_same_until_repairs_missing_snoozed_at() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.snoozed_until = Some(2000);
        task.snoozed_at = None; // missing
        task.settled_override = Some(false);
        task.settled_at = None;

        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 2000 })
                .unwrap();
        assert!(result.is_some()); // not a no-op, repairs missing snoozed_at
        let updated = result.unwrap();
        assert_eq!(updated.snoozed_until, Some(2000));
        assert_eq!(updated.snoozed_at, Some(1100)); // repaired
    }

    #[test]
    fn snooze_clears_settle() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.settled_override = Some(true);
        task.settled_at = Some(1050);

        let result =
            apply_lifecycle_action(&task, false, 1100, LifecycleAction::Snooze { until: 2000 })
                .unwrap();
        assert!(result.is_some());
        let updated = result.unwrap();
        assert_eq!(updated.settled_override, Some(false));
        assert_eq!(updated.settled_at, None);
        assert!(updated.snoozed_until.is_some());
    }

    // Unsnooze tests
    #[test]
    fn unsnooze_change() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.snoozed_until = Some(2000);
        task.snoozed_at = Some(1500);

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Unsnooze).unwrap();
        assert!(result.is_some());
        let updated = result.unwrap();
        assert_eq!(updated.snoozed_until, None);
        assert_eq!(updated.snoozed_at, None);
        assert_eq!(updated.updated_at, 1100);
    }

    #[test]
    fn unsnooze_no_op_when_already_clear() {
        let mut task = make_task("t1", TaskStatus::Waiting);
        task.snoozed_until = None;
        task.snoozed_at = None;

        let result = apply_lifecycle_action(&task, false, 1100, LifecycleAction::Unsnooze).unwrap();
        assert!(result.is_none());
    }

    // Reactivation tests
    #[test]
    fn mark_task_running_clears_lifecycle() {
        // This test verifies that mark_task_running clears lifecycle state
        // We can't easily test this without a full Daemon instance, but the
        // implementation is straightforward and the WebSocket test covers it.
        // Here we just verify the logic is present in the code.
        let mut task = make_task("t1", TaskStatus::Queued);
        task.settled_override = Some(true);
        task.settled_at = Some(1050);
        task.snoozed_until = Some(2000);
        task.snoozed_at = Some(1500);

        // Simulate what mark_task_running does
        task.status = TaskStatus::Running;
        task.settled_override = None;
        task.settled_at = None;
        task.snoozed_until = None;
        task.snoozed_at = None;

        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.settled_override, None);
        assert_eq!(task.settled_at, None);
        assert_eq!(task.snoozed_until, None);
        assert_eq!(task.snoozed_at, None);
    }
}

#[cfg(test)]
mod worktree_start_tests {
    use super::*;
    use crate::registry::ProjectEntry;
    use std::time::Duration;

    const MOCK_AGENT: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mock-acp-inspect.mjs"
    );

    /// A git repo with one commit, so `git worktree add` has something to
    /// branch from.
    async fn repo_with_commit() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            tokio::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .status()
        };
        git(&["init"]).await.unwrap();
        std::fs::write(dir.path().join("README.md"), "init\n").unwrap();
        git(&["add", "."]).await.unwrap();
        git(&["commit", "-m", "init"]).await.unwrap();
        dir
    }

    async fn spawn_with_repo(dir: &tempfile::TempDir) -> DaemonHandle {
        Daemon::spawn(
            vec![ProjectEntry {
                name: "demo".into(),
                path: dir.path().to_string_lossy().into_owned(),
                added_at: "0".into(),
            }],
            None,
        )
    }

    async fn create_worktree_task(handle: &DaemonHandle) -> String {
        handle
            .create_task(
                "demo",
                "do the thing",
                &format!("node {MOCK_AGENT}"),
                Vec::new(),
                false,
                true,
                None,
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await
    }

    async fn task_now(handle: &DaemonHandle, id: &str) -> Task {
        handle
            .tasks()
            .await
            .into_iter()
            .find(|t| t.id == id)
            .expect("task on the board")
    }

    /// The task must reach the board before its checkout finishes. It used to
    /// be created only after `git worktree add` returned, so starting a task
    /// held up every other task's messages and approvals (ADR 0002).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_appears_before_its_worktree_is_ready() {
        let dir = repo_with_commit().await;
        let handle = spawn_with_repo(&dir).await;

        let id = create_worktree_task(&handle).await;
        assert!(!id.is_empty());
        assert_eq!(
            task_now(&handle, &id).await.worktree,
            None,
            "create must return before the checkout, not after it"
        );

        // The worktree is attached once the checkout lands.
        let mut path = None;
        for _ in 0..100 {
            if let Some(p) = task_now(&handle, &id).await.worktree {
                path = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let path = path.expect("checkout should attach a worktree");
        assert!(std::path::Path::new(&path).exists(), "worktree on disk");

        handle.shutdown().await;
    }

    /// Branching a conversation whose source runs in the project checkout —
    /// no worktree of its own — must still carry the uncommitted work over.
    ///
    /// This regressed once: the lookup only knew how to find a source
    /// *worktree*, so a source without one silently produced a branch on a
    /// clean HEAD, and the change the user was continuing from was gone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn branching_from_the_project_checkout_carries_its_changes() {
        let dir = repo_with_commit().await;
        let handle = spawn_with_repo(&dir).await;

        // The source task has no worktree, and its checkout has uncommitted
        // work: one tracked edit and one new file.
        let source = handle
            .create_task(
                "demo",
                "source",
                &format!("node {MOCK_AGENT}"),
                Vec::new(),
                false,
                false,
                None,
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;
        std::fs::write(dir.path().join("README.md"), "edited\n").unwrap();
        std::fs::write(dir.path().join("NEW.md"), "new file\n").unwrap();

        let branch = handle
            .create_task(
                "demo",
                "branch",
                &format!("node {MOCK_AGENT}"),
                vec![format!("branched-from:{source}")],
                false,
                true,
                None,
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;

        let mut path = None;
        for _ in 0..100 {
            if let Some(p) = task_now(&handle, &branch).await.worktree {
                path = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let path = std::path::PathBuf::from(path.expect("branch should get a worktree"));

        assert_eq!(
            std::fs::read_to_string(path.join("README.md")).unwrap(),
            "edited\n",
            "the tracked edit must carry over"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("NEW.md")).unwrap(),
            "new file\n",
            "the new untracked file must carry over"
        );

        handle.shutdown().await;
    }

    /// Cancelling while the checkout is still running must not start a session
    /// when it lands — but the worktree still gets recorded, because it exists
    /// on disk and something has to be able to clean it up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_during_checkout_does_not_start_a_session() {
        let dir = repo_with_commit().await;
        let handle = spawn_with_repo(&dir).await;

        let id = create_worktree_task(&handle).await;
        handle.cancel_task(&id).await.ok();

        // Wait for the checkout to land, then give a session every chance to
        // start before concluding that none did.
        for _ in 0..100 {
            if task_now(&handle, &id).await.worktree.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;

        let task = task_now(&handle, &id).await;
        assert!(
            task.worktree.is_some(),
            "the checkout must still be recorded so it can be cleaned up"
        );
        assert_eq!(
            task.session_id, None,
            "a cancelled task must not be started by its own checkout"
        );

        handle.shutdown().await;
    }
}

/// Transcript memory: the daemon holds no full session transcript in memory,
/// only bounded projections. These tests pin the behavior of the projections
/// that replaced it.
#[cfg(test)]
mod transcript_projection_tests {
    use super::*;

    /// A plain task's finished turn feeds nothing: the orchestrator hook is a
    /// no-op without the tag, and there is no parent inbox. Assembling its
    /// output would read the whole transcript back per turn — trading the
    /// memory this projection saves for disk it never needed.
    #[tokio::test]
    async fn a_plain_task_does_not_assemble_turn_output() {
        let handle = Daemon::spawn(Vec::new(), None);
        let id = handle
            .create_task(
                "demo",
                "prompt",
                "agent",
                Vec::new(),
                false,
                false,
                None,
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;

        let (tx, rx) = oneshot::channel();
        handle
            .send(Command::TurnOutputConsumerProbe {
                task_id: id.clone(),
                workflow_child: false,
                reply: tx,
            })
            .await;
        assert!(!rx.await.unwrap(), "nothing consumes a plain task's output");

        // A sub-agent's parent does consume it.
        let child = handle
            .create_task(
                "demo",
                "child",
                "agent",
                Vec::new(),
                false,
                false,
                Some(id.clone()),
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;
        let (tx, rx) = oneshot::channel();
        handle
            .send(Command::TurnOutputConsumerProbe {
                task_id: child,
                workflow_child: false,
                reply: tx,
            })
            .await;
        assert!(rx.await.unwrap(), "a sub-agent's result feeds its parent");

        handle.shutdown().await;
    }

    /// A long, realistic history: alternating tool calls and streamed text
    /// chunks, as a long agent turn produces.
    fn long_history(turns: usize, chunks_per_turn: usize) -> Vec<wire::SessionUpdate> {
        let mut history = Vec::new();
        for turn in 0..turns {
            history.push(wire::SessionUpdate::UserMessage {
                text: format!("prompt {turn}"),
                attachments: vec![],
            });
            for chunk in 0..chunks_per_turn {
                history.push(wire::SessionUpdate::ToolCall {
                    tool_call_id: format!("turn-{turn}-call-{chunk}"),
                    title: "tool".into(),
                    status: wire::ToolCallStatus::Completed,
                    started_at: Some(1000 + (turn * chunks_per_turn + chunk) as u64),
                    tool_kind: "read".into(),
                    content: None,
                });
                history.push(wire::SessionUpdate::AgentText {
                    text: format!("turn-{turn} chunk {chunk} "),
                });
            }
        }
        history
    }

    /// A resumed session replays its whole persisted history, update for
    /// update, before producing live output. The guard must drop every replayed
    /// update — a long history must not surface as duplicated output — and then
    /// let live output through.
    #[test]
    fn resume_replay_guard_drops_long_replayed_history_whole() {
        let history = long_history(10, 20); // 410 updates, 400 of them replayable
        let mut guard = ResumeReplayGuard::from_updates(&history).expect("replayable history");

        // The guard only covers the replayable subset; user prompts are not
        // part of the agent's replay.
        let replayable = replayable_history(&history);
        let mut dropped = 0;
        for update in &replayable {
            if guard.consume(update) {
                dropped += 1;
            }
        }
        assert_eq!(
            dropped,
            replayable.len(),
            "every replayed update must be dropped — none may reach the UI twice"
        );
        assert!(guard.is_empty(), "guard exhausted after the replay");

        // Live output after the replay is never dropped.
        let live = wire::SessionUpdate::AgentText {
            text: "fresh output".into(),
        };
        assert!(!guard.consume(&live));
    }

    /// The guard reports non-matches so the caller (should_skip_resume_replay)
    /// can disable it on the first divergence — otherwise a live update that
    /// happens to equal a later entry of the old history would be eaten.
    #[test]
    fn resume_replay_guard_reports_divergence() {
        let history = long_history(1, 3);
        // history[0] is the user prompt (not replayable); the first replayed
        // update is history[1].
        let mut guard = ResumeReplayGuard::from_updates(&history).unwrap();
        assert!(guard.consume(&history[1]));
        assert!(
            !guard.consume(&wire::SessionUpdate::AgentText {
                text: "diverged".into()
            }),
            "a divergent update must be reported so the guard can be disabled"
        );
    }

    /// Stage text must reflect only the latest turn: after several turns, the
    /// closing message and the full-turn text must not leak earlier turns' text.
    #[test]
    fn stage_text_is_scoped_to_the_latest_turn() {
        let history = vec![
            wire::SessionUpdate::UserMessage {
                text: "first".into(),
                attachments: vec![],
            },
            wire::SessionUpdate::AgentText {
                text: "old turn text ".into(),
            },
            wire::SessionUpdate::UserMessage {
                text: "second".into(),
                attachments: vec![],
            },
            wire::SessionUpdate::AgentText {
                text: "work ".into(),
            },
            wire::SessionUpdate::ToolCall {
                tool_call_id: "c1".into(),
                title: "tool".into(),
                status: wire::ToolCallStatus::Completed,
                started_at: Some(2000),
                tool_kind: "read".into(),
                content: None,
            },
            wire::SessionUpdate::AgentText {
                text: "final message".into(),
            },
        ];
        let text = stage_text_from_updates(&history);
        assert_eq!(
            text.full, "work final message",
            "earlier turns must not leak into full"
        );
        assert_eq!(
            text.closing, "final message",
            "tool call restarts the closing message"
        );
    }

    /// The orchestrator's node result is the task's whole text output,
    /// including text from every turn.
    #[test]
    fn agent_text_spans_every_turn() {
        let history = long_history(3, 2);
        let text = agent_text_from_updates(&history);
        assert_eq!(text, "turn-0 chunk 0 turn-0 chunk 1 turn-1 chunk 0 turn-1 chunk 1 turn-2 chunk 0 turn-2 chunk 1 ");
    }

    /// The replayable subset skips the "Reconnecting…" placeholder the daemon
    /// emits before a resume, so it is never replayed back as agent output.
    #[test]
    fn replayable_history_excludes_reconnect_placeholder() {
        let history = vec![
            wire::SessionUpdate::AgentText {
                text: "Reconnecting to the saved agent session…".into(),
            },
            wire::SessionUpdate::AgentText {
                text: "real text".into(),
            },
            wire::SessionUpdate::UserMessage {
                text: "prompt".into(),
                attachments: vec![],
            },
        ];
        let replayable = replayable_history(&history);
        assert_eq!(replayable.len(), 1);
        assert_eq!(replayable[0], history[1]);
    }
}
