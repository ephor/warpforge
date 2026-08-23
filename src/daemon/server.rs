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
use tokio::sync::{mpsc, Notify, RwLock, Semaphore};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;
use warpforge_protocol as wire;

use super::actor::{Command, DaemonHandle};
use super::attachment;
use super::tracker;
use super::wire as wireconv;

/// Outgoing frames buffered per connection before the read loop slows down.
const OUTGOING_QUEUE: usize = 256;

/// Requests one connection may have in flight at once. Concurrent requests
/// answer off the read loop, so without a cap a client could fan out unbounded
/// git, filesystem and subprocess work by sending faster than the daemon
/// completes it.
const MAX_CONCURRENT_REQUESTS: usize = 8;

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
        // Replies are small frames. Left to Nagle they wait on an ACK for the
        // previous one, which pairs with the peer's delayed ACK to add tens of
        // milliseconds to an otherwise instant answer.
        let _ = stream.set_nodelay(true);
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
    let (mut sink, mut rx) = ws.split();
    let mut events = handle.subscribe();
    let mut authed = token.is_empty();
    let mut subscribed = false;

    // One writer owns the socket so read requests answered off the read loop
    // have somewhere to reply to. Bounded: a client that stops draining slows
    // its own connection rather than growing the queue without limit.
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUTGOING_QUEUE);
    tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    // Caps the work one client can have in flight at once.
    let request_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS));

    macro_rules! send {
        ($msg:expr) => {{
            let text = serde_json::to_string(&$msg)?;
            if out_tx.send(Message::Text(text)).await.is_err() {
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
                    Message::Ping(p) => { let _ = out_tx.send(Message::Pong(p)).await; continue; }
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
                        let _ = out_tx.send(Message::Close(None)).await;
                        break;
                    }
                    continue;
                }

                let req: wire::Request = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(error) => {
                        // A frame that carries a request id but fails to parse
                        // (unknown method, params that don't match the variant)
                        // must still be answered: dropping it silently leaves
                        // the caller's promise pending forever, which surfaces
                        // as a spinner that never stops.
                        if let Some(id) = serde_json::from_str::<serde_json::Value>(&text)
                            .ok()
                            .and_then(|v| v.get("id").and_then(serde_json::Value::as_u64))
                        {
                            send!(wire::ServerMessage::Error {
                                id,
                                error: wire::RpcError {
                                    code: wire::ErrorCode::InvalidRequest,
                                    message: format!("unrecognized request: {error}"),
                                },
                            });
                        }
                        continue;
                    }
                };
                let id = req.id;

                if matches!(req.method, wire::Method::StateSubscribe { .. }) {
                    let snapshot = handle.snapshot().await;
                    send!(wire::ServerMessage::Response { id, result: json!(null) });
                    send!(wire::ServerMessage::Event(wire::Event::Snapshot(snapshot)));
                    subscribed = true;
                    continue;
                }

                // Independent requests answer without holding up the next one.
                // Until now a connection served one request at a time, so a
                // tool approval was not even read off the socket while a title
                // was being generated ahead of it (ADR 0002).
                if method_runs_concurrently(&req.method) {
                    let gated = method_is_mutation(&req.method);
                    let handle = handle.clone();
                    let lifecycle = Arc::clone(&lifecycle);
                    let out = out_tx.clone();
                    let slots = Arc::clone(&request_slots);
                    tokio::spawn(async move {
                        let _permit = slots.acquire_owned().await;
                        // The same update gate the serial path applies, kept
                        // here so moving a method between the two lists cannot
                        // quietly let it run during a daemon handover.
                        let result = if gated {
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
                        let message = match result {
                            Ok(result) => wire::ServerMessage::Response { id, result },
                            Err(error) => wire::ServerMessage::Error { id, error },
                        };
                        if let Ok(text) = serde_json::to_string(&message) {
                            let _ = out.send(Message::Text(text)).await;
                        }
                    });
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
                let sent = out_tx.send(Message::Text(text)).await.is_ok();

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

/// Map a memory-store error onto the wire: scope violations (and the disabled
/// store) are client errors; anything else is an internal failure.
fn memory_error(e: super::memory::MemoryError) -> wire::RpcError {
    wire::RpcError {
        code: e.code(),
        message: e.message(),
    }
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
        LspStart { task_id, language } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::LspStart {
                    task_id,
                    language,
                    reply: tx,
                })
                .await;
            match rx.await {
                Ok(result) => Ok(json!(result)),
                Err(_) => Err(wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: "daemon dropped the lsp.start reply".into(),
                }),
            }
        }
        LspSend { server_id, payload } => {
            handle.send(Command::LspSend { server_id, payload }).await;
            Ok(json!(null))
        }
        LspStop { server_id } => {
            handle.send(Command::LspStop { server_id }).await;
            Ok(json!(null))
        }
        LanguageServersDetect {} => {
            let detected = crate::daemon::lsp_servers::detect_language_servers().await;
            serde_json::to_value(detected).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        LanguageServersInstall { id } => {
            let Some(command) = crate::daemon::lsp_servers::manage_command(&id).await else {
                return Err(wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: format!(
                        "no automated install/update available for language server '{id}'"
                    ),
                });
            };
            let (ok, output) = crate::daemon::agents::run_manage_command(&command).await;
            Ok(json!({ "ok": ok, "command": command, "output": output }))
        }
        ServiceLogs {
            project,
            service,
            after,
            limit,
        } => {
            let (lines, at, next_seq) = handle.service_logs(&project, &service, after, limit).await;
            Ok(json!({ "lines": lines, "at": at, "nextSeq": next_seq }))
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
            workflow,
            backlog_item_id,
            start,
        } => {
            if let Some(workflow) = workflow {
                let (tx, rx) = oneshot::channel();
                handle
                    .send(Command::CreateWorkflowTask {
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
                        reply: tx,
                    })
                    .await;
                let id = rx
                    .await
                    .unwrap_or_else(|_| Err("daemon closed".into()))
                    .map_err(|e| wire::RpcError {
                        code: wire::ErrorCode::InvalidRequest,
                        message: e,
                    })?;
                return Ok(json!({ "taskId": id }));
            }
            let id = if !start {
                handle
                    .queue_task(
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
                        backlog_item_id,
                    )
                    .await
            } else {
                handle
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
                        backlog_item_id,
                    )
                    .await
            };
            Ok(json!({ "taskId": id }))
        }
        OrchestratorReadInbox { parent_task_id } => {
            let results = handle.read_inbox(&parent_task_id).await;
            Ok(json!({ "results": results }))
        }
        OrchestratorListAgents {
            parent_task_id,
            project,
        } => {
            if parent_task_id.trim().is_empty() {
                return Err(wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: "parent_task_id must not be empty".into(),
                });
            }
            let agents: Vec<wire::TaskInfo> = handle
                .tasks()
                .await
                .into_iter()
                .filter(|task| {
                    task.parent_task_id.as_deref() == Some(parent_task_id.as_str())
                        && project
                            .as_deref()
                            .is_none_or(|project| task.project == project)
                })
                .map(|task| wireconv::task_info(&task))
                .collect();
            Ok(json!({ "agents": agents }))
        }
        DiffGet { task_id } => {
            let diff = handle.diff(&task_id).await;
            serde_json::to_value(diff).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        MemoryStore {
            content,
            scope,
            kind,
            tags,
            project_id,
        } => handle
            .memory_store(
                &content,
                scope.as_deref(),
                kind.as_deref(),
                tags.as_deref(),
                project_id.as_deref(),
                None,
            )
            .await
            .map_err(memory_error),
        MemorySearch {
            query,
            scope,
            limit,
            mode,
        } => handle
            .memory_search(&query, scope.as_deref(), limit, mode.as_deref())
            .await
            .map_err(memory_error),
        MemoryList {
            scope,
            kind,
            limit,
            offset,
        } => handle
            .memory_list(scope.as_deref(), kind.as_deref(), limit, offset)
            .await
            .map_err(memory_error),
        MemoryUpdate { id, content } => handle
            .memory_update(&id, &content)
            .await
            .map_err(memory_error),
        MemoryDelete { id } => handle
            .memory_delete(&id)
            .await
            .map(|_| json!(null))
            .map_err(memory_error),
        MemoryStats {} => handle.memory_stats().await.map_err(memory_error),
        MemorySetEmbedding { mode } => handle
            .set_memory_embedding(&mode)
            .await
            .map_err(memory_error),
        MemoryAddEdge {
            src_id,
            dst_id,
            relation,
        } => handle
            .memory_add_edge(&src_id, &dst_id, &relation)
            .await
            .map_err(memory_error),
        MemoryEdges { id } => handle.memory_edges(&id).await.map_err(memory_error),
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
        FileContents {
            task_id,
            path,
            project,
        } => match handle.file_contents(&task_id, &path, project).await {
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
        FileCreate {
            task_id,
            path,
            directory,
        } => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            handle
                .send(Command::CreateFile {
                    task_id,
                    path,
                    directory,
                    reply: tx,
                })
                .await;
            rx.await
                .map_err(|_| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: "daemon dropped file create request".into(),
                })?
                .map(|_| json!(null))
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })
        }
        FileRename {
            task_id,
            path,
            new_path,
        } => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            handle
                .send(Command::RenameFile {
                    task_id,
                    path,
                    new_path,
                    reply: tx,
                })
                .await;
            rx.await
                .map_err(|_| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: "daemon dropped file rename request".into(),
                })?
                .map(|_| json!(null))
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })
        }
        FileDelete { task_id, path } => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            handle
                .send(Command::DeleteFile {
                    task_id,
                    path,
                    reply: tx,
                })
                .await;
            rx.await
                .map_err(|_| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: "daemon dropped file delete request".into(),
                })?
                .map(|_| json!(null))
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })
        }
        FileSearch {
            task_id,
            query,
            limit,
        } => {
            let matches = handle.search_files(&task_id, &query, limit).await;
            serde_json::to_value(matches).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
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
        GitBranches { task_id, project } => {
            let list = handle.git_branches(task_id, project).await;
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
        GitBranchRename {
            task_id,
            branch,
            new_name,
        } => {
            let result = handle.git_branch_rename(&task_id, &branch, &new_name).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitBranchDelete {
            task_id,
            branch,
            force,
        } => {
            let result = handle.git_branch_delete(&task_id, &branch, force).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitBranchCreate {
            task_id,
            name,
            from,
            checkout,
            overwrite,
        } => {
            let result = handle
                .git_branch_create(&task_id, &name, from, checkout, overwrite)
                .await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitRebase {
            task_id,
            branch,
            target,
        } => {
            let result = handle.git_rebase(&task_id, &branch, &target).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitMerge { task_id, target } => {
            let result = handle.git_merge(&task_id, &target).await;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        GitLastCommitMessage { task_id } => handle
            .git_last_commit_message(&task_id)
            .await
            .map(|message| json!({ "message": message }))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message,
            }),
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
        TextEnhance {
            project,
            agent_id,
            prompt,
            model,
        } => {
            let text = handle
                .enhance_text(&project, &agent_id, &prompt, model)
                .await
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })?;
            Ok(json!({ "text": text }))
        }
        TaskCancel { task_id } => {
            handle
                .cancel_task(&task_id)
                .await
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })?;
            Ok(json!(null))
        }
        TaskArchive { task_id } => {
            handle.send(Command::ArchiveTask { id: task_id }).await;
            Ok(json!(null))
        }
        TaskDelete { task_id } => {
            handle
                .delete_task(&task_id)
                .await
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message,
                })?;
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
        TaskSettle { task_id } => handle
            .settle_task(&task_id)
            .await
            .map(|_| json!(null))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::InvalidRequest,
                message,
            }),
        TaskUnsettle { task_id } => handle
            .unsettle_task(&task_id)
            .await
            .map(|_| json!(null))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::InvalidRequest,
                message,
            }),
        TaskSnooze { task_id, until } => handle
            .snooze_task(&task_id, until)
            .await
            .map(|_| json!(null))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::InvalidRequest,
                message,
            }),
        TaskUnsnooze { task_id } => handle
            .unsnooze_task(&task_id)
            .await
            .map(|_| json!(null))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::InvalidRequest,
                message,
            }),
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
        } => handle
            .session_set_config_option(&task_id, &config_id, &value)
            .await
            .map(|()| json!(null))
            .map_err(|message| wire::RpcError {
                code: wire::ErrorCode::InvalidRequest,
                message,
            }),
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
            let (lines, at, next_seq) =
                handle.portforward_logs(&project, &name, after, limit).await;
            Ok(json!({ "lines": lines, "at": at, "nextSeq": next_seq }))
        }
        RuntimeList { project } => {
            let snapshot = handle.snapshot().await;
            let services: Vec<_> = snapshot
                .services
                .into_iter()
                .filter(|s| s.project == project)
                .collect();
            let portforwards: Vec<_> = snapshot
                .portforwards
                .into_iter()
                .filter(|pf| pf.project == project)
                .collect();
            Ok(json!({ "services": services, "portforwards": portforwards }))
        }
        // ── Legacy PTY terminals (the TUI's live agent panes) ──
        TerminalSpawn {
            project,
            command,
            cols,
            rows,
        } => {
            let id = handle
                .spawn_agent(&project, &command, "", cols, rows)
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
        AgentsProbe { id } => {
            handle
                .probe_agent(&id)
                .await
                .map(|()| json!(null))
                .map_err(|message| wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message,
                })
        }
        // ── Agent accounts ──
        AccountsList {} => Ok(json!({ "accounts": handle.list_accounts().await })),
        AccountsImport { agent_id, label } => {
            accounts_result(handle.import_account(agent_id, label).await)
        }
        AccountsRename { account_id, label } => {
            accounts_result(handle.rename_account(account_id, label).await)
        }
        AccountsRemove { account_id } => accounts_result(handle.remove_account(account_id).await),
        AccountsSetActive {
            agent_id,
            account_id,
        } => accounts_result(handle.set_active_account(agent_id, account_id).await),
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
        // ── Workflows ──
        WorkflowList { project } => {
            let path = project_path(handle, &project).await?;
            let workflows: Vec<wire::WorkflowMeta> =
                crate::workflow_config::list_workflows(std::path::Path::new(&path))
                    .into_iter()
                    .map(workflow_meta)
                    .collect();
            Ok(json!({ "workflows": workflows }))
        }
        WorkflowEject { project, id } => {
            let path = project_path(handle, &project).await?;
            let target = crate::workflow_config::eject_builtin(std::path::Path::new(&path), &id)
                .map_err(|e| wire::RpcError {
                    code: wire::ErrorCode::InvalidRequest,
                    message: format!("{e:#}"),
                })?;
            Ok(json!({ "path": target.to_string_lossy() }))
        }
        WorkflowPause { task } => {
            workflow_control(handle, |reply| Command::WorkflowPause { task, reply }).await
        }
        WorkflowResume { task, note } => {
            workflow_control(handle, |reply| Command::WorkflowResume {
                task,
                note,
                reply,
            })
            .await
        }
        WorkflowReply { task, message } => {
            workflow_control(handle, |reply| Command::WorkflowReply {
                task,
                message,
                reply,
            })
            .await
        }
        WorkflowDecide {
            task,
            decision,
            rounds,
            note,
        } => {
            workflow_control(handle, |reply| Command::WorkflowDecide {
                task,
                decision,
                rounds,
                note,
                reply,
            })
            .await
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
        ProjectRemove {
            name,
            stop_resources,
        } => {
            handle
                .remove_project(&name, stop_resources)
                .await
                .map_err(|error| {
                    let code = match error {
                        super::actor::ProjectRemovalError::Conflict(_) => wire::ErrorCode::Conflict,
                        super::actor::ProjectRemovalError::NotFound(_) => wire::ErrorCode::NotFound,
                        super::actor::ProjectRemovalError::Internal(_) => wire::ErrorCode::Internal,
                    };
                    wire::RpcError {
                        code,
                        message: error.to_string(),
                    }
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
                    None,
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
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: format!("create {}: {e}", parent.display()),
                })?;
            }
            std::fs::write(&target, yaml).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: format!("write {}: {e}", target.display()),
            })?;
            Ok(json!({ "ok": true, "path": target.to_string_lossy() }))
        }
        // The tracker calls below run on this request task, never inside the
        // actor: the actor loop is single-threaded and awaits its handlers
        // inline, so a `gh` spawn made in there stalls every project until the
        // network answers. Only the store writes go through the actor.
        TrackerStatus {} => {
            let status = tracker::status().await;
            serde_json::to_value(status).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        TrackerConnectLinear { api_key } => {
            tracker::connect_linear(&api_key)
                .await
                .map_err(|e| rpc_err(format!("{e:#}")))?;
            serde_json::to_value(tracker::status().await).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        TrackerDisconnectLinear {} => {
            tracker::disconnect_linear()
                .await
                .map_err(|e| rpc_err(format!("{e:#}")))?;
            serde_json::to_value(tracker::status().await).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        TrackerConnectGithub {} => {
            if tracker::github_login().await.is_none() {
                return Err(rpc_err(
                    "GitHub CLI is not authenticated. Run `gh auth login` first.".to_string(),
                ));
            }
            serde_json::to_value(tracker::status().await).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        TrackerDisconnectGithub {} => {
            // GitHub rides on the `gh` CLI session; nothing daemon-owned to
            // delete except links, which belong to backlog items (kept).
            serde_json::to_value(tracker::status().await).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        TrackerLinks {} => {
            let links = handle.tracker_links().await.map_err(rpc_err)?;
            Ok(json!({ "links": links }))
        }
        WorkItemCreateExternal {
            item_id,
            provider,
            project,
            title,
            body,
            priority: _priority,
            status: _status,
        } => {
            let repo_dir = if provider == "github" {
                Some(project_path(handle, &project).await?)
            } else {
                None
            };
            // A project pointed at a Linear team creates there; otherwise Linear
            // picks the account's first team, as it did before mapping existed.
            let linear_team = handle
                .tracker_project_settings(&project)
                .await
                .ok()
                .and_then(|settings| settings.linear_team_id);
            let (external_id, url) = tracker::create_external(
                &provider,
                repo_dir.as_deref(),
                &title,
                &body,
                linear_team.as_deref(),
            )
            .await
            .map_err(|e| rpc_err(format!("{e:#}")))?;
            let link = tracker::make_link(&item_id, &provider, &project, &external_id, &url, false);
            handle.tracker_persist_link(link).await.map_err(rpc_err)?;
            let result = wire::CreateExternalResult {
                item_id,
                provider,
                external_id,
                url,
                status: "todo".into(),
            };
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        TrackerLinearTeams {} => {
            let teams = tracker::linear_teams()
                .await
                .map_err(|e| rpc_err(format!("{e:#}")))?;
            Ok(json!({ "teams": teams }))
        }
        // Network on the request task, never through the actor (ADR-0002
        // invariant 1) — an image fetch must not stall every other project.
        TrackerAttachment { url } => {
            let attachment = attachment::fetch(&url)
                .await
                .map_err(|e| rpc_err(format!("{e:#}")))?;
            serde_json::to_value(attachment).map_err(|e| rpc_err(e.to_string()))
        }
        TrackerProjectSettings { project } => {
            let settings = handle
                .tracker_project_settings(&project)
                .await
                .map_err(rpc_err)?;
            serde_json::to_value(settings).map_err(|e| rpc_err(e.to_string()))
        }
        TrackerSetProjectLinearTeam {
            project,
            team_id,
            team_name,
        } => {
            let settings = handle
                .tracker_set_project_linear_team(project, team_id, team_name)
                .await
                .map_err(rpc_err)?;
            serde_json::to_value(settings).map_err(|e| rpc_err(e.to_string()))
        }
        TrackerProjectSources { project } => {
            // Same availability rules the import path enforces, surfaced so
            // the UI can hide what a project cannot use. Linear: connected key
            // plus a mapped team (an unscoped pull would adopt every project's
            // issues). GitHub: `gh` session whose repo resolves from this
            // project dir. Runs on the request task — the `gh` spawn must not
            // stall the actor loop.
            let status = tracker::status().await;
            let linear = status.linear.as_ref().is_some_and(|l| l.connected)
                && handle
                    .tracker_project_settings(&project)
                    .await
                    .ok()
                    .and_then(|settings| settings.linear_team_id)
                    .is_some();
            let github = status.github.as_ref().is_some_and(|g| g.connected) && {
                match project_path(handle, &project).await {
                    Ok(dir) => tracker::github_owner_repo(&dir).await.is_ok(),
                    Err(_) => false,
                }
            };
            serde_json::to_value(wire::ProjectSources {
                project,
                local: true,
                linear,
                github,
            })
            .map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        WorkItemSyncExternal { ids } => {
            // Three phases, and the middle one deliberately runs here rather
            // than in the actor: the actor loop is single-threaded and awaits
            // its handlers inline, so a tracker call made inside it stalls
            // every project until the network answers.
            let (links, repo_dirs, linear_teams) = handle.tracker_sync_inputs(ids).await;
            let synced = tracker::fetch_links_status(&links, &repo_dirs, &linear_teams).await;
            let items: Vec<wire::SyncedExternalItem> =
                synced.iter().map(|(_, item)| item.clone()).collect();
            handle
                .tracker_persist_synced(synced.into_iter().map(|(link, _)| link).collect())
                .await;
            serde_json::to_value(wire::SyncExternalResult { items }).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        WorkItemImportExternal { project, provider } => {
            // Unknown project is not fatal: a Linear-only import needs no repo.
            let repo_dir = project_path(handle, &project).await.ok();
            // No mapped team means no Linear import for this project: an API key
            // sees the whole account, so an unscoped pull would adopt the same
            // issues into every project the user opens.
            let linear_team = handle
                .tracker_project_settings(&project)
                .await
                .ok()
                .and_then(|settings| settings.linear_team_id);
            let fetched = tracker::fetch_importable(
                provider.as_deref(),
                repo_dir.as_deref(),
                linear_team.as_deref(),
            )
            .await
            .map_err(|e| rpc_err(format!("{e:#}")))?;
            let (items, synced) = handle
                .tracker_adopt_imported(&project, fetched)
                .await
                .map_err(rpc_err)?;
            serde_json::to_value(wire::ImportExternalResult { items, synced }).map_err(|e| {
                wire::RpcError {
                    code: wire::ErrorCode::Internal,
                    message: e.to_string(),
                }
            })
        }
        WorkItemList {
            project,
            provider,
            page,
            page_size,
            sort_by,
            sort_desc,
            search,
            status,
        } => {
            let repo_dir = if provider == "github" {
                Some(project_path(handle, &project).await?)
            } else {
                None
            };
            let query = crate::daemon::backlog::Query {
                page,
                page_size,
                sort_by,
                sort_desc,
                search,
                status,
                ..Default::default()
            };
            let result = tracker::fetch_page(&provider, &project, repo_dir.as_deref(), &query)
                .await
                .map_err(|e| rpc_err(format!("{e:#}")))?;
            serde_json::to_value(result).map_err(|e| wire::RpcError {
                code: wire::ErrorCode::Internal,
                message: e.to_string(),
            })
        }
        BacklogGetSettings {} => {
            let settings = handle.backlog_get_settings().await.map_err(rpc_err)?;
            serde_json::to_value(settings).map_err(|e| rpc_err(e.to_string()))
        }
        BacklogSetStorage { mode } => {
            let settings = handle.backlog_set_storage(mode).await.map_err(rpc_err)?;
            serde_json::to_value(settings).map_err(|e| rpc_err(e.to_string()))
        }
        BacklogList {
            project,
            page,
            page_size,
            sort_by,
            sort_desc,
            search,
            status,
            source,
            priority,
            assignee,
        } => {
            let query = crate::daemon::backlog::Query {
                page,
                page_size,
                sort_by,
                sort_desc,
                search,
                status,
                source,
                priority,
                assignee,
            };
            let page = handle.backlog_list(project, query).await.map_err(rpc_err)?;
            serde_json::to_value(page).map_err(|e| rpc_err(e.to_string()))
        }
        BacklogCreate {
            project,
            title,
            body,
            status,
            priority,
            source,
            assignee,
        } => {
            let item = handle
                .backlog_create(crate::daemon::backlog::NewItem {
                    project,
                    title,
                    body,
                    status,
                    priority,
                    source,
                    assignee,
                })
                .await
                .map_err(rpc_err)?;
            serde_json::to_value(item).map_err(|e| rpc_err(e.to_string()))
        }
        BacklogUpdate {
            item_id,
            project,
            title,
            body,
            status,
            priority,
            assignee,
        } => {
            let item = handle
                .backlog_update(crate::daemon::backlog::ItemPatch {
                    item_id,
                    project,
                    title,
                    body,
                    status,
                    priority,
                    assignee,
                })
                .await
                .map_err(rpc_err)?;
            serde_json::to_value(item).map_err(|e| rpc_err(e.to_string()))
        }
        BacklogAttachExternal {
            item_id,
            project,
            provider,
            external_id,
            url,
            remote_status,
        } => {
            handle
                .backlog_attach_external(
                    item_id,
                    project,
                    provider,
                    external_id,
                    url,
                    remote_status,
                )
                .await
                .map_err(rpc_err)?;
            Ok(json!({ "ok": true }))
        }
        BacklogDelete { item_id, project } => {
            handle
                .backlog_delete(item_id, project)
                .await
                .map_err(rpc_err)?;
            Ok(json!({ "ok": true }))
        }
        WorkItemLinkTask { item_id, task_id } => {
            handle
                .work_item_link_task(&item_id, &task_id)
                .await
                .map_err(rpc_err)?;
            Ok(json!({ "ok": true }))
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

/// Send a workflow control command and map its `Result<(), String>` reply to
/// an RPC response (`null` on success, `InvalidRequest` with the reason
/// otherwise — e.g. the pipeline is not in the state the control expects).
async fn workflow_control(
    handle: &DaemonHandle,
    build: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Command,
) -> Result<serde_json::Value, wire::RpcError> {
    let (tx, rx) = oneshot::channel();
    handle.send(build(tx)).await;
    rx.await
        .unwrap_or_else(|_| Err("daemon closed".into()))
        .map_err(|e| wire::RpcError {
            code: wire::ErrorCode::InvalidRequest,
            message: e,
        })?;
    Ok(json!(null))
}

/// Wire form of one workflow definition for the New Task picker.
fn workflow_meta(w: crate::workflow_config::LoadedWorkflow) -> wire::WorkflowMeta {
    let source = match w.source {
        crate::workflow_config::WorkflowSource::Project => wire::WorkflowSource::Project,
        crate::workflow_config::WorkflowSource::Builtin => wire::WorkflowSource::Builtin,
    };
    match w.spec {
        Ok(spec) => wire::WorkflowMeta {
            id: w.id,
            name: spec.name.clone(),
            description: spec.description.clone(),
            source,
            valid: true,
            error: None,
            warnings: w.warnings,
            stages: spec.stage_summary(),
            max_rounds: spec.review.max_rounds,
        },
        Err(error) => wire::WorkflowMeta {
            name: w.id.clone(),
            id: w.id,
            description: None,
            source,
            valid: false,
            error: Some(error),
            warnings: w.warnings,
            stages: vec![],
            max_rounds: 0,
        },
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

/// Map an anyhow error to a wire `Internal` RPC error.
fn rpc_err(e: impl std::fmt::Display) -> wire::RpcError {
    wire::RpcError {
        code: wire::ErrorCode::Internal,
        message: e.to_string(),
    }
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

/// Account mutations answer with the whole list, so the client re-renders from
/// one payload instead of patching. A failure is the user's problem to fix
/// (no login found, name taken), so it maps to InvalidRequest, not Internal.
fn accounts_result(
    result: Result<Vec<wire::AccountInfo>, String>,
) -> Result<serde_json::Value, wire::RpcError> {
    match result {
        Ok(accounts) => Ok(json!({ "accounts": accounts })),
        Err(message) => Err(wire::RpcError {
            code: wire::ErrorCode::InvalidRequest,
            message,
        }),
    }
}

/// Requests answered off the connection's read loop instead of ahead of
/// everything behind them.
///
/// The question is not whether a request writes — it is whether it has to be
/// ordered against the others on the connection. So this is its own list rather
/// than the negation of [`method_is_mutation`], which exists to decide what the
/// update gate holds back:
///
/// - Reads are independent by definition.
/// - So are one-shot jobs whose result depends on nothing else in flight:
///   generating a title, installing an agent or a language server. These are
///   the slowest things the daemon does — a title spawns an agent process with
///   a two-minute ceiling, an install shells out to a package manager — and
///   they are what made starting a task feel like it stalled everything else.
/// - Ordered work stays serial. LSP is a streaming protocol, so dispatching
///   `LspSend` concurrently would reorder a language server's inbox, and git
///   writes mean what they mean only in sequence: commit, then push.
fn method_runs_concurrently(method: &wire::Method) -> bool {
    use wire::Method::*;
    matches!(
        method,
        TextGenerate { .. }
            | AgentsInstall { .. }
            | AgentsProbe { .. }
            | SessionSetConfigOption { .. }
            | LanguageServersInstall { .. }
            | DiffGet { .. }
            | FileContents { .. }
            | FileList { .. }
            | FileSearch { .. }
            | GitBranches { .. }
            | GitPushInfo { .. }
            | GitLastCommitMessage { .. }
            | ServiceLogs { .. }
            | PortForwardLogs { .. }
            | RuntimeList { .. }
            | TaskListWorktrees { .. }
            | SessionsList { .. }
            | OrchestratorListAgents { .. }
            | AgentsDetect {}
            | AccountsList {}
            | OrchestrateList {}
            | OrchestrateGetConfig {}
            | WorkflowList { .. }
            | LanguageServersDetect {}
    )
}

fn method_is_mutation(method: &wire::Method) -> bool {
    use wire::Method::*;
    !matches!(
        method,
        SystemHandshake { .. }
            | StateSubscribe { .. }
            | ServiceLogs { .. }
            | PortForwardLogs { .. }
            | RuntimeList { .. }
            | TaskListWorktrees { .. }
            | SessionsList { .. }
            | OrchestratorListAgents { .. }
            | AgentsDetect {}
            | AccountsList {}
            | DiffGet { .. }
            | FileContents { .. }
            | FileList { .. }
            | FileSearch { .. }
            | GitBranches { .. }
            | GitPushInfo { .. }
            | GitLastCommitMessage { .. }
            | OrchestrateList {}
            | OrchestrateGetConfig {}
            | WorkflowList { .. }
            | BootstrapFinalize { .. }
            | BootstrapReadConfig { .. }
            | WorkItemList { .. }
            | LspStart { .. }
            | LspSend { .. }
            | LspStop { .. }
            | LanguageServersDetect {}
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::{Daemon, Store};
    use crate::registry::ProjectEntry;
    use std::time::Duration;
    use tokio::time::timeout;

    /// A request the daemon cannot parse must still be answered. Dropping it
    /// leaves the caller waiting forever, which is indistinguishable from a
    /// hung daemon — it showed up as a spinner that never stopped when a client
    /// sent params in the wrong case.
    #[tokio::test]
    async fn unparseable_request_is_answered_instead_of_dropped() {
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let handle = Daemon::spawn(Vec::new(), store);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, handle.clone(), String::new()));
        let (mut ws, _) = tokio_tungstenite::connect_async(&format!("ws://{addr}"))
            .await
            .unwrap();

        for (id, frame) in [
            // Params that don't match the variant's fields.
            (
                7,
                json!({ "id": 7, "method": "accounts.import", "params": { "agentId": "claude", "label": "personal" } }),
            ),
            // A method this daemon has never heard of.
            (
                8,
                json!({ "id": 8, "method": "accounts.teleport", "params": {} }),
            ),
        ] {
            ws.send(Message::Text(frame.to_string())).await.unwrap();

            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("a reply, not silence")
                .expect("some")
                .expect("ok");
            let Message::Text(t) = msg else {
                panic!("expected a text frame")
            };
            let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
            assert_eq!(v["id"].as_u64(), Some(id));
            assert_eq!(v["error"]["code"], "invalid_request");
        }
    }

    /// Generating a title spawns an agent process and can run for minutes. It
    /// used to be dispatched on the read loop, so the daemon read nothing else
    /// from that client meanwhile — which is what made starting a task appear
    /// to stall the conversation it was starting.
    #[test]
    fn the_slowest_requests_do_not_block_the_connection() {
        use wire::Method::*;
        for method in [
            TextGenerate {
                task_id: "t".into(),
                agent_id: "claude".into(),
                kind: wire::TextGenKind::TaskTitle,
                model: None,
            },
            AgentsInstall {
                id: "claude".into(),
            },
            LanguageServersInstall { id: "rust".into() },
        ] {
            assert!(
                method_runs_concurrently(&method),
                "{method:?} shells out for seconds to minutes and must not hold the read loop"
            );
        }
    }

    /// Ordered work must stay on the serial path. LSP is a streaming protocol
    /// and git writes only mean what they mean in sequence.
    #[test]
    fn ordered_requests_stay_serial() {
        use wire::Method::*;
        for method in [
            LspSend {
                server_id: "s".into(),
                payload: serde_json::Value::Null,
            },
            GitCommit {
                task_id: "t".into(),
                message: "m".into(),
                files: None,
                amend: false,
            },
        ] {
            assert!(
                !method_runs_concurrently(&method),
                "{method:?} depends on arriving in order"
            );
        }
    }

    /// A read must not hold up whatever is queued behind it. One connection
    /// used to serve one request at a time, so a slow read delayed everything
    /// after it — a tool approval was not even read off the socket until the
    /// read ahead of it finished. The cheap request sent second must come back
    /// first.
    // Multi-threaded on purpose: the daemon runs on a multi-thread runtime, and
    // on the single-threaded test default a synchronous filesystem walk inside
    // a spawned task blocks the very socket read this is measuring.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_slow_read_does_not_delay_the_request_behind_it() {
        // A project big enough that listing it takes real time, and sized here
        // rather than inherited from the checkout so the margin is the same
        // everywhere this runs.
        let dir = tempfile::tempdir().unwrap();
        for i in 0..4000 {
            std::fs::write(dir.path().join(format!("file{i}.txt")), "x").unwrap();
        }
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: dir.path().to_string_lossy().into_owned(),
            added_at: "0".into(),
        }];
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let handle = Daemon::spawn(projects, store);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(run(listener, handle.clone(), String::new()));
        // Without this the second request sits in the client's send buffer
        // waiting on an ACK for the first, and the test measures Nagle rather
        // than the daemon.
        let tcp = TcpStream::connect(addr).await.unwrap();
        tcp.set_nodelay(true).unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}"), tcp)
            .await
            .unwrap();

        // Listing walks and stats every file; the accounts list is answered
        // from memory.
        ws.send(Message::Text(
            json!({
                "id": 1,
                "method": "file.list",
                "params": { "project": "demo", "include_ignored": true }
            })
            .to_string(),
        ))
        .await
        .unwrap();
        ws.send(Message::Text(
            json!({ "id": 2, "method": "accounts.list", "params": {} }).to_string(),
        ))
        .await
        .unwrap();

        // Both are answered; the order is the point.
        let mut ids = Vec::new();
        for _ in 0..2 {
            let msg = timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("a reply, not silence")
                .expect("some")
                .expect("ok");
            let Message::Text(text) = msg else {
                panic!("expected a text frame")
            };
            let reply: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
            ids.push(reply["id"].as_u64());
        }
        assert_eq!(
            ids,
            vec![Some(2), Some(1)],
            "the cheap request must not wait behind the project listing"
        );
    }

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
    async fn orchestrator_list_agents_scopes_parent_and_project() {
        let projects = vec![
            ProjectEntry {
                name: "demo".into(),
                path: ".".into(),
                added_at: "0".into(),
            },
            ProjectEntry {
                name: "other".into(),
                path: ".".into(),
                added_at: "0".into(),
            },
        ];
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        let handle = Daemon::spawn(projects, store);
        let parent = handle
            .create_task(
                "demo",
                "orchestrator",
                "codex",
                vec!["orchestrator-chat".into()],
                false,
                false,
                None,
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;
        let demo_child = handle
            .create_task(
                "demo",
                "demo child",
                "codex",
                Vec::new(),
                false,
                false,
                Some(parent.clone()),
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;
        let _other_project_child = handle
            .create_task(
                "other",
                "other child",
                "codex",
                Vec::new(),
                false,
                false,
                Some(parent.clone()),
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;
        let unrelated = handle
            .create_task(
                "demo",
                "unrelated child",
                "codex",
                Vec::new(),
                false,
                false,
                Some("t_other_parent".into()),
                Vec::new(),
                None,
                Default::default(),
                None,
            )
            .await;

        let lifecycle = Arc::new(ServerLifecycle::new(wire::DaemonOwner::External));
        let result = dispatch(
            &handle,
            wire::Method::OrchestratorListAgents {
                parent_task_id: parent,
                project: Some("demo".into()),
            },
            &lifecycle,
        )
        .await
        .unwrap();
        let agents = result["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["id"], demo_child);
        assert_ne!(agents[0]["id"], unrelated);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn workflow_list_and_eject_over_websocket() {
        type Ws = tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >;
        async fn rpc(
            ws: &mut Ws,
            id: u64,
            method: &str,
            params: serde_json::Value,
        ) -> serde_json::Value {
            ws.send(Message::Text(
                json!({ "id": id, "method": method, "params": params }).to_string(),
            ))
            .await
            .unwrap();
            loop {
                let msg = timeout(Duration::from_secs(2), ws.next())
                    .await
                    .expect("frame")
                    .expect("some")
                    .expect("ok");
                if let Message::Text(t) = msg {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                        return v;
                    }
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let projects = vec![ProjectEntry {
            name: "demo".into(),
            path: dir.path().to_string_lossy().into_owned(),
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

        // A fresh project sees exactly the built-in templates.
        let v = rpc(&mut ws, 1, "workflow.list", json!({ "project": "demo" })).await;
        let workflows = v["result"]["workflows"].as_array().unwrap();
        assert_eq!(workflows.len(), 2);
        assert!(workflows
            .iter()
            .all(|w| w["source"] == "builtin" && w["valid"] == true));
        assert!(workflows.iter().any(|w| w["id"] == "review-loop"));

        // Ejecting copies the built-in into .warpforge/workflows/.
        let v = rpc(
            &mut ws,
            2,
            "workflow.eject",
            json!({ "project": "demo", "id": "review-loop" }),
        )
        .await;
        let path = v["result"]["path"].as_str().unwrap();
        assert!(std::path::Path::new(path).exists());

        // The ejected copy now overrides the built-in…
        let v = rpc(&mut ws, 3, "workflow.list", json!({ "project": "demo" })).await;
        let workflows = v["result"]["workflows"].as_array().unwrap();
        let review = workflows.iter().find(|w| w["id"] == "review-loop").unwrap();
        assert_eq!(review["source"], "project");

        // …and a second eject refuses to overwrite it.
        let v = rpc(
            &mut ws,
            4,
            "workflow.eject",
            json!({ "project": "demo", "id": "review-loop" }),
        )
        .await;
        assert!(v["error"]["message"].as_str().unwrap().contains("exists"));

        // Unknown projects are rejected.
        let v = rpc(&mut ws, 5, "workflow.list", json!({ "project": "nope" })).await;
        assert!(v.get("error").is_some());
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
    async fn spawn_terminal_emits_spawned_and_data_events() {
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

        ws.send(Message::Text(
            json!({
                "id": 2, "method": "terminal.spawn",
                "params": { "project": "demo", "command": "printf WARPMARK; sleep 2" }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let mut saw_spawned = false;
        let mut saw_data = false;
        for _ in 0..40 {
            let msg = match timeout(Duration::from_secs(3), ws.next()).await {
                Ok(Some(Ok(m))) => m,
                _ => break,
            };
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                let event = v.get("event").and_then(|e| e.as_str());
                if event == Some("terminal.spawned") {
                    assert_eq!(v["data"]["project"].as_str(), Some("demo"));
                    assert!(v["data"]["id"].as_str().is_some());
                    saw_spawned = true;
                }
                if event == Some("terminal.data") {
                    assert!(v["data"]["data_b64"].as_str().is_some());
                    assert!(v["data"]["terminal_id"].as_str().is_some());
                    saw_data = true;
                }
                if saw_spawned && saw_data {
                    break;
                }
            }
        }
        assert!(saw_spawned, "expected a terminal.spawned event");
        assert!(saw_data, "expected a terminal.data event");
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
                // Keep session process alive so asynchronous ACP failure cannot
                // race the queued-task blocker assertion below.
                "sleep 60",
                Vec::new(),
                false,
                false,
                None,
                Vec::new(),
                None,
                std::collections::HashMap::new(),
                None,
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

    #[tokio::test]
    async fn lifecycle_methods_dispatch_over_websocket() {
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

        let url = format!("ws://{addr}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

        // Subscribe first to receive events
        ws.send(Message::Text(
            json!({ "id": 1, "method": "state.subscribe", "params": { "topics": [] } }).to_string(),
        ))
        .await
        .unwrap();

        // Wait for snapshot
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
                    saw_snapshot = true;
                    break;
                }
            }
        }
        assert!(saw_snapshot, "expected a state.snapshot event");

        // Create a task
        ws.send(Message::Text(
            json!({
                "id": 2,
                "method": "task.create",
                "params": { "project": "demo", "prompt": "test", "agent": "claude" }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        // Wait for task.created event and response
        let mut task_id = None;
        let mut saw_response = false;
        for _ in 0..5 {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("frame")
                .expect("some")
                .expect("ok");
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v.get("event").and_then(|e| e.as_str()) == Some("task.created") {
                    task_id = v["data"]["id"].as_str().map(String::from);
                }
                if v.get("id").and_then(|i| i.as_u64()) == Some(2) {
                    saw_response = true;
                }
                if task_id.is_some() && saw_response {
                    break;
                }
            }
        }
        let task_id = task_id.expect("task created");

        // Test task.settle
        ws.send(Message::Text(
            json!({
                "id": 3,
                "method": "task.settle",
                "params": { "task_id": task_id }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        // Wait for response (may be preceded by task.updated events)
        loop {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v.get("id").and_then(|i| i.as_u64()) == Some(3) {
                    assert!(v.get("result").is_some());
                    assert!(v.get("error").is_none());
                    break;
                }
            }
        }

        // Test task.unsettle
        ws.send(Message::Text(
            json!({
                "id": 4,
                "method": "task.unsettle",
                "params": { "task_id": task_id }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        loop {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v.get("id").and_then(|i| i.as_u64()) == Some(4) {
                    assert!(v.get("result").is_some());
                    break;
                }
            }
        }

        // Test task.snooze with future timestamp
        let future = crate::daemon::task::now_secs() + 3600;
        ws.send(Message::Text(
            json!({
                "id": 5,
                "method": "task.snooze",
                "params": { "task_id": task_id, "until": future }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        loop {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v.get("id").and_then(|i| i.as_u64()) == Some(5) {
                    assert!(v.get("result").is_some());
                    break;
                }
            }
        }

        // Test task.unsnooze
        ws.send(Message::Text(
            json!({
                "id": 6,
                "method": "task.unsnooze",
                "params": { "task_id": task_id }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        loop {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v.get("id").and_then(|i| i.as_u64()) == Some(6) {
                    assert!(v.get("result").is_some());
                    break;
                }
            }
        }

        // Test error case: settle unknown task
        ws.send(Message::Text(
            json!({
                "id": 7,
                "method": "task.settle",
                "params": { "task_id": "nonexistent" }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        loop {
            let msg = timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v.get("id").and_then(|i| i.as_u64()) == Some(7) {
                    assert!(v.get("error").is_some());
                    assert!(v["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("unknown task"));
                    break;
                }
            }
        }
    }
}
