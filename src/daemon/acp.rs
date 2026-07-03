//! ACP (Agent Client Protocol) client: the daemon speaks ACP *as a client* to
//! an agent process (Claude Code, Codex, any conforming agent) over its stdio,
//! newline-delimited JSON-RPC 2.0.
//!
//! One agent binary is the abstraction — there is no per-agent code. A task's
//! `agent` resolves to a command; we spawn it, `initialize`, `session/new`,
//! then `session/prompt`, and stream the agent's `session/update`
//! notifications back as [`AcpUpdate`]s. The agent's own requests
//! (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`)
//! are handled here: file ops directly, permission by surfacing it to the UI
//! and replying once the human answers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

/// An update from an agent session, forwarded to the daemon actor as
/// `(task_id, AcpUpdate)`.
#[derive(Debug, Clone)]
pub enum AcpUpdate {
    SessionStarted { session_id: String },
    AgentText(String),
    AgentThought(String),
    ToolCall { id: String, title: String, status: String },
    FileEdit { path: String },
    PermissionRequest { request_id: String, title: String, options: Vec<String> },
    TurnEnded { stop_reason: String },
    Error(String),
}

pub enum AcpCommand {
    Prompt(String),
    AnswerPermission { request_id: String, outcome: String },
    Cancel,
}

/// Handle the actor keeps per task to drive its agent session.
#[derive(Clone)]
pub struct AcpHandle {
    cmd_tx: mpsc::UnboundedSender<AcpCommand>,
}

impl AcpHandle {
    pub fn prompt(&self, text: String) {
        let _ = self.cmd_tx.send(AcpCommand::Prompt(text));
    }
    pub fn answer(&self, request_id: String, outcome: String) {
        let _ = self.cmd_tx.send(AcpCommand::AnswerPermission { request_id, outcome });
    }
    pub fn cancel(&self) {
        let _ = self.cmd_tx.send(AcpCommand::Cancel);
    }
}

struct PendingPerm {
    /// The agent's original JSON-RPC request id, needed to reply.
    agent_id: Value,
    /// Client outcome label ("allow" / "allow_always" / "deny") -> ACP optionId.
    options: HashMap<String, String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// Spawn an agent process and its ACP session. Returns immediately; the
/// `initialize` → `session/new` → initial `session/prompt` handshake runs in
/// the background and streams updates over `updates`.
pub fn spawn_acp_session(
    task_id: String,
    command: String,
    cwd: String,
    initial_prompt: String,
    updates: mpsc::UnboundedSender<(String, AcpUpdate)>,
) -> anyhow::Result<AcpHandle> {
    let mut child = Command::new("sh")
        .args(["-c", &command])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;

    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<AcpCommand>();

    // Writer: serialize outgoing frames (ndjson) to the agent's stdin.
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = out_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let perms: Arc<Mutex<HashMap<String, PendingPerm>>> = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicU64::new(1));

    // Reader: route agent → daemon frames.
    {
        let pending = Arc::clone(&pending);
        let perms = Arc::clone(&perms);
        let updates = updates.clone();
        let out_tx = out_tx.clone();
        let task_id = task_id.clone();
        let cwd = cwd.clone();
        tokio::spawn(async move {
            let _child = child; // hold so kill_on_drop fires when the reader ends
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(msg): Result<Value, _> = serde_json::from_str(line) else { continue };

                // Response to one of our requests?
                if msg.get("id").is_some()
                    && (msg.get("result").is_some() || msg.get("error").is_some())
                    && msg.get("method").is_none()
                {
                    if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg.clone());
                        }
                    }
                    continue;
                }

                let Some(method) = msg.get("method").and_then(|m| m.as_str()) else { continue };
                let id = msg.get("id").cloned();
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

