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
//! Environment (set by the daemon when it starts the session; legacy daemons
//! set the `WF_ORCH_*` spellings instead):
//! - `WF_TASK`    — the session's task id (the inbox owner / parent).
//! - `WF_PROJECT` — the project this session is scoped to. Unset falls back to
//!   the registered project containing the working directory, so the bridge can
//!   also be configured once globally and run outside the daemon.
//! - `WF_MODE`    — `orchestrator` to expose the spawn/inbox/workflow tools on
//!   top of the runtime ones. Anything else (or unset) means a single session.

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
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
    let is_orchestrator =
        std::env::var("WF_MODE").as_deref() == Ok("orchestrator") || parent_task_env_is_orch();
    let parent_task = std::env::var("WF_TASK")
        .or_else(|_| std::env::var("WF_ORCH_TASK"))
        .ok();
    if is_orchestrator && parent_task.is_none() {
        return Err(anyhow!(
            "WF_TASK not set — an orchestrator bridge is spawned by the daemon"
        ));
    }
    let parent_task = parent_task.unwrap_or_default();
    let project = std::env::var("WF_PROJECT")
        .or_else(|_| std::env::var("WF_ORCH_PROJECT"))
        .ok()
        .filter(|p| !p.trim().is_empty())
        .or_else(project_from_cwd)
        .unwrap_or_default();

    log(&format!(
        "starting: parent_task={parent_task} project={project} mode={}",
        if is_orchestrator {
            "orchestrator"
        } else {
            "single"
        }
    ));
    // Serve MCP immediately and connect to the daemon lazily on the first tool
    // call. If we connected up-front and the daemon were briefly unreachable,
    // the whole server would die before advertising any tools — leaving the
    // orchestrator with no spawn_agent/read_inbox at all.
    let client = DaemonClient {
        ws: None,
        next_id: 1,
    };
    serve_stdio(client, parent_task, project, is_orchestrator).await
}

/// A legacy daemon sets `WF_ORCH_TASK` but not `WF_MODE`; treat that as an
/// orchestrator session so the old env still yields the orchestrator tools.
fn parent_task_env_is_orch() -> bool {
    std::env::var("WF_MODE").is_err() && std::env::var("WF_ORCH_TASK").is_ok()
}

/// Fall back to the registered project whose path contains the working
/// directory. This is what lets the bridge be configured once, globally
/// (`claude mcp add --scope user`, no env), instead of per project: an agent
/// started inside a project's checkout scopes itself to that project. The
/// deepest matching path wins, so a project nested inside another resolves to
/// the inner one.
fn project_from_cwd() -> Option<String> {
    let cwd = std::env::current_dir().ok()?.canonicalize().ok()?;
    let roots: Vec<(String, PathBuf)> = crate::registry::list_projects()
        .ok()?
        .into_iter()
        .filter_map(|p| {
            Path::new(&p.path)
                .canonicalize()
                .ok()
                .map(|root| (p.name, root))
        })
        .collect();
    pick_project(&roots, &cwd)
}

