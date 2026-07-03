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
    let bind = if dev { "127.0.0.1:61814" } else { "127.0.0.1:0" };
    let listener = TcpListener::bind(bind).await?;
    let addr = listener.local_addr()?;
    let token = if dev { String::new() } else { Uuid::new_v4().to_string() };
    write_endpoint(addr, &token)?;
    eprintln!("warpforge daemon listening on ws://{addr}");
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
        ServiceStart { project, service } => {
            handle.send(Command::StartService { project, service }).await;
            Ok(json!(null))
        }
        ServiceStop { project, service } => {
            handle.send(Command::StopService { project, service }).await;
            Ok(json!(null))
        }
        ServiceRestart { project, service } => {
            handle.send(Command::RestartService { project, service }).await;
            Ok(json!(null))
        }
        ServiceStartAll { project } => {
            // Opening a project starts its declared services + port-forwards.
            handle.send(Command::OpenProject { name: project }).await;
            Ok(json!(null))
        }
        ServiceStopAll { project } => {
            handle.send(Command::StopProject { project }).await;
            Ok(json!(null))
        }
        PortForwardStartAll { project } => {
            handle.send(Command::OpenProject { name: project }).await;
            Ok(json!(null))
        }
        TaskCreate { project, prompt, agent, tags, .. } => {
            let id = handle.create_task(&project, &prompt, &agent, tags).await;
            Ok(json!({ "taskId": id }))
        }
        TaskCancel { task_id } => {
            handle.send(Command::CancelTask { id: task_id }).await;
            Ok(json!(null))
        }
        SessionPrompt { task_id, text } => {
            handle.session_prompt(&task_id, &text).await;
            Ok(json!(null))
        }
        SessionPermission { task_id, request_id, outcome } => {
            let outcome = match outcome {
                wire::PermissionOutcome::Allow => "allow",
                wire::PermissionOutcome::AllowAlways => "allow_always",
                wire::PermissionOutcome::Deny => "deny",
            };
            handle.session_permission(&task_id, &request_id, outcome).await;
            Ok(json!(null))
        }
        // Not yet in this build: diff.*, terminal.*, project.*,
        // portforward.stop, task.archive. They land with Stages 3 & 5.
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
}
