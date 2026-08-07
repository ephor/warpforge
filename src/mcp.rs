//! MCP (Model Context Protocol) stdio server exposing orchestration tools to an
//! orchestrator agent.
//!
//! The orchestrator agent spawns this binary as an MCP server subprocess (wired
//! via the ACP `mcpServers` config). It speaks MCP JSON-RPC 2.0 over stdio to
//! the agent and connects *back* to the running warpforge daemon over the
//! daemon's WebSocket API (endpoint + token from `~/.warpforge/daemon.json`),
//! translating tool calls into daemon commands.
//!
//! Tools:
//! - `spawn_agent(agent, task)` — dispatch a sub-agent asynchronously; returns
//!   immediately. The result lands in the orchestrator's inbox on completion.
//! - `read_inbox()` — drain finished sub-agent results.
//! - `message_agent(task_id, message)` — send a follow-up message to a running
//!   or idle sub-agent, continuing the same session.
//! - `list_agents(project?)` — list this orchestrator's child sessions.
//! - `stop_agent(task_id)` — hard-stop one owned child session while retaining
//!   history. Also stops an owned workflow pipeline.
//! - `cleanup_agents(max_age_seconds?, dry_run?, include_active?)` — permanently
//!   remove selected child sessions and their task history.
//! - `spawn_workflow(workflow_id, goal, agent)` — dispatch a deterministic
//!   multi-stage pipeline (plan/implement/review/fix) as a child of this
//!   orchestrator, same lifecycle as `spawn_agent`.
//! - `pause_workflow(task_id)` / `resume_workflow(task_id, note?)` — soft-pause
//!   an owned pipeline at its next stage boundary, or resume it.
//! - `answer_workflow(task_id, message)` — answer a pipeline stage's pending
//!   question (`need_user_input`).
//! - `decide_workflow(task_id, decision, rounds?, note?)` — decide what an
//!   owned pipeline does once it has exhausted its review rounds.
//!
//! Environment (set by the daemon when it starts the orchestrator session):
//! - `WF_ORCH_TASK`    — the orchestrator's task id (the inbox owner / parent).
//! - `WF_ORCH_PROJECT` — the project sub-agents run in.

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// MCP protocol version we implement.
const MCP_VERSION: &str = "2024-11-05";

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Entry point for the hidden `wf __mcp-orchestrator` subcommand.
pub async fn run() -> Result<()> {
    let parent_task = std::env::var("WF_ORCH_TASK")
        .context("WF_ORCH_TASK not set — this binary is spawned by the daemon")?;
    let project = std::env::var("WF_ORCH_PROJECT").unwrap_or_default();

    log(&format!(
        "starting: parent_task={parent_task} project={project}"
    ));
    // Serve MCP immediately and connect to the daemon lazily on the first tool
    // call. If we connected up-front and the daemon were briefly unreachable,
    // the whole server would die before advertising any tools — leaving the
    // orchestrator with no spawn_agent/read_inbox at all.
    let client = DaemonClient {
        ws: None,
        next_id: 1,
    };
    serve_stdio(client, parent_task, project).await
}

/// Diagnostics to stderr (the ACP agent may forward this to the daemon's
/// `[acp <id> stderr]`). Set WF_MCP_DEBUG=1 for verbose lines.
fn log(msg: &str) {
    eprintln!("[wf-mcp] {msg}");
}

/// Read the published daemon endpoint, connect, and authenticate.
async fn connect_daemon() -> Result<WsStream> {
    let path = dirs::home_dir()
        .unwrap_or_default()
        .join(".warpforge")
        .join("daemon.json");
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {} — is the daemon running?", path.display()))?;
    let endpoint: Value = serde_json::from_str(&raw)?;
    let url = endpoint
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("daemon.json missing url"))?;
    let token = endpoint.get("token").and_then(|v| v.as_str()).unwrap_or("");

    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("connecting to daemon at {url}"))?;
    if !token.is_empty() {
        ws.send(Message::Text(json!({ "auth": token }).to_string()))
            .await?;
    }
    Ok(ws)
}

/// A minimal request/response client over the daemon WebSocket. Tool calls are
/// serialized (one stdin request at a time), so a simple send-then-read-until-
/// matching-id loop is sufficient — we never subscribe, so no event stream.
/// The connection is established lazily and re-established if it drops.
struct DaemonClient {
    ws: Option<WsStream>,
    next_id: u64,
}