/// The deepest registered root containing `cwd`. Deepest rather than first so a
/// project nested inside another resolves to the inner one; a task worktree
/// under `<project>/.worktrees/<task>` resolves to its project.
fn pick_project(roots: &[(String, PathBuf)], cwd: &Path) -> Option<String> {
    roots
        .iter()
        .filter(|(_, root)| cwd.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(name, _)| name.clone())
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
async fn serve_stdio(
    mut client: DaemonClient,
    parent_task: String,
    project: String,
    is_orchestrator: bool,
) -> Result<()> {
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
                    "name": "warpforge",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            })),
            "tools/list" => Some(json!({ "tools": tool_defs(is_orchestrator) })),
            "tools/call" => Some(
                match handle_tool_call(
                    &mut client,
                    &parent_task,
                    &project,
                    is_orchestrator,
                    req.get("params"),
                )
                .await
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

fn tool_defs(is_orchestrator: bool) -> Value {
    let mut tools: Vec<Value> = vec![
        json!({
        "name": "list_runtime",
             "description": "List the project's dev services and port-forwards with their \
                live status and allocated ports. Use this to discover what is running \
                (names, ports, URLs) before reading logs or restarting a service. Each \
                entry's logSeq is a log cursor you can pass as `after` to read_service_logs \
                / read_portforward_logs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    }
                }
            }
        }),
        json!({
        "name": "read_service_logs",
             "description": "Read a window of a dev service's retained stdout/stderr log \
                lines. Use to diagnose why a service failed, inspect request output, or \
                tail recent output. Fetch is non-destructive. Lines carry UTC timestamps \
                by default; filter runs over the whole buffer (grep | tail) and context \
                adds surrounding lines (grep -C). Poll new lines cheaply by passing the \
                previous response's nextSeq as `after`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "service": {
                        "type": "string",
                        "description": "Service name as declared in .warpforge.yaml (see list_runtime)."
                    },
                    "after": {
                        "type": "integer",
                        "description": "Monotonic log cursor (a sequence number). Return lines with seq >= after (start from this cursor). Start with 0 to read from the oldest retained line, then pass the `nextSeq` from a previous response to cheaply poll for new lines. Stable even as the ring buffer drops old lines."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of lines to return (newest kept). Defaults to 100."
                    },
                    "filter": {
                        "type": "string",
                        "description": "Optional case-insensitive substring. Runs over the whole retained buffer, then the newest `limit` matching lines are kept (grep | tail)."
                    },
                    "context": {
                        "type": "integer",
                        "description": "Include N lines of surrounding context before and after each filter match (like grep -C). Ignored when no filter is given. Defaults to 0."
                    },
                    "timestamps": {
                        "type": "boolean",
                        "description": "Prepend a UTC timestamp to each line (like kubectl --timestamps). Defaults to true. Set false to return raw lines."
                    }
                },
                "required": ["service"]
            }
        }),
        json!({
            "name": "read_portforward_logs",
            "description": "Read a window of a port-forward's retained log lines.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "name": {
                        "type": "string",
                        "description": "Port-forward name as declared in .warpforge.yaml (see list_runtime)."
                    },
                    "after": {
                        "type": "integer",
                        "description": "Monotonic log cursor (a sequence number). Return lines with seq >= after (start from this cursor). Start with 0 to read from the oldest retained line, then pass the `nextSeq` from a previous response to cheaply poll for new lines. Stable even as the ring buffer drops old lines."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of lines to return (newest kept). Defaults to 100."
                    },
                    "filter": {
                        "type": "string",
                        "description": "Optional case-insensitive substring. Runs over the whole retained buffer, then the newest `limit` matching lines are kept (grep | tail)."
                    },
                    "context": {
                        "type": "integer",
                        "description": "Include N lines of surrounding context before and after each filter match (like grep -C). Ignored when no filter is given. Defaults to 0."
                    },
                    "timestamps": {
                        "type": "boolean",
                        "description": "Prepend a UTC timestamp to each line (like kubectl --timestamps). Defaults to true. Set false to return raw lines."
                    }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "service_start",
            "description": "Start a dev service (async; returns immediately, the service \
                starts in the background). If it is already running this is a no-op. \
                Read its progress with read_service_logs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "service": {
                        "type": "string",
                        "description": "Service name as declared in .warpforge.yaml."
                    }
                },
                "required": ["service"]
            }
        }),
        json!({
            "name": "service_stop",
            "description": "Stop a dev service (async; returns immediately).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "service": {
                        "type": "string",
                        "description": "Service name as declared in .warpforge.yaml."
                    }
                },
                "required": ["service"]
            }
        }),
        json!({
            "name": "service_restart",
            "description": "Restart a dev service (async; returns immediately). Use when \
                a service crashed or you changed its config and want a clean start. \
                Read its progress with read_service_logs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "service": {
                        "type": "string",
                        "description": "Service name as declared in .warpforge.yaml."
                    }
                },
                "required": ["service"]
            }
        }),
        json!({
            "name": "portforward_start",
            "description": "Start a port-forward (async; returns immediately).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "name": {
                        "type": "string",
                        "description": "Port-forward name as declared in .warpforge.yaml."
                    }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "portforward_stop",
            "description": "Stop a port-forward (async; returns immediately).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name. Defaults to the current project."
                    },
                    "name": {
                        "type": "string",
                        "description": "Port-forward name as declared in .warpforge.yaml."
                    }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "create_task",
            "description": "Create a new task on the board without auto-running an agent. Task is queued (Queued) for manual start. Use for follow-up work discovered during implementation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project name. Defaults to the current project."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Full task prompt / goal."
                    },
                    "agent": {
                        "type": "string",
                        "description": "Agent to run: claude, codex, opencode. Defaults to the current session's agent."
                    },
                    "workflow": {
                        "type": "string",
                        "description": "Optional workflow id (e.g. review-loop) to run the task through a pipeline."
                    }
                },
                "required": ["prompt"]
            }
        }),
        json!({
            "name": "memory_store",
            "description": "Persist a durable fact to Warpforge shared memory (visible to all harnesses). \
                Prefer over CLAUDE.md/AGENTS.md for cross-session knowledge.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The fact/decision/preference/gotcha to remember."
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["global", "project"],
                        "description": "global (all projects) or project (this project). Defaults to project when project_id is set, else global."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["fact", "decision", "preference", "gotcha", "note"],
                        "description": "Kind of memory. Defaults to note."
                    },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional tags for filtering."
                    },
                    "project_id": {
                        "type": "string",
                        "description": "Project id for project scope. Defaults to the current project."
                    }
                },
                "required": ["content"]
            }
        }),
        json!({
            "name": "memory_search",
            "description": "Search Warpforge shared memory (full-text, relevance-ranked). Returns matching \
                memories with highlighted snippets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search terms."
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["all", "global", "project"],
                        "description": "Which scope to search. Defaults to all enabled scopes."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10, max 100)."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["fts", "hybrid"],
                        "description": "fts only in v1; hybrid behaves the same."
                    }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "memory_list",
            "description": "List stored memories (most recently updated first), optionally filtered by scope and kind.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["all", "global", "project"],
                        "description": "Which scope to list. Defaults to all enabled scopes."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["fact", "decision", "preference", "gotcha", "note"],
                        "description": "Filter to one kind."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 100)."
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Skip this many results (default 0)."
                    }
                }
            }
        }),
        json!({
            "name": "memory_update",
            "description": "Rewrite an existing memory's content (by id, returned from memory_search/memory_list).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Memory id." },
                    "content": { "type": "string", "description": "New content." }
                },
                "required": ["id", "content"]
            }
        }),
        json!({
            "name": "memory_delete",
            "description": "Permanently delete a memory (by id). Explicit user/agent action; nothing is auto-deleted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Memory id." }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "memory_stats",
            "description": "Report memory counts and which scopes are active, so you can adapt your prompts.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ];

    if is_orchestrator {
        if let Value::Array(orch) = orchestrator_tool_defs() {
            tools.extend(orch);
        }
    }
    Value::Array(tools)
}

