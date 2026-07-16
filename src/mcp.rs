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
//!
//! Environment (set by the daemon when it starts the orchestrator session):
//! - `WF_ORCH_TASK`    — the orchestrator's task id (the inbox owner / parent).
//! - `WF_ORCH_PROJECT` — the project sub-agents run in.

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
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
        }
    ])
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
        other => Err(anyhow!("unknown tool: {other}")),
    }
}