impl DaemonClient {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        if self.ws.is_none() {
            self.ws = Some(connect_daemon().await?);
        }
        match self.request_inner(method, params).await {
            Ok(v) => Ok(v),
            Err(e) => {
                // Drop a broken connection so the next call reconnects.
                self.ws = None;
                Err(e)
            }
        }
    }

    async fn request_inner(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let ws = self
            .ws
            .as_mut()
            .ok_or_else(|| anyhow!("no daemon connection"))?;
        let frame = json!({ "id": id, "method": method, "params": params });
        ws.send(Message::Text(frame.to_string())).await?;

        while let Some(msg) = ws.next().await {
            let text = match msg? {
                Message::Text(t) => t.to_string(),
                Message::Ping(p) => {
                    ws.send(Message::Pong(p)).await?;
                    continue;
                }
                Message::Close(_) => return Err(anyhow!("daemon closed the connection")),
                _ => continue,
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue; // an event or a stale reply — ignore
            }
            if let Some(err) = v.get("error") {
                return Err(anyhow!("daemon error: {err}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(anyhow!("daemon connection ended before replying"))
    }
}

/// The MCP stdio loop: newline-delimited JSON-RPC 2.0 with the agent.
async fn serve_stdio(mut client: DaemonClient, parent_task: String, project: String) -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");

        // Notifications (no id) get no response.
        let result: Option<Value> = match method {
            "initialize" => Some(json!({
                "protocolVersion": MCP_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "warpforge-orchestrator",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            })),
            "tools/list" => Some(json!({ "tools": tool_defs() })),
            "tools/call" => Some(
                match handle_tool_call(&mut client, &parent_task, &project, req.get("params")).await
                {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(e) => json!({
                        "content": [{ "type": "text", "text": format!("Error: {e}") }],
                        "isError": true,
                    }),
                },
            ),
            "ping" => Some(json!({})),
            _ => None,
        };

        if let (Some(id), Some(result)) = (id, result) {
            let frame = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            stdout.write_all(frame.to_string().as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "spawn_agent",
            "description": "Dispatch a sub-agent to work on a task asynchronously. \
                Returns immediately with a task id; the sub-agent runs in its own \
                session and its result is delivered to your inbox when it finishes \
                — you will be prompted to call read_inbox. Spawn several in one turn \
                to run them in parallel.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": {
                        "type": "string",
                        "description": "Which agent to run: e.g. claude, codex, opencode."
                    },
                    "task": {
                        "type": "string",
                        "description": "The full instruction/prompt for the sub-agent."
                    }
                },
                "required": ["agent", "task"]
            }
        },
        {
            "name": "read_inbox",
            "description": "Collect finished sub-agent results delivered since you \
                last checked. Drains the inbox (each result is returned once).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "message_agent",
            "description": "Send a follow-up message to a previously spawned sub-agent, \
                continuing the same session. The agent sees the full conversation \
                history and can respond in context. Use this instead of spawn_agent \
                when you want to continue a conversation with an agent you already \
                started. Returns immediately; the agent's response will be delivered \
                to your inbox when it finishes — then call read_inbox.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task id returned by spawn_agent or a previous message_agent call."
                    },
                    "message": {
                        "type": "string",
                        "description": "The follow-up message / instruction to send to the agent."
                    }
                },
                "required": ["task_id", "message"]
            }
        },
        {
            "name": "list_agents",
            "description": "List sub-agent sessions spawned by this orchestrator. \
                The result is scoped to your current orchestrator task, and can \
                optionally be narrowed to a project.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the orchestrator's project."
                    }
                }
            }
        },
        {
            "name": "stop_agent",
            "description": "Hard-stop one sub-agent session owned by this orchestrator. \
                The task remains in history so its result and context are not lost.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Task id returned by spawn_agent or list_agents."
                    }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "cleanup_agents",
            "description": "Permanently remove child agent sessions owned by this \
                orchestrator. By default all idle, needs_review, done, blocked, and \
                interrupted tasks are selected: each is hard-stopped first, then its \
                task record and session history are deleted. Running and queued \
                sessions are skipped unless include_active=true. Returns a JSON report.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "max_age_seconds": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Optional minimum age since last update; defaults to 0 (all eligible children)."
                    },
                    "dry_run": {
                        "type": "boolean",
                        "description": "When true, report candidates without stopping or deleting them. Defaults to false."
                    },
                    "include_active": {
                        "type": "boolean",
                        "description": "Also allow running/queued sessions to be stopped and deleted. Defaults to false."
                    },
                    "project": {
                        "type": "string",
                        "description": "Optional project name; must match the orchestrator project."
                    }
                }
            }
        },
        {
            "name": "spawn_workflow",
            "description": "Dispatch a deterministic multi-stage pipeline (plan → implement → \
                review ⇄ fix) as a child of this orchestrator, instead of a single sub-agent. \
                Use this for changes that benefit from an independent review pass; for \
                straightforward tasks prefer spawn_agent — a pipeline costs several times the \
                tokens and wall-clock. Returns immediately with a task id; the pipeline's final \
                outcome is delivered to your inbox like a sub-agent's, and its live progress \
                (current stage, review round, whether it is waiting on you) shows up in \
                list_agents under workflowRun. It has no agent session of its own — do not use \
                message_agent on it; use answer_workflow / decide_workflow instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workflow_id": {
                        "type": "string",
                        "description": "Id of a workflow template available to the project (see the project's .warpforge/workflows/ or ask the user which pipelines exist)."
                    },
                    "goal": {
                        "type": "string",
                        "description": "The objective for the pipeline's first stage — what should be planned/implemented."
                    },
                    "agent": {
                        "type": "string",
                        "description": "Default agent for the pipeline's stages: e.g. \"claude\", \"codex\", \"opencode\"."
                    }
                },
                "required": ["workflow_id", "goal", "agent"]
            }
        },
        {
            "name": "pause_workflow",
            "description": "Soft-pause a workflow pipeline owned by this orchestrator. The \
                running stage finishes its current turn; the next stage does not start until \
                resume_workflow is called.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Task id returned by spawn_workflow or list_agents."
                    }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "resume_workflow",
            "description": "Resume a paused workflow pipeline owned by this orchestrator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Task id returned by spawn_workflow or list_agents."
                    },
                    "note": {
                        "type": "string",
                        "description": "Optional guidance delivered to the next stage as extra context."
                    }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "answer_workflow",
            "description": "Answer a workflow pipeline stage's pending question. Only valid \
                while the pipeline is waiting on a question (list_agents shows \
                workflowRun.waiting.kind == \"question\"). The message is forwarded to the \
                stage session that asked.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Task id returned by spawn_workflow or list_agents."
                    },
                    "message": {
                        "type": "string",
                        "description": "The answer to the stage's question."
                    }
                },
                "required": ["task_id", "message"]
            }
        },
        {
            "name": "decide_workflow",
            "description": "Decide what a workflow pipeline does once it has exhausted its \
                review ⇄ fix rounds with open findings (list_agents shows \
                workflowRun.waiting.kind == \"limit\").",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Task id returned by spawn_workflow or list_agents."
                    },
                    "decision": {
                        "type": "string",
                        "enum": ["extend", "finish", "stop"],
                        "description": "extend: grant more review rounds and continue. finish: accept the pipeline's work as-is with the open findings noted. stop: stop the pipeline."
                    },
                    "rounds": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5,
                        "description": "For decision=extend: how many extra review rounds to grant. Defaults to 1."
                    },
                    "note": {
                        "type": "string",
                        "description": "For decision=extend: optional guidance delivered to the next fix stage."
                    }
                },
                "required": ["task_id", "decision"]
            }
        }
    ])
}