fn orchestrator_tool_defs() -> Value {
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
                orchestrator. By default all waiting, done, blocked, and \
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
const INACTIVE_AGENT_STATUSES: &[&str] = &["waiting", "done", "blocked", "interrupted"];
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

    // No bound project scope: a requested project would let a session reach a
    // project it does not own. Refuse rather than fall back to the caller's arg.
    match requested {
        None => Ok(None),
        Some(_) => Err(anyhow!(
            "this session is not bound to a project; cannot target another project"
        )),
    }
}

/// Parse a tool's optional `limit`, clamped to the daemon's u32 window size,
/// defaulting to 100 lines so an omitted limit cannot dump the whole buffer.
fn tool_limit(args: &Value) -> u32 {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|v| v.min(u32::MAX as u64) as u32)
        .unwrap_or(100)
}

/// Fetch a window of retained log lines from the daemon and render them. The
/// `after` index and `limit` window the raw buffer first; `filter`, when set,
/// keeps only case-insensitively matching lines from that window.
async fn read_logs(
    client: &mut DaemonClient,
    method: &str,
    project: &str,
    kind: &str,
    key_field: &str,
    key: &str,
    args: &Value,
) -> Result<String> {
    // `after` is a monotonic seq cursor ("start from this seq"), not a buffer
    // index. Polling with the previous response's `nextSeq` makes reads
    // nearly free regardless of how many lines the ring has since dropped.
    let after = args.get("after").and_then(Value::as_u64).unwrap_or(0);
    let limit = tool_limit(args);
    let filter = args
        .get("filter")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let context = args.get("context").and_then(Value::as_u64).unwrap_or(0) as usize;
    let timestamps = args
        .get("timestamps")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    // grep|tail and grep -C must see the whole retained buffer, so when a
    // filter or context is requested we fetch without a limit; otherwise honor
    // the window limit. Either way the daemon returns aligned `at` timestamps.
    let fetch_limit: Option<u32> = if filter.is_some() || context > 0 {
        None
    } else {
        Some(limit)
    };
    let mut params = json!({ "project": project, "after": after, "limit": fetch_limit });
    params[key_field] = json!(key);
    let result = client.request(method, params).await?;
    let lines: Vec<String> = result
        .get("lines")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|l| l.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let at: Vec<u64> = result
        .get("at")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    let next_seq: u64 = result
        .get("nextSeq")
        .and_then(Value::as_u64)
        .unwrap_or(after);

    let body = render_log_selection(&lines, &at, filter.as_deref(), context, limit, timestamps);
    if body.is_empty() {
        return Ok(match filter {
            Some(f) => format!("[{kind}:{key}] no lines match filter '{f}'"),
            None => format!("[{kind}:{key}] no matching logs"),
        });
    }
    let count = body.lines().count();
    let poll = if next_seq > 0 {
        format!("\n\ncursor: pass `after: {next_seq}` to read only lines newer than these.")
    } else {
        String::new()
    };
    Ok(format!(
        "[{kind}:{key}] {count} line(s){poll}\n```\n{body}\n```"
    ))
}

