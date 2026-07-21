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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};
use warpforge_protocol as wire;

use super::prompt::PreparedPrompt;
use crate::policies::{Phase, PolicyAction, PolicyContext, PolicyResult};

/// A request from the ACP reader to evaluate a policy before executing an op.
pub struct PolicyCheck {
    pub ctx: PolicyContext,
    pub reply: oneshot::Sender<PolicyResult>,
}

/// An update from an agent session, forwarded to the daemon actor as
/// `(task_id, AcpUpdate)`.
#[derive(Debug, Clone)]
pub enum AcpUpdate {
    SessionStarted {
        session_id: String,
    },
    AgentText(String),
    AgentThought(String),
    ToolCall {
        id: String,
        title: String,
        status: String,
        kind: String,
        content: Option<String>,
    },
    FileEdit {
        path: String,
        tool_call_id: String,
        additions: Option<u32>,
        deletions: Option<u32>,
    },
    PermissionRequest {
        request_id: String,
        title: String,
        options: Vec<String>,
    },
    Plan {
        entries: Vec<wire::PlanEntry>,
    },
    AvailableCommands {
        commands: Vec<wire::CommandInfo>,
    },
    ConfigOptions {
        options: Vec<wire::ConfigOption>,
    },
    Usage {
        used: u64,
        size: u64,
        cost: Option<wire::SessionUsageCost>,
    },
    PromptCapabilities {
        image: bool,
        embedded_context: bool,
    },
    TurnEnded {
        stop_reason: String,
    },
    Error {
        run_id: u64,
        message: String,
    },
}

pub enum AcpCommand {
    Prompt(PreparedPrompt),
    AnswerPermission { request_id: String, outcome: String },
    SetConfigOption { config_id: String, value: String },
    Cancel,
}

/// Handle the actor keeps per task to drive its agent session.
#[derive(Clone)]
pub struct AcpHandle {
    cmd_tx: mpsc::UnboundedSender<AcpCommand>,
    image_capability: Arc<AtomicU8>,
    process: Arc<ProcessGuard>,
    run_id: u64,
}

impl AcpHandle {
    pub fn prompt(&self, prompt: PreparedPrompt) -> Result<(), String> {
        if prompt.has_images && self.image_capability.load(Ordering::Acquire) != 2 {
            return Err("this agent does not support image prompts".into());
        }
        self.cmd_tx
            .send(AcpCommand::Prompt(prompt))
            .map_err(|_| "agent session is no longer running".into())
    }
    pub fn answer(&self, request_id: String, outcome: String) {
        let _ = self.cmd_tx.send(AcpCommand::AnswerPermission {
            request_id,
            outcome,
        });
    }
    pub fn set_config_option(&self, config_id: String, value: String) {
        let _ = self
            .cmd_tx
            .send(AcpCommand::SetConfigOption { config_id, value });
    }
    pub fn cancel(&self) {
        self.process.stop_intentionally();
        let _ = self.cmd_tx.send(AcpCommand::Cancel);
    }

    pub fn run_id(&self) -> u64 {
        self.run_id
    }
}

#[derive(Clone, Debug)]
struct ChildExit {
    code: Option<i32>,
    status: String,
}

#[derive(Clone, Debug)]
enum ChildState {
    Running,
    Exited(ChildExit),
}

struct ProcessGuard {
    kill_tx: mpsc::UnboundedSender<()>,
    stopping: Arc<AtomicBool>,
}

impl ProcessGuard {
    fn stop_intentionally(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.kill_tx.send(());
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.kill_tx.send(());
    }
}

#[derive(Clone)]
struct FailureReporter {
    task_id: String,
    run_id: u64,
    updates: mpsc::UnboundedSender<(String, AcpUpdate)>,
    reported: Arc<AtomicBool>,
}

impl FailureReporter {
    fn report(&self, message: String) {
        if self
            .reported
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let _ = self.updates.send((
                self.task_id.clone(),
                AcpUpdate::Error {
                    run_id: self.run_id,
                    message,
                },
            ));
        }
    }
}

const STDERR_LINE_BYTES: usize = 512;
const STDERR_TOTAL_BYTES: usize = 4096;

fn sanitize_stderr(input: &[u8]) -> String {
    let text = String::from_utf8_lossy(input);
    let clean: String = text
        .chars()
        .filter_map(|ch| match ch {
            '\n' | '\t' => Some(ch),
            ch if !ch.is_control() => Some(ch),
            _ => None,
        })
        .collect();
    bound_diagnostic(&redact_secrets(&clean))
}

fn bound_diagnostic(input: &str) -> String {
    let mut output = String::new();
    let mut total_bytes = 0usize;
    for (index, line) in input.lines().enumerate() {
        if index > 0 && total_bytes < STDERR_TOTAL_BYTES {
            output.push('\n');
            total_bytes += 1;
        }
        let mut line_bytes = 0usize;
        for ch in line.chars() {
            let bytes = ch.len_utf8();
            if line_bytes + bytes > STDERR_LINE_BYTES || total_bytes + bytes > STDERR_TOTAL_BYTES {
                break;
            }
            output.push(ch);
            line_bytes += bytes;
            total_bytes += bytes;
        }
        if total_bytes >= STDERR_TOTAL_BYTES {
            break;
        }
    }
    output
}

fn redact_secrets(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower
                .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
                .any(|term| {
                    matches!(
                        term,
                        "auth"
                            | "token"
                            | "bearer"
                            | "authorization"
                            | "auth_token"
                            | "access_token"
                            | "api_token"
                            | "api_key"
                            | "apikey"
                    )
                })
            {
                "[REDACTED]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn append_stderr_chunk(captured: &mut Vec<u8>, line_bytes: &mut usize, chunk: &[u8]) {
    for &byte in chunk {
        if captured.len() >= STDERR_TOTAL_BYTES {
            return;
        }
        if byte == b'\n' {
            captured.push(byte);
            *line_bytes = 0;
        } else if *line_bytes < STDERR_LINE_BYTES {
            captured.push(byte);
            *line_bytes += 1;
        }
    }
}

async fn capture_pre_initialize_stderr(
    mut stderr: tokio::process::ChildStderr,
    initialized: Arc<AtomicBool>,
    captured: Arc<Mutex<Vec<u8>>>,
) {
    let mut line_bytes = 0usize;
    let mut buf = [0u8; 256];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        if initialized.load(Ordering::Acquire) {
            continue;
        }
        for &byte in &buf[..n] {
            if initialized.load(Ordering::Acquire) {
                break;
            }
            append_stderr_chunk(&mut captured.lock().unwrap(), &mut line_bytes, &[byte]);
        }
    }
}

