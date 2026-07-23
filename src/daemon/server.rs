//! WebSocket server exposing the daemon over the `warpforge-protocol` wire
//! format. One `tokio-tungstenite` connection per client; every client is equal
//! (no "primary" UI). Frames:
//!
//! - first client frame: `{ "auth": "<token>" }` (skipped when the token is
//!   empty, i.e. `--dev`);
//! - then request/response: `{ "id", "method", "params" }` → `{ "id", "result" }`
//!   or `{ "id", "error" }`;
//! - after `state.subscribe`: the daemon pushes a `state.snapshot` event and
//!   then streams incremental events.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::sync::{Notify, RwLock};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;
use warpforge_protocol as wire;

use super::actor::{Command, DaemonHandle};
use super::wire as wireconv;

fn daemon_json_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
        .join("daemon.json")
}

fn write_endpoint(addr: SocketAddr, token: &str, owner: wire::DaemonOwner) -> Result<()> {
    let endpoint = wire::DaemonEndpoint {
        pid: std::process::id(),
        url: format!("ws://{addr}"),
        token: token.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: wire::PROTOCOL_VERSION,
        owner,
    };
    let path = daemon_json_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(&path, serde_json::to_string_pretty(&endpoint)?)?;
    Ok(())
}

/// Bind, publish the endpoint, and serve forever. `dev` disables the auth token
/// so a browser (vite dev, no Tauri) can connect to a known address.
pub async fn serve(
    handle: DaemonHandle,
    dev: bool,
    owner: wire::DaemonOwner,
    project_count: usize,
) -> Result<()> {
    // Clean up orphan listeners from a previous daemon crash
    let port_ranges: Vec<(u16, u16)> = (0..project_count).map(crate::ports::port_range).collect();
    if !port_ranges.is_empty() {
        eprintln!("warpforge daemon: cleaning up orphan listeners from previous run");
        crate::service::kill_listeners_in_ranges(&port_ranges).await;
    }

    let bind = if dev {
        "127.0.0.1:61814"
    } else {
        "127.0.0.1:0"
    };
    let listener = TcpListener::bind(bind).await?;
    let addr = listener.local_addr()?;
    let token = if dev {
        String::new()
    } else {
        Uuid::new_v4().to_string()
    };
    write_endpoint(addr, &token, owner)?;
    eprintln!("warpforge daemon listening on ws://{addr}");

    let lifecycle = Arc::new(ServerLifecycle::new(owner));

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate())?;
        let mut sigint = signal(SignalKind::interrupt())?;
        tokio::select! {
            r = run_controlled(listener, handle.clone(), token, Arc::clone(&lifecycle)) => {
                handle.shutdown().await;
                std::fs::remove_file(daemon_json_path()).ok();
                r
            },
            _ = sigterm.recv() => {
                eprintln!("warpforge daemon: SIGTERM — stopping services");
                handle.shutdown().await;
                std::fs::remove_file(daemon_json_path()).ok();
                Ok(())
            }
            _ = sigint.recv() => {
                eprintln!("warpforge daemon: SIGINT — stopping services");
                handle.shutdown().await;
                std::fs::remove_file(daemon_json_path()).ok();
                Ok(())
            }
        }
    }
    #[cfg(not(unix))]
    {
        let result = run_controlled(listener, handle.clone(), token, lifecycle).await;
        handle.shutdown().await;
        std::fs::remove_file(daemon_json_path()).ok();
        result
    }
}

struct ServerLifecycle {
    owner: wire::DaemonOwner,
    quiescing: AtomicBool,
    /// Serializes the safety snapshot against mutations arriving on other
    /// WebSocket connections. Mutations hold a read guard until their daemon
    /// command has been accepted; the update handoff takes the write guard
    /// before it flips `quiescing` and asks the actor for blockers.
    mutations: RwLock<()>,
    shutdown: Notify,
}

impl ServerLifecycle {
    fn new(owner: wire::DaemonOwner) -> Self {
        Self {
            owner,
            quiescing: AtomicBool::new(false),
            mutations: RwLock::new(()),
            shutdown: Notify::new(),
        }
    }
}

/// Accept loop, split out so tests can drive it against a pre-bound listener.
pub async fn run(listener: TcpListener, handle: DaemonHandle, token: String) -> Result<()> {
    run_controlled(
        listener,
        handle,
        token,
        Arc::new(ServerLifecycle::new(wire::DaemonOwner::External)),
    )
    .await
}