const DEFAULT_CLEANUP_MAX_AGE_SECONDS: u64 = 0;
const INACTIVE_AGENT_STATUSES: &[&str] =
    &["idle", "needs_review", "done", "blocked", "interrupted"];
const ACTIVE_AGENT_STATUSES: &[&str] = &["running", "queued"];

/// Keep MCP calls within the project that owns the orchestrator session. The
/// optional argument is useful for tests and for older daemons that do not set
/// WF_ORCH_PROJECT, but cannot be used to escape a non-empty environment scope.
fn scoped_project(args: &Value, orchestrator_project: &str) -> Result<Option<String>> {
    let requested = match args.get("project") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::String(_)) => None,
        Some(_) => return Err(anyhow!("'project' must be a string")),
    };

    if !orchestrator_project.is_empty() {
        if let Some(requested) = requested.as_deref() {
            if requested != orchestrator_project {
                return Err(anyhow!(
                    "project '{requested}' is outside the orchestrator project '{orchestrator_project}'"
                ));
            }
        }
        return Ok(Some(orchestrator_project.to_string()));
    }

    Ok(requested)
}

async fn list_owned_agents(
    client: &mut DaemonClient,
    parent_task: &str,
    project: Option<&str>,
) -> Result<Value> {
    client
        .request(
            "orchestrator.listAgents",
            json!({
                "parent_task_id": parent_task,
                "project": project,
            }),
        )
        .await
}