async fn kill_process_group(pgid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pgid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

fn child_exit_message(command: &str, exit: &ChildExit, stderr: &str) -> String {
    let safe_command = sanitize_stderr(command.as_bytes());
    let detail = if stderr.trim().is_empty() {
        String::new()
    } else {
        format!(" Pre-initialize stderr: {}", stderr.trim())
    };
    format!(
        "Agent command '{safe_command}' exited \
         (status: {}; code: {:?}).{detail}",
        exit.status, exit.code
    )
}

struct PendingPerm {
    /// The agent's original JSON-RPC request id, needed to reply.
    agent_id: Value,
    /// Client outcome label ("allow" / "allow_always" / "deny") -> ACP optionId.
    options: HashMap<String, String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

/// Spawn an agent process and its ACP session. Returns immediately; the
/// `initialize` → `session/new` → initial `session/prompt` handshake runs in
/// the background and streams updates over `updates`.
///
/// When `policy_tx` is provided, file write operations are gated through the
/// daemon's policy engine before execution.
#[allow(clippy::too_many_arguments)]
pub fn spawn_acp_session(
    task_id: String,
    command: String,
    cwd: String,
    initial_prompt: PreparedPrompt,
    // When set, resume this native session id via ACP `session/load` instead of
    // starting a fresh `session/new`. The agent replays history as updates.
    resume: Option<String>,
    // MCP servers to advertise to the agent on session setup (empty for a plain
    // task; the orchestrator session passes the warpforge MCP bridge here).
    mcp_servers: Vec<Value>,
    updates: mpsc::UnboundedSender<(String, AcpUpdate)>,
    policy_tx: Option<mpsc::UnboundedSender<PolicyCheck>>,
    // Model id to apply to the session before the first prompt (fresh
    // `session/new` only; ignored when resuming). None = no override.
    default_model: Option<String>,
) -> anyhow::Result<AcpHandle> {
    let run_id = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
    let mut child_command = Command::new("sh");
    child_command
        .args(["-c", &command])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    child_command.process_group(0);
    let mut child = child_command.spawn()?;

    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let initialized = Arc::new(AtomicBool::new(false));
    let stderr_capture = Arc::new(Mutex::new(Vec::with_capacity(STDERR_TOTAL_BYTES)));
    let mut stderr_task = tokio::spawn(capture_pre_initialize_stderr(
        stderr,
        Arc::clone(&initialized),
        Arc::clone(&stderr_capture),
    ));

    let reporter = FailureReporter {
        task_id: task_id.clone(),
        run_id,
        updates: updates.clone(),
        reported: Arc::new(AtomicBool::new(false)),
    };
    let stopping = Arc::new(AtomicBool::new(false));
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel();
    let process = Arc::new(ProcessGuard {
        kill_tx,
        stopping: Arc::clone(&stopping),
    });
    let (exit_tx, exit_rx) = watch::channel(ChildState::Running);
    let pgid = child.id();
    {
        let reporter = reporter.clone();
        let command = command.clone();
        let monitor_stderr_capture = Arc::clone(&stderr_capture);
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = kill_rx.recv() => {
                    kill_process_group(pgid).await;
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            kill_process_group(pgid).await;
            if tokio::time::timeout(std::time::Duration::from_millis(100), &mut stderr_task)
                .await
                .is_err()
            {
                stderr_task.abort();
            }
            let stderr = sanitize_stderr(&monitor_stderr_capture.lock().unwrap());
            let exit = match status {
                Ok(status) => ChildExit {
                    code: status.code(),
                    status: status.to_string(),
                },
                Err(error) => ChildExit {
                    code: None,
                    status: format!("wait failed: {error}"),
                },
            };
            exit_tx.send_replace(ChildState::Exited(exit.clone()));
            if !stopping.load(Ordering::Acquire) {
                reporter.report(child_exit_message(&command, &exit, &stderr));
            }
        });
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<AcpCommand>();
    let image_capability = Arc::new(AtomicU8::new(0));

    // Set WARPFORGE_ACP_DEBUG=1 to log the raw JSON-RPC exchange to the daemon's
    // stderr — the fastest way to see why a real agent isn't answering.
    let debug = std::env::var("WARPFORGE_ACP_DEBUG").is_ok();

    // Writer: serialize outgoing frames (ndjson) to the agent's stdin.
    {
        let tid = task_id.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = out_rx.recv().await {
                if debug {
                    eprintln!("[acp {tid} >>] {line}");
                }
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let perms: Arc<Mutex<HashMap<String, PendingPerm>>> = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicU64::new(1));
    // True only while a `session/load` RPC is in flight. During that window the
    // agent replays its entire transcript back as `session/update`
    // notifications; we already have that history persisted, so the reader
    // drops it instead of re-streaming (and re-persisting) it to clients as if
    // it were live — which used to flood the chat and blink task status on
    // every resume of an old session.
    let replaying = Arc::new(AtomicBool::new(false));
    let permission_run_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into());

    // Reader: route agent → daemon frames.
    {
        let pending = Arc::clone(&pending);
        let perms = Arc::clone(&perms);
        let updates = updates.clone();
        let out_tx = out_tx.clone();
        let task_id = task_id.clone();
        let cwd = cwd.clone();
        let permission_run_id = permission_run_id.clone();
        let policy_tx_reader = policy_tx.clone();
        let replaying = Arc::clone(&replaying);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if debug {
                    eprintln!("[acp {task_id} <<] {line}");
                }
                let msg: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => {
                        // Not JSON — likely a framing mismatch (Content-Length?)
                        // or a banner line. Surface it so it's diagnosable.
                        eprintln!("[acp {task_id} <<?] non-JSON line: {line}");
                        continue;
                    }
                };

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

                let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
                    continue;
                };
                let id = msg.get("id").cloned();
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

                match method {
                    "session/update" => {
                        match parse_update(&params) {
                            Some(update) => {
                                // Drop transcript replayed during `session/load`
                                // but retain current session metadata, which the
                                // agent is expected to refresh while resuming.
                                if replaying.load(Ordering::Acquire)
                                    && !matches!(&update, AcpUpdate::Usage { .. })
                                {
                                    continue;
                                }
                                let _ = updates.send((task_id.clone(), update));
                            }
                            None if debug => {
                                eprintln!(
                                    "[acp {task_id} <<?] unhandled session/update shape: {params}"
                                );
                            }
                            None => {}
                        }
                    }
                    "session/request_permission" => {
                        let Some(agent_id) = id else { continue };
                        let (title, options, map) = parse_permission(&params);
                        let request_id =
                            format!("{task_id}:{permission_run_id}:{}", compact_id(&agent_id));
                        perms.lock().unwrap().insert(
                            request_id.clone(),
                            PendingPerm {
                                agent_id,
                                options: map,
                            },
                        );
                        let _ = updates.send((
                            task_id.clone(),
                            AcpUpdate::PermissionRequest {
                                request_id,
                                title,
                                options,
                            },
                        ));
                        // reply is deferred until the human answers
                    }
                    "fs/read_text_file" => {
                        let path = params.get("path").and_then(|p| p.as_str()).unwrap_or("");
                        let content =
                            std::fs::read_to_string(resolve(&cwd, path)).unwrap_or_default();
                        if let Some(id) = id {
                            let _ = out_tx.send(
                                json!({"jsonrpc":"2.0","id":id,"result":{"content":content}})
                                    .to_string(),
                            );
                        }
                    }
                    "fs/write_text_file" => {
                        let path = params.get("path").and_then(|p| p.as_str()).unwrap_or("");
                        let content = params.get("content").and_then(|c| c.as_str()).unwrap_or("");

                        // Check policies before writing.
                        let allowed = if let Some(ref ptx) = policy_tx_reader {
                            let (ptx_reply, ptx_rx) = oneshot::channel();
                            let ctx = PolicyContext {
                                phase: Phase::ToolCall,
                                tool_name: Some("fs/write_text_file".into()),
                                tool_input: Some(json!({"path": path, "content": content})),
                                agent: String::new(), // filled by daemon
                                task_id: task_id.clone(),
                                project: String::new(),
                                cwd: PathBuf::from(&cwd),
                                labels: HashMap::new(),
                            };
                            let _ = ptx.send(PolicyCheck {
                                ctx,
                                reply: ptx_reply,
                            });
                            match ptx_rx.await {
                                Ok(result) => matches!(result.action, PolicyAction::Allow),
                                Err(_) => true, // policy channel closed — allow
                            }
                        } else {
                            true
                        };

                        if allowed {
                            let _ = std::fs::write(resolve(&cwd, path), content);
                            if let Some(id) = id {
                                let _ = out_tx.send(
                                    json!({"jsonrpc":"2.0","id":id,"result":null}).to_string(),
                                );
                            }
                        } else {
                            if let Some(id) = id {
                                let _ = out_tx.send(
                                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"denied by policy"}}).to_string(),
                                );
                            }
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
            pending.lock().unwrap().clear();
        });
    }

    // Driver: handshake, initial prompt, then the command loop.
    {
        let pending = Arc::clone(&pending);
        let perms = Arc::clone(&perms);
        let next_id = Arc::clone(&next_id);
        let updates = updates.clone();
        let replaying = Arc::clone(&replaying);
        let driver_image_capability = Arc::clone(&image_capability);
        let command_for_err = command.clone();
        let reporter = reporter.clone();
        let driver_kill_tx = process.kill_tx.clone();
        let driver_stderr_capture = Arc::clone(&stderr_capture);
        let driver_default_model = default_model.clone();
        tokio::spawn(async move {
            const INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
            const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
            let agent_name = sanitize_stderr(command_for_err.trim().as_bytes());
            let mut driver_exit_rx = exit_rx.clone();

            let init = match tokio::time::timeout(
                INITIALIZE_TIMEOUT,
                rpc_with_exit(
                    &out_tx,
                    &pending,
                    &next_id,
                    "initialize",
                    json!({
                        "protocolVersion": 1,
                        "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } }
                    }),
                    &mut driver_exit_rx,
                ),
            )
            .await
            {
                Ok(RpcOutcome::Response(v)) => v,
                Ok(RpcOutcome::Exited(_)) => {
                    return;
                }
                Ok(RpcOutcome::TransportClosed) => {
                    let stderr = sanitize_stderr(&driver_stderr_capture.lock().unwrap());
                    let detail = if stderr.trim().is_empty() {
                        String::new()
                    } else {
                        format!(" Pre-initialize stderr: {}", stderr.trim())
                    };
                    reporter.report(format!(
                        "Agent command '{agent_name}' closed its ACP stdout before replying to initialize.{detail}"
                    ));
                    let _ = driver_kill_tx.send(());
                    return;
                }
                Err(_) => {
                    reporter.report(format!(
                        "Agent command '{agent_name}' is still alive but did not reply to ACP \
                         'initialize' within 60 seconds. Verify that it starts an ACP \
                         JSON-RPC server over stdio."
                    ));
                    let _ = driver_kill_tx.send(());
                    return;
                }
            };
            if init.get("error").is_some() {
                reporter.report(format!(
                    "Agent command '{agent_name}' rejected the ACP initialize request."
                ));
                let _ = driver_kill_tx.send(());
                return;
            }
            initialized.store(true, Ordering::Release);
            let load_supported = init
                .get("result")
                .and_then(|r| r.get("agentCapabilities"))
                .and_then(|c| c.get("loadSession"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let prompt_caps = init
                .get("result")
                .and_then(|r| r.get("agentCapabilities"))
                .and_then(|c| c.get("promptCapabilities"));
            let image_supported = prompt_caps
                .and_then(|c| c.get("image"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let embedded_context = prompt_caps
                .and_then(|c| c.get("embeddedContext"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            driver_image_capability.store(if image_supported { 2 } else { 1 }, Ordering::Release);
            let _ = updates.send((
                task_id.clone(),
                AcpUpdate::PromptCapabilities {
                    image: image_supported,
                    embedded_context,
                },
            ));

            // Resume an existing session (session/load) or start a fresh one
            // (session/new). Resume replays history back as session/update.
            let mut fresh_config_options: Vec<wire::ConfigOption> = Vec::new();
            let session_id = if let Some(ref sid) = resume {
                if !load_supported {
                    reporter.report(format!(
                        "Agent command '{agent_name}' does not advertise ACP session/load; \
                         saved session '{sid}' cannot be resumed."
                    ));
                    let _ = driver_kill_tx.send(());
                    return;
                }
                // Replay window: the agent streams its whole transcript back
                // between this request and its reply. The reader drops those
                // updates while the flag is set.
                replaying.store(true, Ordering::Release);
                let loaded = tokio::time::timeout(
                    RPC_TIMEOUT,
                    rpc_with_exit(
                        &out_tx,
                        &pending,
                        &next_id,
                        "session/load",
                        json!({
                            "sessionId": sid, "cwd": cwd, "mcpServers": mcp_servers
                        }),
                        &mut driver_exit_rx,
                    ),
                )
                .await;
                replaying.store(false, Ordering::Release);
                match loaded {
                    Ok(RpcOutcome::Response(response)) if response.get("error").is_none() => sid.clone(),
                    Ok(RpcOutcome::Response(_)) => {
                        reporter.report(format!(
                            "Agent command '{agent_name}' rejected ACP session/load for saved \
                             session '{sid}'."
                        ));
                        let _ = driver_kill_tx.send(());
                        return;
                    }
                    Ok(RpcOutcome::Exited(_)) => return,
                    Ok(RpcOutcome::TransportClosed) => {
                        reporter.report(format!(
                            "Agent command '{agent_name}' closed its ACP stdout during session/load for saved session '{sid}'."
                        ));
                        let _ = driver_kill_tx.send(());
                        return;
                    }
                    Err(_) => {
                        reporter.report(format!(
                            "Agent command '{agent_name}' did not complete ACP session/load \
                             for saved session '{sid}' within 15 seconds."
                        ));
                        let _ = driver_kill_tx.send(());
                        return;
                    }
                }
            } else {
                match tokio::time::timeout(
                    RPC_TIMEOUT,
                    rpc_with_exit(
                        &out_tx,
                        &pending,
                        &next_id,
                        "session/new",
                        json!({
                            "cwd": cwd, "mcpServers": mcp_servers
                        }),
                        &mut driver_exit_rx,
                    ),
                )
                .await
                {
                    Ok(RpcOutcome::Response(v)) => {
                        if v.get("error").is_some() {
                            reporter.report(format!(
                                "Agent command '{agent_name}' rejected the ACP session/new request."
                            ));
                            let _ = driver_kill_tx.send(());
                            return;
                        }
                        // Model/mode selectors the agent advertises up-front.
                        if let Some(result) = v.get("result") {
                            let opts = parse_config_options(result.get("configOptions"));
                            if !opts.is_empty() {
                                fresh_config_options = opts.clone();
                                let _ = updates.send((
                                    task_id.clone(),
                                    AcpUpdate::ConfigOptions { options: opts },
                                ));
                            }
                        }
                        let Some(session_id) = v
                            .get("result")
                            .and_then(|r| r.get("sessionId"))
                            .and_then(|s| s.as_str())
                            .map(String::from)
                        else {
                            reporter.report(format!(
                                "Agent command '{agent_name}' returned no session ID from ACP \
                                 session/new."
                            ));
                            let _ = driver_kill_tx.send(());
                            return;
                        };
                        session_id
                    }
                    Ok(RpcOutcome::Exited(_)) => return,
                    Ok(RpcOutcome::TransportClosed) => {
                        reporter.report(format!(
                            "Agent command '{agent_name}' closed its ACP stdout during session/new."
                        ));
                        let _ = driver_kill_tx.send(());
                        return;
                    }
                    Err(_) => {
                        reporter.report(format!(
                            "Agent command '{agent_name}' did not reply to ACP session/new \
                             within 15 seconds."
                        ));
                        let _ = driver_kill_tx.send(());
                        return;
                    }
                }
            };

            // Apply the user-selected model before the first prompt. Only for
            // fresh sessions — resume must keep the loaded session's existing
            // model state. We pick the option id whose category is "model" or
            // whose id/name contains "model" (mirrors AgentConfigBar.tsx).
            if resume.is_none() {
                if let Some(ref model_value) = driver_default_model {
                    if let Some(model_opt) = fresh_config_options.iter().find(|o| {
                        let identity = format!(
                            "{} {} {}",
                            o.category.as_deref().unwrap_or(""),
                            o.id,
                            o.name
                        )
                        .to_lowercase();
                        identity.contains("model")
                    }) {
                        if model_opt.current_value != *model_value {
                            let set_res = tokio::time::timeout(
                                RPC_TIMEOUT,
                                rpc(
                                    &out_tx,
                                    &pending,
                                    &next_id,
                                    "session/set_config_option",
                                    json!({
                                        "sessionId": session_id,
                                        "configId": model_opt.id,
                                        "value": model_value,
                                    }),
                                ),
                            )
                            .await;
                            if let Ok(Some(resp)) = set_res {
                                if let Some(result) = resp.get("result") {
                                    let opts = parse_config_options(result.get("configOptions"));
                                    if !opts.is_empty() {
                                        let _ = updates.send((
                                            task_id.clone(),
                                            AcpUpdate::ConfigOptions { options: opts },
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let _ = updates.send((
                task_id.clone(),
                AcpUpdate::SessionStarted {
                    session_id: session_id.clone(),
                },
            ));

            // On resume with no new instruction we only load history; the user
            // continues via session.prompt. Otherwise send the initial prompt.
            if !initial_prompt.content.is_empty() {
                if initial_prompt.has_images && !image_supported {
                    reporter.report(format!(
                        "Agent command '{agent_name}' does not support image prompts."
                    ));
                    let _ = driver_kill_tx.send(());
                    return;
                }
                send_prompt(
                    &out_tx,
                    &pending,
                    &next_id,
                    &updates,
                    &task_id,
                    &session_id,
                    initial_prompt,
                    embedded_context,
                    exit_rx.clone(),
                    reporter.clone(),
                    driver_kill_tx.clone(),
                    &agent_name,
                );
            }

            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    AcpCommand::Prompt(prompt) => {
                        send_prompt(
                            &out_tx,
                            &pending,
                            &next_id,
                            &updates,
                            &task_id,
                            &session_id,
                            prompt,
                            embedded_context,
                            exit_rx.clone(),
                            reporter.clone(),
                            driver_kill_tx.clone(),
                            &agent_name,
                        );
                    }
                    AcpCommand::AnswerPermission {
                        request_id,
                        outcome,
                    } => {
                        if let Some(p) = perms.lock().unwrap().remove(&request_id) {
                            let result = match p.options.get(&outcome) {
                                Some(opt) => {
                                    json!({ "outcome": { "outcome": "selected", "optionId": opt } })
                                }
                                None => json!({ "outcome": { "outcome": "cancelled" } }),
                            };
                            let _ = out_tx.send(
                                json!({"jsonrpc":"2.0","id":p.agent_id,"result":result})
                                    .to_string(),
                            );
                        }
                    }
                    AcpCommand::SetConfigOption { config_id, value } => {
                        let out_tx = out_tx.clone();
                        let pending = Arc::clone(&pending);
                        let next_id = Arc::clone(&next_id);
                        let updates = updates.clone();
                        let task_id = task_id.clone();
                        let session_id = session_id.clone();
                        tokio::spawn(async move {
                            let res = rpc(
                                &out_tx,
                                &pending,
                                &next_id,
                                "session/set_config_option",
                                json!({
                                    "sessionId": session_id, "configId": config_id, "value": value
                                }),
                            )
                            .await;
                            // The reply carries the full updated configOptions.
                            if let Some(result) = res.as_ref().and_then(|v| v.get("result")) {
                                let opts = parse_config_options(result.get("configOptions"));
                                if !opts.is_empty() {
                                    let _ = updates.send((
                                        task_id,
                                        AcpUpdate::ConfigOptions { options: opts },
                                    ));
                                }
                            }
                        });
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

    Ok(AcpHandle {
        cmd_tx,
        image_capability,
        process,
        run_id,
    })
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
    prompt: PreparedPrompt,
    embedded_context: bool,
    mut exit_rx: watch::Receiver<ChildState>,
    reporter: FailureReporter,
    kill_tx: mpsc::UnboundedSender<()>,
    agent_name: &str,
) {
    let out_tx = out_tx.clone();
    let pending = Arc::clone(pending);
    let next_id = Arc::clone(next_id);
    let updates = updates.clone();
    let task_id = task_id.to_string();
    let session_id = session_id.to_string();
    let agent_name = agent_name.to_string();
    tokio::spawn(async move {
        let res = rpc_with_exit(
            &out_tx,
            &pending,
            &next_id,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": prompt.content.iter().map(|block| block.to_acp(embedded_context)).collect::<Vec<_>>()
            }),
            &mut exit_rx,
        )
        .await;
        let response = match res {
            RpcOutcome::Response(response) => response,
            RpcOutcome::Exited(_) => return,
            RpcOutcome::TransportClosed => {
                reporter.report(format!(
                    "Agent command '{agent_name}' closed its ACP stdout during session/prompt."
                ));
                let _ = kill_tx.send(());
                return;
            }
        };
        if response.get("error").is_some() {
            reporter.report("The agent rejected the ACP session/prompt request.".into());
            let _ = kill_tx.send(());
            return;
        }
        let stop = Some(response)
            .and_then(|v| {
                v.get("result")?
                    .get("stopReason")?
                    .as_str()
                    .map(String::from)
            })
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

enum RpcOutcome {
    Response(Value),
    Exited(ChildExit),
    TransportClosed,
}

/// Send an RPC while observing a durable child-exit state. If stdout closes,
/// wait for the process monitor so callers receive the real exit status rather
/// than racing a consumed channel notification.
async fn rpc_with_exit(
    out_tx: &mpsc::UnboundedSender<String>,
    pending: &Pending,
    next_id: &Arc<AtomicU64>,
    method: &str,
    params: Value,
    exit_rx: &mut watch::Receiver<ChildState>,
) -> RpcOutcome {
    if let ChildState::Exited(exit) = exit_rx.borrow().clone() {
        return RpcOutcome::Exited(exit);
    }
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    pending.lock().unwrap().insert(id, tx);
    if out_tx
        .send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string())
        .is_err()
    {
        return wait_for_exit_with_grace(exit_rx).await;
    }
    tokio::select! {
        result = rx => match result {
            Ok(value) => RpcOutcome::Response(value),
            Err(_) => wait_for_exit_with_grace(exit_rx).await,
        },
        _ = exit_rx.changed() => {
            let state = exit_rx.borrow().clone();
            match state {
                ChildState::Exited(exit) => RpcOutcome::Exited(exit),
                ChildState::Running => wait_for_exit(exit_rx).await,
            }
        }
    }
}

async fn wait_for_exit_with_grace(exit_rx: &mut watch::Receiver<ChildState>) -> RpcOutcome {
    tokio::time::timeout(
        std::time::Duration::from_millis(250),
        wait_for_exit(exit_rx),
    )
    .await
    .unwrap_or(RpcOutcome::TransportClosed)
}

async fn wait_for_exit(exit_rx: &mut watch::Receiver<ChildState>) -> RpcOutcome {
    loop {
        if let ChildState::Exited(exit) = exit_rx.borrow().clone() {
            return RpcOutcome::Exited(exit);
        }
        if exit_rx.changed().await.is_err() {
            return RpcOutcome::Exited(ChildExit {
                code: None,
                status: "process monitor closed".into(),
            });
        }
    }
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
        "agent_message_chunk" => Some(AcpUpdate::AgentText(content_text(update.get("content")?)?)),
        "agent_thought_chunk" => Some(AcpUpdate::AgentThought(content_text(
            update.get("content")?,
        )?)),
        "tool_call" | "tool_call_update" => {
            let id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("in_progress")
                .to_string();
            let kind = update
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("other")
                .to_string();
            // A file edit still emits a dedicated FileEdit for the diff badge…
            if kind == "edit" {
                if let Some(edit) = edit_info(update) {
                    return Some(AcpUpdate::FileEdit {
                        path: edit.path,
                        tool_call_id: id,
                        additions: edit.additions,
                        deletions: edit.deletions,
                    });
                }
            }
            let title = tool_title(update, &id, &kind);
            Some(AcpUpdate::ToolCall {
                id,
                title,
                status,
                kind,
                content: tool_details(update),
            })
        }
        "plan" => {
            let entries = update
                .get("entries")?
                .as_array()?
                .iter()
                .map(|e| wire::PlanEntry {
                    content: e
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    status: e
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("pending")
                        .to_string(),
                    priority: e.get("priority").and_then(|v| v.as_str()).map(String::from),
                })
                .collect();
            Some(AcpUpdate::Plan { entries })
        }
        "available_commands_update" => {
            let commands = update
                .get("availableCommands")?
                .as_array()?
                .iter()
                .map(|c| wire::CommandInfo {
                    name: c
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    description: c
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect();
            Some(AcpUpdate::AvailableCommands { commands })
        }
        "config_option_update" => Some(AcpUpdate::ConfigOptions {
            options: parse_config_options(update.get("configOptions")),
        }),
        "usage_update" => {
            let used = update.get("used")?.as_u64()?;
            let size = update.get("size")?.as_u64()?;
            let cost = update.get("cost").and_then(|value| {
                Some(wire::SessionUsageCost {
                    amount: value.get("amount")?.as_f64()?,
                    currency: value.get("currency")?.as_str()?.to_string(),
                })
            });
            Some(AcpUpdate::Usage { used, size, cost })
        }
        _ => None, // user_message_chunk (our own echo), current_mode_update, etc.
    }
}

/// Parse an ACP `configOptions` array (model/mode/reasoning selectors).
pub fn parse_config_options(v: Option<&Value>) -> Vec<wire::ConfigOption> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|o| {
            Some(wire::ConfigOption {
                id: o.get("id")?.as_str()?.to_string(),
                name: o
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                category: o.get("category").and_then(|x| x.as_str()).map(String::from),
                current_value: o
                    .get("currentValue")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                options: o
                    .get("options")
                    .and_then(|x| x.as_array())
                    .map(|opts| {
                        opts.iter()
                            .filter_map(|c| {
                                Some(wire::ConfigChoice {
                                    value: c.get("value")?.as_str()?.to_string(),
                                    name: c
                                        .get("name")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// Produce a useful title even when an agent omits ACP's optional `title`.
/// Codex and Claude adapters commonly leave the command/path in `rawInput`
/// while OpenCode already sends a display-ready title.
fn tool_title(update: &Value, id: &str, kind: &str) -> String {
    if let Some(title) = update
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty() && *title != id)
    {
        return title.to_string();
    }

    let raw_input = update.get("rawInput");
    if kind == "execute" {
        if let Some(command) = raw_input.and_then(|input| input_value(input, &["command", "cmd"])) {
            return command;
        }
    }

    let path = first_location_path(update).or_else(|| {
        raw_input.and_then(|input| input_value(input, &["path", "filePath", "filepath"]))
    });
    if let Some(path) = path {
        let action = match kind {
            "read" => "Read",
            "edit" => "Edit",
            "delete" => "Delete",
            "move" => "Move",
            _ => "Open",
        };
        return format!("{action} {path}");
    }

    if let Some(query) = raw_input.and_then(|input| input_value(input, &["query", "pattern"])) {
        return format!("Search for {query}");
    }
    if let Some(url) = raw_input.and_then(|input| input_value(input, &["url"])) {
        return format!("Fetch {url}");
    }

    match kind {
        "execute" => "Run command",
        "read" => "Read file",
        "edit" => "Edit file",
        "delete" => "Delete file",
        "move" => "Move file",
        "search" => "Search workspace",
        "fetch" => "Fetch resource",
        "think" => "Think",
        _ => "Use tool",
    }
    .to_string()
}

fn input_value(input: &Value, keys: &[&str]) -> Option<String> {
    let value = keys.iter().find_map(|key| input.get(*key))?;
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    let parts = value
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn first_location_path(update: &Value) -> Option<String> {
    update
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(Value::as_str)
        .map(String::from)
}

/// Prefer rendered ACP content, then fall back to raw output/input so tool
/// cards remain expandable across agents with different payload fidelity.
fn tool_details(update: &Value) -> Option<String> {
    let mut out = String::new();
    let arr = update.get("content").and_then(Value::as_array);
    for item in arr.into_iter().flatten() {
        if let Some(block) = item.get("content") {
            if let Some(t) = content_text(block) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&t);
            }
        }
    }
    if !out.is_empty() {
        return Some(out);
    }

    update
        .get("rawOutput")
        .and_then(display_json_value)
        .or_else(|| update.get("rawInput").and_then(display_json_value))
}

fn display_json_value(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    if let Some(text) = value.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_string());
    }
    serde_json::to_string_pretty(value).ok()
}

/// Extract display text from an ACP content value, tolerating the shapes real
/// agents use: a `{ text }` block, a bare string, or an array of blocks.
fn content_text(content: &Value) -> Option<String> {
    if let Some(t) = content.get("text").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    if let Some(t) = content.as_str() {
        return Some(t.to_string());
    }
    if let Some(arr) = content.as_array() {
        let joined: String = arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect();
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    None
}

struct EditInfo {
    path: String,
    additions: Option<u32>,
    deletions: Option<u32>,
}

/// Pull edit details from ACP diff content, falling back to `locations` when
/// the agent only reports which file it touched.
fn edit_info(update: &Value) -> Option<EditInfo> {
    if let Some(content) = update.get("content").and_then(|c| c.as_array()) {
        for item in content {
            let Some(path) = item.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            if item.get("type").and_then(|v| v.as_str()) == Some("diff") {
                let new_text = item.get("newText").and_then(|v| v.as_str());
                if let Some(new_text) = new_text {
                    let old_text = item.get("oldText").and_then(|v| v.as_str());
                    let (additions, deletions) = line_change_counts(old_text, new_text);
                    return Some(EditInfo {
                        path: path.to_string(),
                        additions: Some(additions),
                        deletions: Some(deletions),
                    });
                }
            }
            return Some(EditInfo {
                path: path.to_string(),
                additions: None,
                deletions: None,
            });
        }
    }
    if let Some(path) = update
        .get("locations")
        .and_then(|l| l.as_array())
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(|path| path.as_str())
    {
        return Some(EditInfo {
            path: path.to_string(),
            additions: None,
            deletions: None,
        });
    }
    None
}

/// Count the shortest line-level edit script using Myers' algorithm. The ACP
/// diff contains whole old/new texts, so this yields the familiar git-style
/// additions/deletions without shelling out or reading a moving worktree.
fn line_change_counts(old_text: Option<&str>, new_text: &str) -> (u32, u32) {
    let new_lines = new_text.lines().collect::<Vec<_>>();
    let Some(old_text) = old_text else {
        return (new_lines.len().try_into().unwrap_or(u32::MAX), 0);
    };
    let old_lines = old_text.lines().collect::<Vec<_>>();
    let n = old_lines.len();
    let m = new_lines.len();
    if n == 0 {
        return (m.try_into().unwrap_or(u32::MAX), 0);
    }
    if m == 0 {
        return (0, n.try_into().unwrap_or(u32::MAX));
    }

    let max = n + m;
    let offset = max as isize + 1;
    let mut furthest = vec![0isize; max * 2 + 3];
    for distance in 0..=max {
        let d = distance as isize;
        let mut diagonal = -d;
        while diagonal <= d {
            let index = (offset + diagonal) as usize;
            let mut x =
                if diagonal == -d || (diagonal != d && furthest[index - 1] < furthest[index + 1]) {
                    furthest[index + 1]
                } else {
                    furthest[index - 1] + 1
                };
            let mut y = x - diagonal;
            while x < n as isize && y < m as isize && old_lines[x as usize] == new_lines[y as usize]
            {
                x += 1;
                y += 1;
            }
            furthest[index] = x;
            if x >= n as isize && y >= m as isize {
                let additions = (distance + m - n) / 2;
                let deletions = distance - additions;
                return (
                    additions.try_into().unwrap_or(u32::MAX),
                    deletions.try_into().unwrap_or(u32::MAX),
                );
            }
            diagonal += 2;
        }
    }
    (
        m.try_into().unwrap_or(u32::MAX),
        n.try_into().unwrap_or(u32::MAX),
    )
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
            map.entry(label.to_string())
                .or_insert_with(|| option_id.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::prompt::{PreparedPrompt, PromptContent};

    fn test_process_guard() -> Arc<ProcessGuard> {
        let (kill_tx, _kill_rx) = mpsc::unbounded_channel();
        Arc::new(ProcessGuard {
            kill_tx,
            stopping: Arc::new(AtomicBool::new(false)),
        })
    }

    fn empty_prompt() -> PreparedPrompt {
        PreparedPrompt {
            content: Vec::new(),
            summaries: Vec::new(),
            has_images: false,
        }
    }

    #[test]
    fn tool_call_uses_raw_command_instead_of_technical_id() {
        let params = json!({
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "exec-7a8abe42-803f-447f-8a24-245cb383d4f9",
                "kind": "execute",
                "status": "in_progress",
                "rawInput": { "command": "git diff --stat" }
            }
        });

        let Some(AcpUpdate::ToolCall { title, content, .. }) = parse_update(&params) else {
            panic!("expected tool call");
        };
        assert_eq!(title, "git diff --stat");
        assert_eq!(
            content.as_deref(),
            Some("{\n  \"command\": \"git diff --stat\"\n}")
        );
    }

    #[test]
    fn tool_call_exposes_raw_output_and_never_falls_back_to_id() {
        let params = json!({
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "exec-0fd95cb1-b51a-4037-8300-bbf6c6597b5d",
                "kind": "execute",
                "status": "completed",
                "rawOutput": "3 files changed"
            }
        });

        let Some(AcpUpdate::ToolCall { title, content, .. }) = parse_update(&params) else {
            panic!("expected tool call");
        };
        assert_eq!(title, "Run command");
        assert_eq!(content.as_deref(), Some("3 files changed"));
    }

    #[test]
    fn file_edit_reports_line_counts_from_acp_diff() {
        let params = json!({
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "edit-1",
                "kind": "edit",
                "status": "completed",
                "content": [{
                    "type": "diff",
                    "path": "src/main.rs",
                    "oldText": "use std::io;\n\nfn main() {\n    old();\n}\n",
                    "newText": "use std::fs;\nuse std::io;\n\nfn main() {\n    new();\n}\n"
                }]
            }
        });

        let Some(AcpUpdate::FileEdit {
            path,
            tool_call_id,
            additions,
            deletions,
        }) = parse_update(&params)
        else {
            panic!("expected file edit");
        };
        assert_eq!(path, "src/main.rs");
        assert_eq!(tool_call_id, "edit-1");
        assert_eq!(additions, Some(2));
        assert_eq!(deletions, Some(1));
    }

    #[test]
    fn line_counts_handle_new_files_and_disjoint_edits() {
        assert_eq!(line_change_counts(None, "one\ntwo\n"), (2, 0));
        assert_eq!(
            line_change_counts(
                Some("keep\nold one\nmiddle\nold two\ntail\n"),
                "keep\nnew one\nmiddle\nnew two\nextra\ntail\n",
            ),
            (3, 2),
        );
    }

    #[test]
    fn parses_context_usage_and_optional_cost() {
        let params = json!({
            "update": {
                "sessionUpdate": "usage_update",
                "used": 53_000,
                "size": 200_000,
                "cost": { "amount": 0.045, "currency": "USD" }
            }
        });

        let Some(AcpUpdate::Usage { used, size, cost }) = parse_update(&params) else {
            panic!("expected usage update");
        };
        assert_eq!(used, 53_000);
        assert_eq!(size, 200_000);
        assert_eq!(cost.unwrap().currency, "USD");
    }

    #[test]
    fn handle_enforces_negotiated_image_capability() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let capability = Arc::new(AtomicU8::new(1));
        let handle = AcpHandle {
            cmd_tx: tx,
            image_capability: Arc::clone(&capability),
            process: test_process_guard(),
            run_id: 1,
        };
        let prompt = PreparedPrompt {
            content: vec![PromptContent::Image {
                mime_type: "image/png".into(),
                data: "abc".into(),
            }],
            summaries: vec![],
            has_images: true,
        };
        assert!(handle.prompt(prompt.clone()).is_err());
        assert!(rx.try_recv().is_err());
        capability.store(2, Ordering::Release);
        assert!(handle.prompt(prompt).is_ok());
        assert!(matches!(rx.try_recv(), Ok(AcpCommand::Prompt(_))));
    }

    #[test]
    fn stderr_is_control_sanitized_redacted_and_bounded() {
        let secret = b"use Authorization: Bearer super-secret\nnormal\x1b[31m diagnostic";
        let sanitized = sanitize_stderr(secret);
        assert!(!sanitized.contains("super-secret"));
        assert!(!sanitized.contains('\x1b'));
        assert!(sanitized.contains("[REDACTED]"));
        assert!(sanitized.contains("normal[31m diagnostic"));

        let mut captured = Vec::new();
        let mut line_bytes = 0;
        let mut input = vec![b'x'; STDERR_LINE_BYTES * 2];
        input.push(b'\n');
        input.extend(std::iter::repeat_n(b'y', STDERR_TOTAL_BYTES * 2));
        append_stderr_chunk(&mut captured, &mut line_bytes, &input);
        assert_eq!(
            captured.iter().position(|byte| *byte == b'\n'),
            Some(STDERR_LINE_BYTES)
        );
        assert!(captured.len() <= STDERR_TOTAL_BYTES);
        let invalid_utf8 = vec![0xff; STDERR_TOTAL_BYTES];
        let sanitized = sanitize_stderr(&invalid_utf8);
        assert!(sanitized.len() <= STDERR_LINE_BYTES);
    }

    #[tokio::test]
    async fn child_exit_reports_once_with_status_and_safe_stderr() {
        let (updates, mut rx) = mpsc::unbounded_channel();
        let _handle = spawn_acp_session(
            "task".into(),
            "printf 'token=secret\\nuseful diagnostic\\n' >&2; exit 23".into(),
            ".".into(),
            empty_prompt(),
            None,
            Vec::new(),
            updates,
            None,
            None,
        )
        .unwrap();

        let (
            _,
            AcpUpdate::Error {
                message: reason, ..
            },
        ) = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("failure should be prompt")
            .expect("failure update")
        else {
            panic!("expected terminal error");
        };
        assert!(
            reason.contains("23"),
            "actual exit status missing: {reason}"
        );
        assert!(reason.contains("useful diagnostic"));
        assert!(!reason.contains("secret"));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(
            rx.try_recv().is_err(),
            "child failure must be reported once"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closed_stdout_is_reported_without_waiting_for_initialize_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("pid");
        let command = format!("echo $$ > {}; exec 1>&-; sleep 30", pid_path.display());
        let (updates, mut rx) = mpsc::unbounded_channel();
        let handle = spawn_acp_session(
            "task".into(),
            command,
            dir.path().to_string_lossy().into_owned(),
            empty_prompt(),
            None,
            Vec::new(),
            updates,
            None,
            None,
        )
        .unwrap();

        let (_, AcpUpdate::Error { message, .. }) =
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .expect("closed stdout should fail promptly")
                .expect("failure update")
        else {
            panic!("expected terminal error");
        };
        assert!(message.contains("closed its ACP stdout"), "{message}");
        assert!(message.contains("exec 1>&-; sleep 30"), "{message}");

        let pid = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_path) {
                    break pid.trim().to_string();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("child should write pid");
        handle.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let alive = Command::new("kill")
                    .args(["-0", &pid])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .is_ok_and(|status| status.success());
                if !alive {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel should kill the child before the test returns");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_last_handle_kills_child_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("pid");
        let command = format!("echo $$ > {}; exec sleep 30", pid_path.display());
        let (updates, _rx) = mpsc::unbounded_channel();
        let handle = spawn_acp_session(
            "task".into(),
            command,
            dir.path().to_string_lossy().into_owned(),
            empty_prompt(),
            None,
            Vec::new(),
            updates,
            None,
            None,
        )
        .unwrap();
        let pid = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_path) {
                    break pid.trim().to_string();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("child should write pid");

        drop(handle);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let alive = Command::new("kill")
                    .args(["-0", &pid])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .is_ok_and(|status| status.success());
                if !alive {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping the handle should kill the child");
    }
}
