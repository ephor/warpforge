use anyhow::Result;

use warpforge_protocol as wire;

pub(crate) const ORCHESTRATOR_SYSTEM: &str = "\
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
pub(crate) const RUNTIME_MCP_SYSTEM: &str = "\
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
pub(crate) const MEMORY_SYSTEM: &str = "\
You run inside Warpforge. For durable cross-session knowledge use memory_store / \
memory_search / memory_list (shared across Claude, Codex, opencode). Prefer this \
over writing CLAUDE.md/AGENTS.md. Check memory_stats for active scopes.";

/// The warpforge MCP bridge config handed to every ACP session so the agent
/// can call back into this daemon (read service logs, restart a service,
/// and — for orchestrator-chat sessions — spawn_agent / read_inbox). The
/// `WF_MODE` env lets the bridge expose the orchestrator-only tools only to
/// sessions that are actually orchestrators.
pub(crate) fn mcp_servers(
    task_id: &str,
    project: &str,
    is_orchestrator: bool,
) -> Vec<serde_json::Value> {
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

/// Cap the diff we feed a text-generation agent. A commit message or PR body
/// only needs the shape of the change, not every line of a huge diff, and an
/// oversized prompt is slow and can blow the model's context.
pub(crate) const TEXTGEN_DIFF_LIMIT: usize = 48 * 1024;

pub(crate) const COMMIT_INSTRUCTION: &str = "\
Write a git commit message for the changes below (the output of `git diff HEAD`). \
Use Conventional Commits: a concise subject line in the imperative mood, at most \
72 characters, then a blank line and a short body only if it adds information the \
subject cannot. Reply with ONLY the commit message — no code fences, no preamble, \
no closing remarks.";

pub(crate) const PR_INSTRUCTION: &str = "\
Write a GitHub pull-request description for the branch's outgoing commits (listed \
below, with their combined diff). Output the PR title as the first line, then a \
blank line, then a Markdown body summarizing what changed and why. Reply with ONLY \
the title and body — no code fences, no preamble.";

pub(crate) const TASK_TITLE_INSTRUCTION: &str = "\
Given the task prompt below, write a short title for this task. The title must be \
a single imperative line, at most 60 characters, plain text, no quotes, no trailing \
period, no markdown. Reply with ONLY the title — no code fences, no preamble, no \
closing remarks.";

pub(crate) const ENHANCE_PROMPT_INSTRUCTION: &str = "\
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
pub(crate) async fn build_textgen_prompt(
    repo: &str,
    kind: wire::TextGenKind,
    message: Option<&str>,
) -> Result<String, String> {
    pub(crate) async fn git_out(repo: &str, args: &[&str]) -> Result<String, String> {
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

    pub(crate) fn clamp(mut diff: String) -> String {
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
            let info = crate::daemon::diff::push_info(repo)
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
        wire::TextGenKind::Handoff => crate::daemon::handoff::cold_prompt(message.unwrap_or("")),
    }
}
