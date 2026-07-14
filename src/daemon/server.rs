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

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::sync::oneshot;
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

fn write_endpoint(addr: SocketAddr, token: &str) -> Result<()> {
    let endpoint = wire::DaemonEndpoint {
        pid: std::process::id(),
        url: format!("ws://{addr}"),
        token: token.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
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
pub async fn serve(handle: DaemonHandle, dev: bool) -> Result<()> {
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
    write_endpoint(addr, &token)?;
    eprintln!("warpforge daemon listening on ws://{addr}");

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate())?;
        tokio::select! {
            r = run(listener, handle.clone(), token) => r,
            _ = sigterm.recv() => {
                eprintln!("warpforge daemon: SIGTERM — stopping services");
                handle.shutdown().await;
                std::fs::remove_file(daemon_json_path()).ok();
                Ok(())
            }
        }
    }
    #[cfg(not(unix))]
    run(listener, handle, token).await
}

/// Accept loop, split out so tests can drive it against a pre-bound listener.
pub async fn run(listener: TcpListener, handle: DaemonHandle, token: String) -> Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let handle = handle.clone();
        let token = token.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, handle, token).await {
                eprintln!("warpforge: connection ended: {e}");
            }
        });
    }
}

async fn handle_conn(stream: TcpStream, handle: DaemonHandle, token: String) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut tx, mut rx) = ws.split();
    let mut events = handle.subscribe();
    let mut authed = token.is_empty();
    let mut subscribed = false;

    macro_rules! send {
        ($msg:expr) => {{
            let text = serde_json::to_string(&$msg)?;
            if tx.send(Message::Text(text.into())).await.is_err() {
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

                match dispatch(&handle, req.method).await {
                    Ok(result) => send!(wire::ServerMessage::Response { id, result }),
                    Err(error) => send!(wire::ServerMessage::Error { id, error }),
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
) -> Result<serde_json::Value, wire::RpcError> {
    use wire::Method::*;
    match method {
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
        FileList { task_id, project } => {
            let files = handle.list_files(&task_id, project).await;
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
        TaskCancel { task_id } => {
            handle.send(Command::CancelTask { id: task_id }).await;
            Ok(json!(null))
        }
        TaskDelete { task_id } => {
            handle.send(Command::DeleteTask { id: task_id }).await;
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
            let graph_id = rx.await.unwrap_or_default();
            Ok(json!({ "graphId": graph_id }))
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
        // Not yet in this build: project.* (use `wf add` + restart) and
        // task.archive. Follow-ups.
        _ => Err(wire::RpcError {
            code: wire::ErrorCode::NotFound,
            message: "method not implemented in this build".to_string(),
        }),
    }
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
            json!({ "id": 1, "method": "state.subscribe", "params": { "topics": [] } })
                .to_string()
                .into(),
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
            .to_string()
            .into(),
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
            json!({ "id": 1, "method": "state.subscribe", "params": {} })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();

        // Spawn a PTY that prints a marker.
        ws.send(Message::Text(
            json!({
                "id": 2, "method": "terminal.spawn",
                "params": { "project": "demo", "command": "printf WARPMARK; sleep 2" }
            })
            .to_string()
            .into(),
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
}