fn agent_values(result: &Value) -> Result<Vec<Value>> {
    result
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow!("daemon returned an invalid orchestrator.listAgents response"))
}

/// Confirm `task_id` is a child of this orchestrator before letting a
/// workflow-control tool touch it — otherwise one orchestrator session could
/// pause/answer/decide a pipeline it does not own.
///
/// TODO(perf, known debt): this fetches and filters the daemon's *entire*
/// task list (`orchestrator.listAgents` → `Command::Tasks` clones every task
/// in every project) just to check one id's `parent_task_id`, then the
/// caller makes a second round trip for the actual `workflow.*` RPC. Cheap in
/// absolute terms (local WebSocket, in-memory clone) but wasteful, and it
/// scales with total daemon task count, not with this orchestrator's work.
/// Deliberately left as-is rather than fixed under time pressure — real fix
/// is a new, purely additive lookup (e.g. `Command::TaskParent { id, reply }`
/// doing an O(1) `self.tasks.get`), NOT touching `workflow.pause/resume/
/// reply/decide` themselves, since desktop UI already depends on those.
async fn ensure_owned(
    client: &mut DaemonClient,
    parent_task: &str,
    project: &str,
    args: &Value,
    task_id: &str,
) -> Result<()> {
    let scoped = scoped_project(args, project)?;
    let result = list_owned_agents(client, parent_task, scoped.as_deref()).await?;
    let agents = agent_values(&result)?;
    let owned = agents
        .iter()
        .any(|agent| agent.get("id").and_then(Value::as_str) == Some(task_id));
    if owned {
        Ok(())
    } else {
        Err(anyhow!(
            "task {task_id} is not a pipeline owned by this orchestrator"
        ))
    }
}