async fn run_controlled(
    listener: TcpListener,
    handle: DaemonHandle,
    token: String,
    lifecycle: Arc<ServerLifecycle>,
) -> Result<()> {
    loop {
        let (stream, _) = tokio::select! {
            accepted = listener.accept() => accepted?,
            _ = lifecycle.shutdown.notified() => return Ok(()),
        };
        let handle = handle.clone();
        let token = token.clone();
        let lifecycle = Arc::clone(&lifecycle);
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, handle, token, lifecycle).await {
                eprintln!("warpforge: connection ended: {e}");
            }
        });
    }
}

async fn handle_conn(
    stream: TcpStream,
    handle: DaemonHandle,
    token: String,
    lifecycle: Arc<ServerLifecycle>,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut tx, mut rx) = ws.split();
    let mut events = handle.subscribe();
    let mut authed = token.is_empty();
    let mut subscribed = false;

    macro_rules! send {
        ($msg:expr) => {{
            let text = serde_json::to_string(&$msg)?;
            if tx.send(Message::Text(text)).await.is_err() {
                break;
            }
        }};
    }

    loop {
        tokio::select! {
            incoming = rx.next() => {
                let msg = match incoming {
                    Some(Ok(m)) => m,
                    _ => break,
                };
                let text = match msg {
                    Message::Text(t) => t.as_str().to_string(),
                    Message::Ping(p) => { let _ = tx.send(Message::Pong(p)).await; continue; }
                    Message::Close(_) => break,
                    _ => continue,
                };

                if !authed {
                    let ok = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v.get("auth").and_then(|a| a.as_str()).map(str::to_string))
                        .map(|got| got == token)
                        .unwrap_or(false);
                    if ok {
                        authed = true;
                    } else {
                        let _ = tx.send(Message::Close(None)).await;
                        break;
                    }
                    continue;
                }

                let req: wire::Request = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(_) => continue, // ignore malformed frames (no id to reply to)
                };
                let id = req.id;

                if matches!(req.method, wire::Method::StateSubscribe { .. }) {
                    let snapshot = handle.snapshot().await;
                    send!(wire::ServerMessage::Response { id, result: json!(null) });
                    send!(wire::ServerMessage::Event(wire::Event::Snapshot(snapshot)));
                    subscribed = true;
                    continue;
                }

                let is_handoff = matches!(&req.method, wire::Method::UpdatePrepareShutdown { .. });
                let result = if method_is_mutation(&req.method) && !is_handoff {
                    let _guard = lifecycle.mutations.read().await;
                    if lifecycle.quiescing.load(Ordering::Acquire) {
                        Err(wire::RpcError {
                            code: wire::ErrorCode::Updating,
                            message: "daemon is quiescing for an application update".into(),
                        })
                    } else {
                        dispatch(&handle, req.method, &lifecycle).await
                    }
                } else {
                    dispatch(&handle, req.method, &lifecycle).await
                };

                let handoff_ready = is_handoff
                    && matches!(&result, Ok(value) if value.get("ready").and_then(|ready| ready.as_bool()) == Some(true));
                let message = match result {
                    Ok(result) => wire::ServerMessage::Response { id, result },
                    Err(error) => wire::ServerMessage::Error { id, error },
                };
                let text = serde_json::to_string(&message)?;
                let sent = tx.send(Message::Text(text)).await.is_ok();

                if handoff_ready {
                    // Queue the acknowledgement on the socket before stopping
                    // the accept loop. Even if the client disconnects at this
                    // point, the daemon must not remain stuck quiescing.
                    lifecycle.shutdown.notify_one();
                }
                if !sent {
                    break;
                }
            }
            event = events.recv() => {
                match event {
                    Ok(ev) if subscribed => {
                        if let Some(w) = wireconv::to_wire(&ev) {
                            send!(wire::ServerMessage::Event(w));
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {} // client can re-snapshot
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}

/// Translate a request method into daemon commands and a JSON result.
async fn dispatch(
    handle: &DaemonHandle,
    method: wire::Method,
    lifecycle: &Arc<ServerLifecycle>,
) -> Result<serde_json::Value, wire::RpcError> {
    use wire::Method::*;
    match method {
        SystemHandshake {
            client_version,
            protocol_version,
        } => Ok(json!(wire::DaemonHandshake {
            daemon_version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: wire::PROTOCOL_VERSION,
            owner: lifecycle.owner,
            protocol_compatible: protocol_version == wire::PROTOCOL_VERSION,
            exact_version_match: client_version == env!("CARGO_PKG_VERSION"),
        })),
        UpdatePrepareShutdown {
            expected_daemon_version,
            protocol_version,
        } => {
            if lifecycle.owner != wire::DaemonOwner::Desktop {
                return Err(wire::RpcError {
                    code: wire::ErrorCode::Conflict,
                    message: "the running daemon was started externally; stop it before updating"
                        .into(),
                });
            }
            if protocol_version != wire::PROTOCOL_VERSION
                || expected_daemon_version != env!("CARGO_PKG_VERSION")
            {
                return Err(wire::RpcError {
                    code: wire::ErrorCode::Conflict,
                    message: format!(
                        "daemon compatibility changed (expected version {expected_daemon_version}, protocol {protocol_version}; running version {}, protocol {})",
                        env!("CARGO_PKG_VERSION"),
                        wire::PROTOCOL_VERSION
                    ),
                });
            }

            // Wait for every mutation that already passed the gate to enqueue
            // (or complete) before taking the actor's safety snapshot.
            let _mutation_guard = lifecycle.mutations.write().await;

            if lifecycle
                .quiescing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err(wire::RpcError {
                    code: wire::ErrorCode::Updating,
                    message: "an update handoff is already in progress".into(),
                });
            }

            let blockers = handle.update_blockers().await;
            if !blockers.is_empty() {
                lifecycle.quiescing.store(false, Ordering::Release);
                return Ok(json!(wire::UpdateHandoff {
                    ready: false,
                    blockers,
                }));
            }

            Ok(json!(wire::UpdateHandoff {
                ready: true,
                blockers: Vec::new(),
            }))
        }
        StateSubscribe { .. } => Ok(json!(null)), // handled by caller
        RuntimeStopAll {} => {
            handle.send(Command::StopRuntime).await;
            Ok(json!(null))
        }
        ServiceLogs {
            project,
            service,
            after,
            limit,
        } => {
            let lines = handle.service_logs(&project, &service, after, limit).await;
            Ok(json!({ "lines": lines }))
        }
        ServiceStart { project, service } => {
            handle
                .send(Command::StartService { project, service })
                .await;
            Ok(json!(null))
        }
        ServiceStop { project, service } => {
            handle.send(Command::StopService { project, service }).await;
            Ok(json!(null))
        }
        ServiceRestart { project, service } => {
            handle
                .send(Command::RestartService { project, service })
                .await;
            Ok(json!(null))
        }
        ServiceStartAll { project } => {
            handle.send(Command::StartAllServices { project }).await;
            Ok(json!(null))
        }
        ServiceStopAll { project } => {
            handle.send(Command::StopProject { project }).await;
            Ok(json!(null))
        }
        PortForwardStartAll { project } => {
            handle.send(Command::StartAllPortForwards { project }).await;
            Ok(json!(null))
        }
        PortForwardStart { project, name } => {
            handle
                .send(Command::StartPortForward { project, name })
                .await;
            Ok(json!(null))
        }
        TaskCreate {
            project,
            prompt,
            agent,
            tags,
            include_runtime_context,
            worktree,
            parent_task_id,
            attachments,
            default_model,
            config_overrides,
        } => {
            let id = handle
                .create_task(
                    &project,
                    &prompt,
                    &agent,
                    tags,
                    include_runtime_context,
                    worktree,
                    parent_task_id,
                    attachments,
                    default_model,
                    config_overrides,
                )
                .await;
            Ok(json!({ "taskId": id }))
        }
        OrchestratorReadInbox { parent_task_id } => {
            let results = handle.read_inbox(&parent_task_id).await;
            Ok(json!({ "results": results }))
        }
        DiffGet { task_id } => {
            let diff = handle.diff(&task_id).await;
            serde_json::to_value(diff).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        DiffResolveHunk {
            task_id,
            file,
            hunk_index,
            resolution,
        } => {
            handle
                .send(Command::ResolveHunk {
                    task_id,
                    file,
                    hunk_index,
                    resolution,
                })
                .await;
            Ok(json!(null))
        }
        FileContents { task_id, path } => match handle.file_contents(&task_id, &path).await {
            Some(doc) => serde_json::to_value(doc).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            }),
            None => Err(wire::RpcError {
                code: wire::ErrorCode::NotFound,
                message: format!("cannot read {path}"),
            }),
        },
        FileList {
            task_id,
            project,
            include_ignored,
        } => {
            let files = handle.list_files(&task_id, project, include_ignored).await;
            serde_json::to_value(files).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        FileSave {
            task_id,
            path,
            content,
        } => {
            handle
                .send(Command::SaveFile {
                    task_id,
                    path,
                    content,
                })
                .await;
            Ok(json!(null))
        }
        GitCommit {
            task_id,
            message,
            files,
            amend,
        } => {
            handle
                .git_commit(&task_id, &message, files, amend)
                .await
                .map_err(|e| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: e,
                })?;
            Ok(json!(null))
        }
        GitUpdate { task_id } => {
            let result = handle.git_update(&task_id).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitBranches { task_id } => {
            let list = handle.git_branches(&task_id).await;
            serde_json::to_value(list).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitSwitchBranch { task_id, branch } => {
            let result = handle.git_switch_branch(&task_id, &branch).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitPushInfo { task_id } => {
            let info = handle
                .git_push_info(&task_id)
                .await
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })?;
            serde_json::to_value(info).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitPush { task_id, force } => {
            let result = handle.git_push(&task_id, force).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitCreatePr {
            task_id,
            title,
            body,
            base,
        } => {
            let url = handle
                .git_create_pr(&task_id, title, body, base)
                .await
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })?;
            Ok(json!({ "url": url }))
        }
        TextGenerate {
            task_id,
            agent_id,
            kind,
            model,
        } => {
            let text = handle
                .generate_text(&task_id, &agent_id, kind, model)
                .await
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })?;
            Ok(json!({ "text": text }))
        }
        TaskCancel { task_id } => {
            handle.send(Command::CancelTask { id: task_id }).await;
            Ok(json!(null))
        }
        TaskArchive { task_id } => {
            handle.send(Command::ArchiveTask { id: task_id }).await;
            Ok(json!(null))
        }
        TaskDelete { task_id } => {
            handle.send(Command::DeleteTask { id: task_id }).await;
            Ok(json!(null))
        }
        TaskSetTitle { task_id, title } => {
            handle.set_task_title(&task_id, &title).await;
            Ok(json!(null))
        }
        TaskMergeWorktree { task_id } => {
            let result = handle.merge_worktree(&task_id).await;
            match result {
                Ok(branch) => Ok(json!({ "ok": true, "branch": branch })),
                Err(e) => Err(wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: e,
                }),
            }
        }
        TaskListWorktrees { project } => {
            let wts = handle.list_worktrees(&project).await;
            Ok(json!({ "worktrees": wts }))
        }
        SessionsList { project } => {
            let sessions = handle.list_sessions(&project).await;
            Ok(json!({ "sessions": sessions }))
        }
        TaskResume {
            project,
            agent,
            session_id,
            title,
        } => {
            let id = handle
                .resume_task(&project, &agent, &session_id, &title)
                .await;
            Ok(json!({ "taskId": id }))
        }
        SessionPrompt {
            task_id,
            text,
            attachments,
        } => handle
            .session_prompt(&task_id, &text, attachments)
            .await
            .map(|_| json!(null))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::InvalidRequest,
                message,
            }),
        SessionSetConfigOption {
            task_id,
            config_id,
            value,
        } => {
            handle
                .session_set_config_option(&task_id, &config_id, &value)
                .await;
            Ok(json!(null))
        }
        SessionPermission {
            task_id,
            request_id,
            outcome,
        } => {
            let outcome = match outcome {
                wire::PermissionOutcome::Allow => "allow",
                wire::PermissionOutcome::AllowAlways => "allow_always",
                wire::PermissionOutcome::Deny => "deny",
            };
            handle
                .session_permission(&task_id, &request_id, outcome)
                .await;
            Ok(json!(null))
        }
        PortForwardStop { project, name } => {
            handle
                .send(Command::StopPortForward { project, name })
                .await;
            Ok(json!(null))
        }
        PortForwardStopAll { project } => {
            handle.send(Command::StopAllPortForwards { project }).await;
            Ok(json!(null))
        }
        PortForwardLogs {
            project,
            name,
            after,
            limit,
        } => {
            let lines = handle.portforward_logs(&project, &name, after, limit).await;
            Ok(json!({ "lines": lines }))
        }
        // ── Legacy PTY terminals (the TUI's live agent panes) ──
        TerminalSpawn { project, command } => {
            let id = handle
                .spawn_agent(&project, &command, "", 120, 40)
                .await
                .map_err(|e| wire::RpcError {
                    code: wire::ErrorCode::AgentUnavailable,
                    message: e.to_string(),
                })?;
            Ok(json!({ "terminalId": id }))
        }
        TerminalInput {
            terminal_id,
            data_b64,
        } => {
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                Ok(data) => {
                    handle
                        .send(Command::WriteAgent {
                            id: terminal_id,
                            data,
                        })
                        .await;
                    Ok(json!(null))
                }
                Err(e) => Err(wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: format!("bad base64: {e}"),
                }),
            }
        }
        TerminalResize {
            terminal_id,
            cols,
            rows,
        } => {
            handle
                .send(Command::ResizeAgent {
                    id: terminal_id,
                    cols,
                    rows,
                })
                .await;
            Ok(json!(null))
        }
        TerminalKill { terminal_id } => {
            handle.send(Command::KillAgent { id: terminal_id }).await;
            Ok(json!(null))
        }
        AgentsDetect {} => {
            let detected = handle.detect_agents().await;
            serde_json::to_value(detected).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        AgentsUpdate { agents } => {
            handle.update_agents(agents).await;
            Ok(json!(null))
        }
        AgentsInstall { id } => {
            let Some(command) = crate::daemon::agents::manage_command(&id).await else {
                return Err(wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: format!("no automated install/update available for agent '{id}'"),
                });
            };
            let (ok, output) = crate::daemon::agents::run_manage_command(&command).await;
            Ok(json!({ "ok": ok, "command": command, "output": output }))
        }
        // ── Orchestration ──
        OrchestrateStart { project, goal } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::StartOrchestration {
                    project,
                    goal,
                    reply: tx,
                })
                .await;
            let (graph_id, task_id) = rx.await.unwrap_or_default();
            Ok(json!({ "graphId": graph_id, "taskId": task_id }))
        }
        OrchestrateList {} => {
            let (tx, rx) = oneshot::channel();
            handle.send(Command::ListOrchestrations { reply: tx }).await;
            let infos = rx.await.unwrap_or_default();
            Ok(json!({ "graphs": infos }))
        }
        OrchestrateCancel { .. } => {
            // TODO: wire through to orchestrator
            Ok(json!(null))
        }
        OrchestrateGetConfig {} => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::GetOrchestratorConfig { reply: tx })
                .await;
            let config = rx.await.unwrap_or_default();
            Ok(json!(config))
        }
        OrchestrateSaveConfig { config } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::SaveOrchestratorConfig { config, reply: tx })
                .await;
            let ok = rx.await.unwrap_or(false);
            Ok(json!({ "ok": ok }))
        }
        ProjectAdd { path, name } => {
            let entry = handle
                .add_project(&path, name.as_deref())
                .await
                .map_err(|e| wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: e,
                })?;
            Ok(json!({ "name": entry.name, "path": entry.path }))
        }
        ProjectRemove { name } => {
            handle
                .remove_project(&name)
                .await
                .map_err(|e| wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: e,
                })?;
            Ok(json!(null))
        }
        BootstrapStart { project, answers } => {
            let path = project_path(handle, &project).await?;
            let ctx = bootstrap_context(&path, answers);
            let system_prompt = crate::bootstrap::build_system_prompt(&ctx);
            let user_prompt = crate::bootstrap::build_user_prompt(&ctx);
            let prompt =
                format!("## System Context\n\n{system_prompt}\n\n---\n\n## Task\n\n{user_prompt}");
            let id = handle
                .create_task(
                    &project,
                    &prompt,
                    &ctx.user_answers.agent,
                    vec!["bootstrap".into(), "config-gen".into()],
                    false,
                    false,
                    None,
                    Vec::new(),
                    None,
                    std::collections::HashMap::new(),
                )
                .await;
            Ok(json!({ "taskId": id }))
        }
        BootstrapFinalize { response } => {
            let yaml = crate::bootstrap::extract_yaml_from_response(&response);
            let issues = validate_issues(&yaml);
            Ok(json!({ "yaml": yaml, "issues": issues }))
        }
        BootstrapReadConfig { project } => {
            let path = project_path(handle, &project).await?;
            let target = crate::config::find_config_file(std::path::Path::new(&path));
            let yaml = std::fs::read_to_string(&target).unwrap_or_default();
            let issues = validate_issues(&yaml);
            Ok(json!({ "yaml": yaml, "issues": issues }))
        }
        BootstrapWriteConfig { project, yaml } => {
            let path = project_path(handle, &project).await?;
            let target = crate::config::find_config_file(std::path::Path::new(&path));
            std::fs::write(&target, yaml).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: format!("write {}: {e}", target.display()),
            })?;
            Ok(json!({ "ok": true, "path": target.to_string_lossy() }))
        }
    }
}