                match method {
                    "session/update" => {
                        if let Some(update) = parse_update(&params) {
                            let _ = updates.send((task_id.clone(), update));
                        }
                    }
                    "session/request_permission" => {
                        let Some(agent_id) = id else { continue };
                        let (title, options, map) = parse_permission(&params);
                        let request_id = compact_id(&agent_id);
                        perms.lock().unwrap().insert(
                            request_id.clone(),
                            PendingPerm { agent_id, options: map },
                        );
                        let _ = updates.send((
                            task_id.clone(),
                            AcpUpdate::PermissionRequest { request_id, title, options },
                        ));
                        // reply is deferred until the human answers
                    }
                    "fs/read_text_file" => {
                        let path = params.get("path").and_then(|p| p.as_str()).unwrap_or("");
                        let content = std::fs::read_to_string(resolve(&cwd, path)).unwrap_or_default();
                        if let Some(id) = id {
                            let _ = out_tx.send(
                                json!({"jsonrpc":"2.0","id":id,"result":{"content":content}}).to_string(),
                            );
                        }
                    }
                    "fs/write_text_file" => {
                        let path = params.get("path").and_then(|p| p.as_str()).unwrap_or("");
                        let content = params.get("content").and_then(|c| c.as_str()).unwrap_or("");
                        let _ = std::fs::write(resolve(&cwd, path), content);
                        if let Some(id) = id {
                            let _ = out_tx.send(json!({"jsonrpc":"2.0","id":id,"result":null}).to_string());
                        }
                    }
                    _ => {
                        if let Some(id) = id {
                            let _ = out_tx.send(
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}}).to_string(),
                            );
                        }
                    }
                }
            }
            let _ = updates.send((
                task_id.clone(),
                AcpUpdate::TurnEnded { stop_reason: "disconnected".into() },
            ));
        });
    }

    // Driver: handshake, initial prompt, then the command loop.
    {
        let pending = Arc::clone(&pending);
        let perms = Arc::clone(&perms);
        let next_id = Arc::clone(&next_id);
        let updates = updates.clone();
        tokio::spawn(async move {
            rpc(&out_tx, &pending, &next_id, "initialize", json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } }
            }))
            .await;

            let session_id = rpc(&out_tx, &pending, &next_id, "session/new", json!({
                "cwd": cwd, "mcpServers": []
            }))
            .await
            .and_then(|v| {
                v.get("result")?.get("sessionId")?.as_str().map(String::from)
            })
            .unwrap_or_else(|| "unknown".into());

            let _ = updates.send((task_id.clone(), AcpUpdate::SessionStarted { session_id: session_id.clone() }));

            send_prompt(&out_tx, &pending, &next_id, &updates, &task_id, &session_id, initial_prompt);

            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    AcpCommand::Prompt(text) => {
                        send_prompt(&out_tx, &pending, &next_id, &updates, &task_id, &session_id, text);
                    }
                    AcpCommand::AnswerPermission { request_id, outcome } => {
                        if let Some(p) = perms.lock().unwrap().remove(&request_id) {
                            let result = match p.options.get(&outcome) {
                                Some(opt) => json!({ "outcome": { "outcome": "selected", "optionId": opt } }),
                                None => json!({ "outcome": { "outcome": "cancelled" } }),
                            };
                            let _ = out_tx.send(
                                json!({"jsonrpc":"2.0","id":p.agent_id,"result":result}).to_string(),
                            );
                        }
                    }
                    AcpCommand::Cancel => {
                        let _ = out_tx.send(
                            json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session_id}}).to_string(),
                        );
                        break;
                    }
                }
            }
        });
    }

    Ok(AcpHandle { cmd_tx })
}

/// Send a `session/prompt` in the background and emit a TurnEnded when it
/// resolves — prompts don't block the command loop.
#[allow(clippy::too_many_arguments)]
fn send_prompt(
    out_tx: &mpsc::UnboundedSender<String>,
    pending: &Pending,
    next_id: &Arc<AtomicU64>,
    updates: &mpsc::UnboundedSender<(String, AcpUpdate)>,
    task_id: &str,
    session_id: &str,
    text: String,
) {
    let out_tx = out_tx.clone();
    let pending = Arc::clone(pending);
    let next_id = Arc::clone(next_id);
    let updates = updates.clone();
    let task_id = task_id.to_string();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let res = rpc(&out_tx, &pending, &next_id, "session/prompt", json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }]
        }))
        .await;
        let stop = res
            .and_then(|v| v.get("result")?.get("stopReason")?.as_str().map(String::from))
            .unwrap_or_else(|| "end_turn".into());
        let _ = updates.send((task_id, AcpUpdate::TurnEnded { stop_reason: stop }));
    });
}