/// Pure selection used by [`read_logs`] (and unit-tested here): filter the
/// whole buffer (grep), expand each match by `context` (grep -C), then keep the
/// newest `limit` lines (tail). Returns rendered lines with optional UTC
/// timestamps, or an empty string when nothing survives.
fn render_log_selection(
    lines: &[String],
    at: &[u64],
    filter: Option<&str>,
    context: usize,
    limit: u32,
    timestamps: bool,
) -> String {
    let n = lines.len();
    let mut keep: Vec<usize> = (0..n).collect();
    if let Some(filter) = filter.filter(|s| !s.is_empty()) {
        let needle = filter.to_lowercase();
        let matches: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.to_lowercase().contains(&needle))
            .map(|(i, _)| i)
            .collect();
        if matches.is_empty() {
            return String::new();
        }
        // Expand each match by `context` and merge overlapping spans.
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for m in matches {
            let lo = m.saturating_sub(context);
            let hi = (m + 1 + context).min(n);
            match spans.last_mut() {
                Some((_, last_hi)) if lo <= *last_hi => *last_hi = (*last_hi).max(hi),
                _ => spans.push((lo, hi)),
            }
        }
        keep = spans.into_iter().flat_map(|(lo, hi)| lo..hi).collect();
    }
    if keep.len() > limit as usize {
        keep = keep[keep.len() - limit as usize..].to_vec();
    }
    keep.into_iter()
        .map(|i| {
            let text = &lines[i];
            if timestamps {
                let ts = at.get(i).copied().map(fmt_utc).unwrap_or_default();
                format!("[{ts}] {text}")
            } else {
                text.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Format epoch millis as `YYYY-MM-DD HH:MM:SSZ` in UTC. Self-contained so we
/// avoid pulling a chrono-style dependency into the daemon. The `Z` is not
/// decoration: without it a reader in a non-UTC zone reads the offset from
/// their own clock as the daemon lagging behind.
fn fmt_utc(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 -> (year, month, day).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Confirm a service is declared for the project before claiming a control
/// dispatch succeeded (start/stop/restart RPCs return null unconditionally).
async fn ensure_service(client: &mut DaemonClient, project: &str, service: &str) -> Result<()> {
    let result = client
        .request("runtime.list", json!({ "project": project }))
        .await?;
    let declared = result
        .get("services")
        .and_then(Value::as_array)
        .is_some_and(|svcs| {
            svcs.iter()
                .any(|s| s.get("name").and_then(Value::as_str) == Some(service))
        });
    if declared {
        Ok(())
    } else {
        Err(anyhow!(
            "no service '{service}' is declared for project '{project}' (see list_runtime)"
        ))
    }
}

/// Like [`ensure_service`] but for a port-forward name.
async fn ensure_portforward(client: &mut DaemonClient, project: &str, name: &str) -> Result<()> {
    let result = client
        .request("runtime.list", json!({ "project": project }))
        .await?;
    let declared = result
        .get("portforwards")
        .and_then(Value::as_array)
        .is_some_and(|pfs| {
            pfs.iter()
                .any(|pf| pf.get("name").and_then(Value::as_str) == Some(name))
        });
    if declared {
        Ok(())
    } else {
        Err(anyhow!(
            "no port-forward '{name}' is declared for project '{project}' (see list_runtime)"
        ))
    }
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
    is_orchestrator: bool,
    params: Option<&Value>,
) -> Result<String> {
    let params = params.ok_or_else(|| anyhow!("missing params"))?;
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "list_runtime" => {
            let scoped = scoped_project(&args, project)?;
            let Some(project) = scoped else {
                return Err(anyhow!("a project is required to list the runtime"));
            };
            let result = client
                .request("runtime.list", json!({ "project": project }))
                .await?;
            json_text(&result)
        }
        "read_service_logs" => {
            let scoped = scoped_project(&args, project)?;
            let Some(project) = scoped else {
                return Err(anyhow!("a project is required to read service logs"));
            };
            let service = args
                .get("service")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'service' is required"))?;
            read_logs(
                client,
                "service.logs",
                &project,
                "service",
                "service",
                service,
                &args,
            )
            .await
        }
        "read_portforward_logs" => {
            let scoped = scoped_project(&args, project)?;
            let Some(project) = scoped else {
                return Err(anyhow!("a project is required to read port-forward logs"));
            };
            let name = args
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'name' is required"))?;
            read_logs(
                client,
                "portforward.logs",
                &project,
                "portforward",
                "name",
                name,
                &args,
            )
            .await
        }
        "service_start" | "service_stop" | "service_restart" => {
            let scoped = scoped_project(&args, project)?;
            let Some(project) = scoped else {
                return Err(anyhow!("a project is required to control a service"));
            };
            let service = args
                .get("service")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'service' is required"))?;
            ensure_service(client, &project, service).await?;
            let method = match name {
                "service_start" => "service.start",
                "service_stop" => "service.stop",
                _ => "service.restart",
            };
            client
                .request(method, json!({ "project": project, "service": service }))
                .await?;
            Ok(format!(
                "{method} dispatched for '{service}' in project '{project}'. \
                 It runs asynchronously — read read_service_logs to follow its progress."
            ))
        }
        "portforward_start" | "portforward_stop" => {
            let scoped = scoped_project(&args, project)?;
            let Some(project) = scoped else {
                return Err(anyhow!("a project is required to control a port-forward"));
            };
            let pf_name = args
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'name' is required"))?;
            ensure_portforward(client, &project, pf_name).await?;
            let method = match name {
                "portforward_start" => "portforward.start",
                _ => "portforward.stop",
            };
            client
                .request(method, json!({ "project": project, "name": pf_name }))
                .await?;
            Ok(format!(
                "{method} dispatched for '{pf_name}' in project '{project}'."
            ))
        }
        "create_task" => {
            let prompt = args
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'prompt' is required"))?;
            let proj = args
                .get("project")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .or_else(|| {
                    let p = project.trim();
                    if p.is_empty() {
                        None
                    } else {
                        Some(p.to_string())
                    }
                })
                .ok_or_else(|| anyhow!("project is required"))?;
            let agent = args
                .get("agent")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string());
            let workflow = args
                .get("workflow")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty());
            let mut params = json!({ "project": proj, "prompt": prompt, "start": false });
            if let Some(a) = agent {
                params["agent"] = json!(a);
            }
            if let Some(w) = workflow {
                params["workflow"] = json!(w);
            }
            let result = client.request("task.create", params).await?;
            let id = result.get("taskId").and_then(Value::as_str).unwrap_or("?");
            Ok(format!("Created task {id}"))
        }
        "memory_store" => {
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'content' is required"))?;
            // Lenient project scoping: an explicit project_id wins, else the
            // bridge's bound project, else none (global). Deliberately not the
            // erroring `scoped_project` helper — global-scoped stores must work
            // even when the session is not bound to a project.
            let project_id = args
                .get("project_id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .or_else(|| {
                    let p = project.trim();
                    if p.is_empty() {
                        None
                    } else {
                        Some(p.to_string())
                    }
                });
            let scope = args
                .get("scope")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);
            let kind = args
                .get("kind")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);
            let tags = args
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .filter(|t| !t.is_empty());
            let mut params = json!({ "content": content });
            if let Some(v) = scope {
                params["scope"] = json!(v);
            }
            if let Some(v) = kind {
                params["kind"] = json!(v);
            }
            if let Some(v) = tags {
                params["tags"] = json!(v);
            }
            if let Some(v) = project_id {
                params["project_id"] = json!(v);
            }
            let result = client.request("memory.store", params).await?;
            json_text(&result)
        }
        "memory_search" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'query' is required"))?;
            let mut params = json!({ "query": query });
            if let Some(v) = args
                .get("scope")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                params["scope"] = json!(v);
            }
            if let Some(v) = args.get("limit").and_then(Value::as_u64) {
                params["limit"] = json!(v.min(u32::MAX as u64));
            }
            if let Some(v) = args
                .get("mode")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                params["mode"] = json!(v);
            }
            let result = client.request("memory.search", params).await?;
            json_text(&result)
        }
        "memory_list" => {
            let mut params = json!({});
            if let Some(v) = args
                .get("scope")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                params["scope"] = json!(v);
            }
            if let Some(v) = args
                .get("kind")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                params["kind"] = json!(v);
            }
            if let Some(v) = args.get("limit").and_then(Value::as_u64) {
                params["limit"] = json!(v.min(u32::MAX as u64));
            }
            if let Some(v) = args.get("offset").and_then(Value::as_u64) {
                params["offset"] = json!(v.min(u32::MAX as u64));
            }
            let result = client.request("memory.list", params).await?;
            json_text(&result)
        }
        "memory_update" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'id' is required"))?;
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'content' is required"))?;
            let result = client
                .request("memory.update", json!({ "id": id, "content": content }))
                .await?;
            json_text(&result)
        }
        "memory_delete" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("'id' is required"))?;
            let result = client.request("memory.delete", json!({ "id": id })).await?;
            json_text(&result)
        }
        "memory_stats" => {
            let result = client.request("memory.stats", json!({})).await?;
            json_text(&result)
        }
        _ if !is_orchestrator => Err(anyhow!(
            "tool '{name}' is only available in an orchestrator session"
        )),
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
    fn cwd_resolves_to_the_deepest_registered_project() {
        let roots = vec![
            ("outer".to_string(), PathBuf::from("/w/outer")),
            (
                "inner".to_string(),
                PathBuf::from("/w/outer/packages/inner"),
            ),
            ("sibling".to_string(), PathBuf::from("/w/outer-sibling")),
        ];

        let pick = |cwd: &str| pick_project(&roots, Path::new(cwd));
        assert_eq!(pick("/w/outer/src").as_deref(), Some("outer"));
        assert_eq!(
            pick("/w/outer/packages/inner/src").as_deref(),
            Some("inner")
        );
        // A task worktree lives under its project root.
        assert_eq!(pick("/w/outer/.worktrees/t_1").as_deref(), Some("outer"));
        // A sibling sharing a name prefix is not a parent directory.
        assert_eq!(pick("/w/outer-sibling/src").as_deref(), Some("sibling"));
        assert_eq!(pick("/tmp/unregistered"), None);
    }

    #[test]
    fn lifecycle_tools_advertise_stop_and_destructive_cleanup() {
        let tools = tool_defs(true);
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
    fn single_mode_hides_orchestrator_tools_but_ships_core_tools() {
        let core = tool_defs(false)
            .as_array()
            .expect("tool definitions")
            .clone();
        let core_names: Vec<&str> = core
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();
        for tool in [
            "list_runtime",
            "read_service_logs",
            "read_portforward_logs",
            "service_start",
            "service_stop",
            "service_restart",
            "portforward_start",
            "portforward_stop",
        ] {
            assert!(
                core_names.contains(&tool),
                "single mode must advertise {tool}"
            );
        }
        for tool in [
            "spawn_agent",
            "read_inbox",
            "spawn_workflow",
            "decide_workflow",
        ] {
            assert!(
                !core_names.contains(&tool),
                "single mode must NOT advertise {tool}"
            );
        }
    }

    #[test]
    fn project_scope_cannot_escape_the_orchestrator_project() {
        assert_eq!(
            scoped_project(&json!({}), "demo").unwrap(),
            Some("demo".to_string())
        );
        assert!(scoped_project(&json!({ "project": "other" }), "demo").is_err());
    }

    #[test]
    fn unbound_session_cannot_target_a_project_by_argument() {
        // No bound project scope: requesting a project by argument must fail,
        // so a project-less session cannot reach another project's runtime.
        assert_eq!(scoped_project(&json!({}), "").unwrap(), None);
        assert!(scoped_project(&json!({ "project": "other" }), "").is_err());
    }

    #[test]
    fn tool_limit_defaults_to_100_and_clamps_to_u32() {
        assert_eq!(tool_limit(&json!({})), 100);
        assert_eq!(tool_limit(&json!({ "limit": 5 })), 5);
        assert_eq!(tool_limit(&json!({ "limit": 5_000_000_000u64 })), u32::MAX);
    }

    /// Filter runs over the WHOLE buffer, then the newest `limit` are kept
    /// (grep | tail) — not the first `limit`, and not a window-then-filter.
    #[test]
    fn filter_then_tail_keeps_newest_matches_across_the_whole_buffer() {
        let mut lines: Vec<String> = (0..50).map(|i| format!("line {i}")).collect();
        lines[0] = "ERROR early".into();
        lines[1] = "ERROR early2".into();
        lines[42] = "ERROR late".into();
        lines[43] = "ERROR late2".into();
        let at: Vec<u64> = lines.iter().map(|_| 0).collect();
        let body = render_log_selection(&lines, &at, Some("ERROR"), 0, 3, false);
        assert_eq!(body, "ERROR early2\nERROR late\nERROR late2");
    }

    #[test]
    fn context_expands_around_each_match_and_overlapping_spans_merge() {
        let mut lines: Vec<String> = (0..20).map(|i| format!("line {i}")).collect();
        lines[5] = "ERR at 5".into();
        lines[7] = "ERR at 7".into();
        let at: Vec<u64> = lines.iter().map(|_| 0).collect();
        // matches at 5 and 7, context 2 -> spans [3,8) and [5,10) merge to [3,10)
        let body = render_log_selection(&lines, &at, Some("ERR"), 2, 100, false);
        assert_eq!(
            body,
            "line 3\nline 4\nERR at 5\nline 6\nERR at 7\nline 8\nline 9"
        );
    }

    #[test]
    fn no_match_returns_empty_and_timestamps_prepend_utc() {
        let lines = vec!["a".to_string(), "b".to_string()];
        let at = vec![0u64, 1_700_000_000_000u64];
        assert_eq!(
            render_log_selection(&lines, &at, Some("zzz"), 0, 100, true),
            ""
        );
        let body = render_log_selection(&lines, &at, Some("b"), 0, 100, true);
        assert!(body.starts_with("[2023-11-14 "), "got: {body}");
        assert!(body.ends_with("] b"), "got: {body}");
        // timestamps=false returns the raw line
        assert_eq!(
            render_log_selection(&lines, &at, Some("b"), 0, 100, false),
            "b"
        );
    }

    #[test]
    fn fmt_utc_renders_epoch() {
        assert_eq!(fmt_utc(0), "1970-01-01 00:00:00Z");
        assert_eq!(fmt_utc(86_400_000), "1970-01-02 00:00:00Z");
    }
}