/// Validate a config YAML into a JSON list of `{ severity, message }` issues.
/// A parse error is reported as a single error-severity issue.
fn validate_issues(yaml: &str) -> Vec<serde_json::Value> {
    match crate::bootstrap::validate_config_yaml(yaml) {
        Ok((_, issues)) => issues
            .into_iter()
            .map(|i| {
                let severity = match i.severity {
                    crate::bootstrap::IssueSeverity::Error => "error",
                    crate::bootstrap::IssueSeverity::Warning => "warning",
                };
                json!({ "severity": severity, "message": i.message })
            })
            .collect(),
        Err(e) => vec![json!({ "severity": "error", "message": e })],
    }
}

/// Resolve a registered project's directory, or an `InvalidRequest` error.
async fn project_path(handle: &DaemonHandle, project: &str) -> Result<String, wire::RpcError> {
    handle
        .projects()
        .await
        .into_iter()
        .find(|p| p.name == project)
        .map(|p| p.path)
        .ok_or_else(|| wire::RpcError {
            code: wire::ErrorCode::NotFound,
            message: format!("unknown project '{project}'"),
        })
}

/// Build a [`BootstrapContext`] by scanning the repo and reading its current
/// config, combined with the wizard answers.
fn bootstrap_context(
    project_path: &str,
    answers: wire::BootstrapAnswers,
) -> crate::bootstrap::BootstrapContext {
    use crate::bootstrap::{BootstrapContext, ServiceRuntimeKind, UserRuntimeAnswers};
    let existing = crate::config::find_config_file(std::path::Path::new(project_path));
    let existing_config_yaml = std::fs::read_to_string(&existing).unwrap_or_default();
    let runtime_kind = match answers.runtime_kind.as_str() {
        "docker-compose" => ServiceRuntimeKind::DockerCompose,
        "kubernetes" => ServiceRuntimeKind::Kubernetes,
        "mixed" => ServiceRuntimeKind::Mixed,
        _ => ServiceRuntimeKind::Local,
    };
    BootstrapContext {
        repo_summary: crate::bootstrap::build_repo_summary(project_path),
        existing_config_yaml,
        project_path: project_path.to_string(),
        user_answers: UserRuntimeAnswers {
            agent: answers.agent,
            runtime_kind,
            compose_path: answers.compose_path,
            k8s_manifests_path: answers.k8s_manifests_path,
            k8s_helm_file: answers.k8s_helm_file,
            k8s_release_names: answers.k8s_release_names,
            k8s_namespace: answers.k8s_namespace,
            dev_commands: answers.dev_commands,
            notes: answers.notes,
        },
    }
}