/// Send a request and await its response (resolved by the reader task).
async fn rpc(
    out_tx: &mpsc::UnboundedSender<String>,
    pending: &Pending,
    next_id: &Arc<AtomicU64>,
    method: &str,
    params: Value,
) -> Option<Value> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    pending.lock().unwrap().insert(id, tx);
    if out_tx
        .send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string())
        .is_err()
    {
        return None;
    }
    rx.await.ok()
}

fn compact_id(id: &Value) -> String {
    // Numbers -> "5", strings -> the string, everything else -> JSON text.
    id.as_u64()
        .map(|n| n.to_string())
        .or_else(|| id.as_str().map(String::from))
        .unwrap_or_else(|| id.to_string())
}

fn resolve(cwd: &str, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(cwd).join(p)
    }
}

fn parse_update(params: &Value) -> Option<AcpUpdate> {
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    match kind {
        "agent_message_chunk" => {
            let text = update.get("content")?.get("text")?.as_str()?.to_string();
            Some(AcpUpdate::AgentText(text))
        }
        "agent_thought_chunk" => {
            let text = update.get("content")?.get("text")?.as_str()?.to_string();
            Some(AcpUpdate::AgentThought(text))
        }
        "tool_call" | "tool_call_update" => {
            let id = update.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("in_progress").to_string();
            let is_edit = update.get("kind").and_then(|v| v.as_str()) == Some("edit");
            if is_edit {
                if let Some(path) = edit_path(update) {
                    return Some(AcpUpdate::FileEdit { path });
                }
            }
            let title = update
                .get("title")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| id.clone());
            Some(AcpUpdate::ToolCall { id, title, status })
        }
        _ => None, // user_message_chunk (our own echo), plan, etc.
    }
}

/// Pull the first edited file path out of a tool_call update, from `locations`
/// or a diff in `content`.
fn edit_path(update: &Value) -> Option<String> {
    if let Some(loc) = update.get("locations").and_then(|l| l.as_array()) {
        if let Some(p) = loc.first().and_then(|e| e.get("path")).and_then(|p| p.as_str()) {
            return Some(p.to_string());
        }
    }
    if let Some(content) = update.get("content").and_then(|c| c.as_array()) {
        for item in content {
            if let Some(p) = item.get("path").and_then(|p| p.as_str()) {
                return Some(p.to_string());
            }
        }
    }
    None
}

/// Turn ACP permission options into the client-facing outcome labels plus a
/// label→optionId map for replying. ACP option `kind`s
/// (allow_once/allow_always/reject_once/reject_always) collapse to our three
/// outcomes.
fn parse_permission(params: &Value) -> (String, Vec<String>, HashMap<String, String>) {
    let title = params
        .get("toolCall")
        .and_then(|t| t.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("Permission request")
        .to_string();

    let mut map: HashMap<String, String> = HashMap::new();
    if let Some(opts) = params.get("options").and_then(|o| o.as_array()) {
        for opt in opts {
            let option_id = opt.get("optionId").and_then(|v| v.as_str()).unwrap_or("");
            let kind = opt.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let label = match kind {
                "allow_once" => "allow",
                "allow_always" => "allow_always",
                "reject_once" | "reject_always" => "deny",
                _ => continue,
            };
            map.entry(label.to_string()).or_insert_with(|| option_id.to_string());
        }
    }

    // Present in a stable, sensible order.
    let mut options = Vec::new();
    for label in ["allow", "allow_always", "deny"] {
        if map.contains_key(label) {
            options.push(label.to_string());
        }
    }
    (title, options, map)
}