fn json_text(value: &Value) -> Result<String> {
    serde_json::to_string_pretty(value).context("encoding MCP JSON result")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn handle_tool_call(
    client: &mut DaemonClient,
    parent_task: &str,
    project: &str,
    params: Option<&Value>,
) -> Result<String> {
    let params = params.ok_or_else(|| anyhow!("missing params"))?;
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "spawn_agent" => {
            let agent = args
                .get("agent")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'agent' is required"))?;
            let task = args
                .get("task")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'task' is required"))?;
            let result = client
                .request(
                    "task.create",
                    json!({
                        "project": project,
                        "prompt": task,
                        "agent": agent,
                        "tags": ["orchestrator", "subagent"],
                        "include_runtime_context": true,
                        "worktree": false,
                        "parent_task_id": parent_task,
                    }),
                )
                .await?;
            let child = result
                .get("taskId")
                .and_then(Value::as_str)
                .unwrap_or("(unknown)");
            Ok(format!(
                "Dispatched sub-agent '{agent}' as task {child}. It runs asynchronously; \
                 you will be notified when its result is waiting — then call read_inbox."
            ))
        }
        "read_inbox" => {
            let result = client
                .request(
                    "orchestrator.readInbox",
                    json!({ "parent_task_id": parent_task }),
                )
                .await?;
            let results = result
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if results.is_empty() {
                return Ok("Inbox empty — no sub-agent results waiting.".into());
            }
            let mut out = String::new();
            for r in &results {
                let agent = r.get("agent").and_then(Value::as_str).unwrap_or("?");
                let child = r.get("childId").and_then(Value::as_str).unwrap_or("?");
                let ok = r.get("success").and_then(Value::as_bool).unwrap_or(false);
                let prompt = r.get("prompt").and_then(Value::as_str).unwrap_or("");
                let output = r.get("output").and_then(Value::as_str).unwrap_or("");
                let status = if ok { "completed" } else { "FAILED" };
                out.push_str(&format!(
                    "── sub-agent {agent} (task {child}) {status}\n\
                     Task: {prompt}\n\
                     Result:\n{output}\n\n"
                ));
            }
            Ok(out)
        }
        "message_agent" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'task_id' is required"))?;
            let message = args
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'message' is required"))?;
            client
                .request(
                    "session.prompt",
                    json!({
                        "task_id": task_id,
                        "text": message,
                    }),
                )
                .await?;
            Ok(format!(
                "Message sent to sub-agent task {task_id}. It runs asynchronously; \
                 you will be notified when its result is waiting — then call read_inbox."
            ))
        }
        "list_agents" => {
            let scoped = scoped_project(&args, project)?;
            let result = list_owned_agents(client, parent_task, scoped.as_deref()).await?;
            json_text(&result)
        }
        "stop_agent" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| anyhow!("'task_id' is required"))?;
            let scoped = scoped_project(&args, project)?;
            let result = list_owned_agents(client, parent_task, scoped.as_deref()).await?;
            let agents = agent_values(&result)?;
            let Some(agent) = agents
                .iter()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some(task_id))
            else {
                return Err(anyhow!(
                    "task {task_id} is not a sub-agent owned by this orchestrator"
                ));
            };

            client
                .request("task.cancel", json!({ "task_id": task_id }))
                .await?;
            json_text(&json!({
                "taskId": task_id,
                "stopped": true,
                "task": agent,
            }))
        }
        "cleanup_agents" => {
            let max_age_seconds = match args.get("max_age_seconds") {
                None | Some(Value::Null) => DEFAULT_CLEANUP_MAX_AGE_SECONDS,
                Some(value) => value
                    .as_u64()
                    .ok_or_else(|| anyhow!("'max_age_seconds' must be a non-negative integer"))?,
            };
            let dry_run = match args.get("dry_run") {
                None | Some(Value::Null) => false,
                Some(value) => value
                    .as_bool()
                    .ok_or_else(|| anyhow!("'dry_run' must be a boolean"))?,
            };
            let include_active = match args.get("include_active") {
                None | Some(Value::Null) => false,
                Some(value) => value
                    .as_bool()
                    .ok_or_else(|| anyhow!("'include_active' must be a boolean"))?,
            };
            let scoped = scoped_project(&args, project)?;
            let result = list_owned_agents(client, parent_task, scoped.as_deref()).await?;
            let agents = agent_values(&result)?;
            let now = now_secs();
            let mut selected = Vec::new();
            let mut skipped = Vec::new();

            for agent in agents {
                let task_id = agent.get("id").and_then(Value::as_str).unwrap_or("");
                let status = agent.get("status").and_then(Value::as_str).unwrap_or("");
                let updated_at = agent
                    .get("updatedAt")
                    .and_then(Value::as_u64)
                    .or_else(|| agent.get("createdAt").and_then(Value::as_u64));
                let Some(updated_at) = updated_at else {
                    skipped.push(json!({
                        "taskId": task_id,
                        "status": status,
                        "reason": "missing_timestamp",
                    }));
                    continue;
                };
                let age_seconds = now.saturating_sub(updated_at);

                let eligible_status = INACTIVE_AGENT_STATUSES.contains(&status)
                    || (include_active && ACTIVE_AGENT_STATUSES.contains(&status));
                if !eligible_status {
                    let reason = if ACTIVE_AGENT_STATUSES.contains(&status) {
                        "active"
                    } else {
                        "unknown_status"
                    };
                    skipped.push(json!({
                        "taskId": task_id,
                        "status": status,
                        "ageSeconds": age_seconds,
                        "reason": reason,
                    }));
                    continue;
                }
                if age_seconds < max_age_seconds {
                    skipped.push(json!({
                        "taskId": task_id,
                        "status": status,
                        "ageSeconds": age_seconds,
                        "reason": "too_new",
                    }));
                    continue;
                }

                selected.push(json!({
                    "taskId": task_id,
                    "status": status,
                    "ageSeconds": age_seconds,
                }));
            }

            let mut deleted = Vec::new();
            let mut errors = Vec::new();
            if !dry_run {
                for candidate in &selected {
                    let Some(task_id) = candidate.get("taskId").and_then(Value::as_str) else {
                        errors.push(json!({
                            "task": candidate,
                            "error": "candidate has no task id",
                        }));
                        continue;
                    };
                    if let Err(error) = client
                        .request("task.cancel", json!({ "task_id": task_id }))
                        .await
                    {
                        errors.push(json!({
                            "taskId": task_id,
                            "phase": "stop",
                            "error": error.to_string(),
                        }));
                        continue;
                    }
                    match client
                        .request("task.delete", json!({ "task_id": task_id }))
                        .await
                    {
                        Ok(_) => deleted.push(candidate.clone()),
                        Err(error) => errors.push(json!({
                            "taskId": task_id,
                            "phase": "delete",
                            "error": error.to_string(),
                        })),
                    }
                }
            }

            json_text(&json!({
                "parentTaskId": parent_task,
                "project": scoped,
                "maxAgeSeconds": max_age_seconds,
                "dryRun": dry_run,
                "includeActive": include_active,
                "selected": selected,
                "deleted": deleted,
                "skipped": skipped,
                "errors": errors,
            }))
        }
        "spawn_workflow" => {
            let workflow_id = args
                .get("workflow_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'workflow_id' is required"))?;
            let goal = args
                .get("goal")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'goal' is required"))?;
            let agent = args
                .get("agent")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'agent' is required"))?;
            let result = client
                .request(
                    "task.create",
                    json!({
                        "project": project,
                        "prompt": goal,
                        "agent": agent,
                        "tags": ["orchestrator", "workflow-subagent"],
                        "include_runtime_context": true,
                        "worktree": false,
                        "parent_task_id": parent_task,
                        "workflow": workflow_id,
                    }),
                )
                .await?;
            let child = result
                .get("taskId")
                .and_then(Value::as_str)
                .unwrap_or("(unknown)");
            Ok(format!(
                "Dispatched workflow '{workflow_id}' as task {child}. It runs asynchronously \
                 through its own plan/implement/review/fix stages; you will be notified when \
                 its result is waiting — then call read_inbox. Check list_agents for its \
                 progress and whether it needs an answer (answer_workflow) or a decision \
                 (decide_workflow)."
            ))
        }
        "pause_workflow" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'task_id' is required"))?;
            ensure_owned(client, parent_task, project, &args, task_id).await?;
            client
                .request("workflow.pause", json!({ "task": task_id }))
                .await?;
            Ok(format!(
                "Paused workflow pipeline {task_id} at its next stage boundary."
            ))
        }
        "resume_workflow" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'task_id' is required"))?;
            ensure_owned(client, parent_task, project, &args, task_id).await?;
            let note = args.get("note").and_then(Value::as_str);
            client
                .request("workflow.resume", json!({ "task": task_id, "note": note }))
                .await?;
            Ok(format!("Resumed workflow pipeline {task_id}."))
        }
        "answer_workflow" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'task_id' is required"))?;
            let message = args
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'message' is required"))?;
            ensure_owned(client, parent_task, project, &args, task_id).await?;
            client
                .request(
                    "workflow.reply",
                    json!({ "task": task_id, "message": message }),
                )
                .await?;
            Ok(format!(
                "Answer sent to workflow pipeline {task_id}. It runs asynchronously; you will \
                 be notified when its result is waiting — then call read_inbox."
            ))
        }
        "decide_workflow" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'task_id' is required"))?;
            let decision = args
                .get("decision")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("'decision' is required"))?;
            if !["extend", "finish", "stop"].contains(&decision) {
                return Err(anyhow!("'decision' must be one of: extend, finish, stop"));
            }
            let rounds = match args.get("rounds") {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_u64()
                        .ok_or_else(|| anyhow!("'rounds' must be an integer"))?,
                ),
            };
            let note = args.get("note").and_then(Value::as_str);
            ensure_owned(client, parent_task, project, &args, task_id).await?;
            client
                .request(
                    "workflow.decide",
                    json!({
                        "task": task_id,
                        "decision": decision,
                        "rounds": rounds,
                        "note": note,
                    }),
                )
                .await?;
            Ok(format!(
                "Decision '{decision}' applied to workflow pipeline {task_id}."
            ))
        }
        other => Err(anyhow!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_tools_advertise_stop_and_destructive_cleanup() {
        let tools = tool_defs();
        let definitions = tools.as_array().expect("tool definitions");
        let names: Vec<&str> = definitions
            .iter()
            .filter_map(|definition| definition.get("name").and_then(Value::as_str))
            .collect();

        assert!(names.contains(&"stop_agent"));
        assert!(names.contains(&"cleanup_agents"));
        assert!(!names.contains(&"kill_agent"));
        assert_eq!(DEFAULT_CLEANUP_MAX_AGE_SECONDS, 0);

        let cleanup = definitions
            .iter()
            .find(|definition| definition["name"] == "cleanup_agents")
            .expect("cleanup tool definition");
        let description = cleanup["description"].as_str().unwrap_or_default();
        assert!(description.contains("Permanently remove"));
        assert!(description.contains("task record and session history are deleted"));
    }

    #[test]
    fn project_scope_cannot_escape_the_orchestrator_project() {
        assert_eq!(
            scoped_project(&json!({}), "demo").unwrap(),
            Some("demo".to_string())
        );
        assert!(scoped_project(&json!({ "project": "other" }), "demo").is_err());
    }
}