fn method_is_mutation(method: &wire::Method) -> bool {
    use wire::Method::*;
    !matches!(
        method,
        SystemHandshake { .. }
            | StateSubscribe { .. }
            | ServiceLogs { .. }
            | PortForwardLogs { .. }
            | TaskListWorktrees { .. }
            | SessionsList { .. }
            | AgentsDetect {}
            | DiffGet { .. }
            | FileContents { .. }
            | FileList { .. }
            | GitBranches { .. }
            | GitPushInfo { .. }
            | OrchestrateList {}
            | OrchestrateGetConfig {}
            | BootstrapFinalize { .. }
            | BootstrapReadConfig { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::{Daemon, Store};
    use crate::registry::ProjectEntry;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn subscribe_then_create_task_over_websocket() {
        // Daemon with one project, in-memory store.
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: ".".into(),
            added_at: "0".into(),
        }];
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let handle = Daemon::spawn(projects, store);

        // Serve on an ephemeral port with no auth.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, handle.clone(), String::new()));

        // Connect a client.
        let url = format!("ws://{addr}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

        // Subscribe.
        ws.send(Message::Text(
            json!({ "id": 1, "method": "state.subscribe", "params": { "topics": [] } }).to_string(),
        ))
        .await
        .unwrap();

        // Expect: an ack response, then a state.snapshot event with our project.
        let mut saw_snapshot = false;
        for _ in 0..3 {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("frame")
                .expect("some")
                .expect("ok");
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                if v.get("event").and_then(|e| e.as_str()) == Some("state.snapshot") {
                    assert_eq!(v["data"]["projects"][0]["name"], "demo");
                    saw_snapshot = true;
                    break;
                }
            }
        }
        assert!(saw_snapshot, "expected a state.snapshot event");

        // Create a task over the socket.
        ws.send(Message::Text(
            json!({
                "id": 2,
                "method": "task.create",
                "params": { "project": "demo", "prompt": "do it", "agent": "claude" }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        // Expect a task.created event and a response with a taskId.
        let mut saw_created = false;
        let mut saw_response = false;
        for _ in 0..5 {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("frame")
                .expect("some")
                .expect("ok");
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                if v.get("event").and_then(|e| e.as_str()) == Some("task.created") {
                    assert_eq!(v["data"]["project"], "demo");
                    assert_eq!(v["data"]["prompt"], "do it");
                    saw_created = true;
                }
                if v.get("id").and_then(|i| i.as_u64()) == Some(2) {
                    assert!(v["result"]["taskId"].as_str().unwrap().starts_with("t_"));
                    saw_response = true;
                }
            }
            if saw_created && saw_response {
                break;
            }
        }
        assert!(saw_created, "expected a task.created event");
        assert!(saw_response, "expected a response with a taskId");
    }

    #[tokio::test]
    async fn spawn_terminal_streams_screen_over_websocket() {
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: ".".into(),
            added_at: "0".into(),
        }];
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let handle = Daemon::spawn(projects, store);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, handle.clone(), String::new()));

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        ws.send(Message::Text(
            json!({ "id": 1, "method": "state.subscribe", "params": {} }).to_string(),
        ))
        .await
        .unwrap();

        // Spawn a PTY that prints a marker.
        ws.send(Message::Text(
            json!({
                "id": 2, "method": "terminal.spawn",
                "params": { "project": "demo", "command": "printf WARPMARK; sleep 2" }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        // Expect a terminal.screen event whose rows contain the marker.
        let mut saw_marker = false;
        for _ in 0..40 {
            let msg = match timeout(Duration::from_secs(3), ws.next()).await {
                Ok(Some(Ok(m))) => m,
                _ => break,
            };
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                if v.get("event").and_then(|e| e.as_str()) == Some("terminal.screen") {
                    let text = v["data"]["screen"].to_string();
                    if text.contains("WARPMARK") {
                        saw_marker = true;
                        break;
                    }
                }
            }
        }
        assert!(
            saw_marker,
            "expected a terminal.screen event containing the printed marker"
        );
    }

    #[tokio::test]
    async fn handshake_reports_protocol_version_and_external_owner() {
        let handle = Daemon::spawn(Vec::new(), None);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, handle, String::new()));

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        ws.send(Message::Text(
            json!({
                "id": 1,
                "method": "system.handshake",
                "params": {
                    "client_version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": wire::PROTOCOL_VERSION
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let Message::Text(frame) = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("expected text response");
        };
        let response: serde_json::Value = serde_json::from_str(frame.as_str()).unwrap();
        assert_eq!(
            response["result"]["protocolVersion"],
            wire::PROTOCOL_VERSION
        );
        assert_eq!(response["result"]["owner"], "external");
        assert_eq!(response["result"]["protocolCompatible"], true);
        assert_eq!(response["result"]["exactVersionMatch"], true);
    }

    #[tokio::test]
    async fn update_handoff_refuses_external_daemon() {
        let handle = Daemon::spawn(Vec::new(), None);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, handle, String::new()));

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        ws.send(Message::Text(
            json!({
                "id": 1,
                "method": "update.prepareShutdown",
                "params": {
                    "expected_daemon_version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": wire::PROTOCOL_VERSION
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let Message::Text(frame) = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("expected text response");
        };
        let response: serde_json::Value = serde_json::from_str(frame.as_str()).unwrap();
        assert_eq!(response["error"]["code"], "conflict");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("started externally"));
    }

    #[tokio::test]
    async fn desktop_update_handoff_acknowledges_then_stops_server() {
        let handle = Daemon::spawn(Vec::new(), None);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let lifecycle = Arc::new(ServerLifecycle::new(wire::DaemonOwner::Desktop));
        let server = tokio::spawn(run_controlled(listener, handle, String::new(), lifecycle));

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        ws.send(Message::Text(
            json!({
                "id": 1,
                "method": "update.prepareShutdown",
                "params": {
                    "expected_daemon_version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": wire::PROTOCOL_VERSION
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let Message::Text(frame) = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("expected text response");
        };
        let response: serde_json::Value = serde_json::from_str(frame.as_str()).unwrap();
        assert_eq!(response["result"]["ready"], true);
        timeout(Duration::from_secs(2), server)
            .await
            .expect("server should stop after acknowledging handoff")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn refused_handoff_reopens_mutation_gate() {
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: ".".into(),
            added_at: "0".into(),
        }];
        let handle = Daemon::spawn(projects, None);
        let task_id = handle
            .create_task(
                "demo",
                "keep working",
                "definitely-not-an-installed-agent",
                Vec::new(),
                false,
                false,
                None,
                Vec::new(),
                None,
                std::collections::HashMap::new(),
            )
            .await;
        handle
            .set_task_status(&task_id, crate::daemon::TaskStatus::Queued)
            .await;
        // A query is an actor-queue barrier for the status update above.
        let _ = handle.tasks().await;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let lifecycle = Arc::new(ServerLifecycle::new(wire::DaemonOwner::Desktop));
        tokio::spawn(run_controlled(listener, handle, String::new(), lifecycle));

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        ws.send(Message::Text(
            json!({
                "id": 1,
                "method": "update.prepareShutdown",
                "params": {
                    "expected_daemon_version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": wire::PROTOCOL_VERSION
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let Message::Text(frame) = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("expected handoff response");
        };
        let response: serde_json::Value = serde_json::from_str(frame.as_str()).unwrap();
        assert_eq!(response["result"]["ready"], false);
        assert!(response["result"]["blockers"][0]
            .as_str()
            .unwrap()
            .contains("agent task"));

        // A refused handoff must clear quiescing so ordinary mutations work.
        ws.send(Message::Text(
            json!({
                "id": 2,
                "method": "agents.update",
                "params": { "agents": [] }
            })
            .to_string(),
        ))
        .await
        .unwrap();
        let Message::Text(frame) = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            panic!("expected mutation response");
        };
        let response: serde_json::Value = serde_json::from_str(frame.as_str()).unwrap();
        assert_eq!(response["id"], 2);
        assert!(response.get("result").is_some());
        assert!(response.get("error").is_none());
    }

    #[tokio::test]
    async fn config_save_broadcasts_project_config_changed() {
        let project_dir = tempfile::tempdir().unwrap();
        let config_path = project_dir.path().join(".warpforge.yaml");
        std::fs::write(
            &config_path,
            "name: demo\nservices:\n  old:\n    command: old\n    port: 3000\n",
        )
        .unwrap();
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: project_dir.path().to_string_lossy().into_owned(),
            added_at: "0".into(),
        }];
        let handle = Daemon::spawn(projects, None);
        let mut events = handle.subscribe();
        std::fs::write(
            &config_path,
            "name: demo\nservices:\n  web:\n    command: bun dev\n    port: 5173\nportforwards:\n  - name: db\n    namespace: dev\n    pod: postgres\n    localPort: 5432\n    remotePort: 5432\n",
        )
        .unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let event = timeout(remaining, events.recv())
                .await
                .expect("project.configChanged event")
                .expect("daemon event");
            if let crate::daemon::Event::ProjectConfigChanged(config) = event {
                assert_eq!(config.project.declared_services, ["web"]);
                assert_eq!(config.services[0].command, "bun dev");
                assert_eq!(config.portforwards[0].name, "db");
                break;
            }
        }
    }
}
