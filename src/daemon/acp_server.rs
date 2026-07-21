//! ACP (Agent Client Protocol) server: warpforge exposes ACP as a server so
//! external orchestrators can drive tasks remotely. Newline-delimited JSON-RPC
//! 2.0 over TCP, same wire format as the ACP client in `acp.rs`.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::daemon::{DaemonHandle, Event};

/// Server configuration.
pub struct AcpServerConfig {
    pub listen_addr: String,
}

impl Default for AcpServerConfig {
    fn default() -> Self {
        Self {
            listen_addr: "127.0.0.1:0".into(), // port 0 = auto-assign
        }
    }
}

/// Start the ACP server. Returns the bound address (useful when port 0).
pub async fn start_acp_server(
    config: AcpServerConfig,
    daemon: DaemonHandle,
) -> anyhow::Result<std::net::SocketAddr> {
    let listener = TcpListener::bind(&config.listen_addr).await?;
    let addr = listener.local_addr()?;

    let daemon = Arc::new(daemon);
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    let daemon = Arc::clone(&daemon);
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(stream, peer, daemon).await {
                            eprintln!("[acp-server] connection error from {peer}: {e}");
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[acp-server] accept error: {e}");
                }
            }
        }
    });

    Ok(addr)
}

/// Per-connection session state.
struct SessionState {
    task_id: String,
    agent_text_rx: broadcast::Receiver<String>,
    event_rx: broadcast::Receiver<Event>,
}

/// Handle one TCP connection (one ACP client).
async fn handle_connection(
    stream: TcpStream,
    _peer: std::net::SocketAddr,
    daemon: Arc<DaemonHandle>,
) -> anyhow::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // Per-session state (set after session/new).
    let _session: Option<SessionState> = None;
    let _pending_responses: HashMap<Value, oneshot::Sender<Value>> = HashMap::new();

    // Writer task: forward session updates as JSON-RPC notifications.
    let write_tx = {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if writer.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = writer.flush().await;
            }
        });
        tx
    };

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let err = make_error(-32700, &format!("parse error: {e}"));
                let resp = json!({"jsonrpc": "2.0", "error": err, "id": null});
                let _ = write_tx.send(format!("{resp}"));
                continue;
            }
        };

        // Route by method.
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or(json!({}));

        match method {
            "initialize" => {
                let result = json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": {
                        "sessions": {"create": true, "prompt": true}
                    },
                    "serverInfo": {
                        "name": "warpforge",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                });
                let resp = json!({"jsonrpc": "2.0", "result": result, "id": id});
                let _ = write_tx.send(format!("{resp}"));
            }
            "session/new" => {
                let project = params
                    .get("project")
                    .and_then(|p| p.as_str())
                    .unwrap_or("demo");
                let prompt = params.get("prompt").and_then(|p| p.as_str()).unwrap_or("");
                let agent = params
                    .get("agent")
                    .and_then(|a| a.as_str())
                    .unwrap_or("claude");

                let task_id = daemon
                    .create_task(
                        project,
                        prompt,
                        agent,
                        vec!["acp-server".into()],
                        true,
                        false,
                        None,
                        vec![],
                        None,
                    )
                    .await;

                // Subscribe to updates for this task.
                let mut task_event_rx = daemon.subscribe();
                let task_id_clone = task_id.clone();

                // Spawn a forwarder that watches for events on this task.
                let fwd_tx = write_tx.clone();
                let fwd_task = task_id.clone();
                tokio::spawn(async move {
                    loop {
                        match task_event_rx.recv().await {
                            Ok(Event::SessionUpdate {
                                task_id: tid,
                                update,
                            }) if tid == fwd_task => {
                                let notification = json!({
                                    "jsonrpc": "2.0",
                                    "method": "session/update",
                                    "params": {
                                        "sessionId": fwd_task,
                                        "update": serde_json::to_value(&update).unwrap_or(json!(null))
                                    }
                                });
                                let _ = fwd_tx.send(format!("{notification}"));
                            }
                            Ok(Event::TaskUpdated(t)) if t.id == fwd_task => {
                                if matches!(
                                    t.status,
                                    crate::daemon::TaskStatus::Done
                                        | crate::daemon::TaskStatus::Idle
                                ) {
                                    let notification = json!({
                                        "jsonrpc": "2.0",
                                        "method": "session/ended",
                                        "params": {
                                            "sessionId": fwd_task,
                                            "status": t.status.to_string()
                                        }
                                    });
                                    let _ = fwd_tx.send(format!("{notification}"));
                                }
                            }
                            Err(_) => break,
                            _ => {}
                        }
                    }
                });

                let result = json!({
                    "sessionId": task_id_clone,
                    "status": "active"
                });
                let resp = json!({"jsonrpc": "2.0", "result": result, "id": id});
                let _ = write_tx.send(format!("{resp}"));
            }
            "session/prompt" => {
                let task_id_val = params.get("sessionId").and_then(|s| s.as_str());
                let text = params.get("text").and_then(|t| t.as_str()).unwrap_or("");

                match task_id_val {
                    Some(tid) => {
                        let _ = daemon.session_prompt(tid, text, vec![]).await;
                        let result = json!({"status": "sent"});
                        let resp = json!({"jsonrpc": "2.0", "result": result, "id": id});
                        let _ = write_tx.send(format!("{resp}"));
                    }
                    None => {
                        let err = make_error(-32602, "missing sessionId");
                        let resp = json!({"jsonrpc": "2.0", "error": err, "id": id});
                        let _ = write_tx.send(format!("{resp}"));
                    }
                }
            }
            "session/permission" => {
                let task_id_val = params.get("sessionId").and_then(|s| s.as_str());
                let request_id = params
                    .get("requestId")
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                let outcome = params
                    .get("outcome")
                    .and_then(|o| o.as_str())
                    .unwrap_or("allow");

                if let Some(tid) = task_id_val {
                    daemon.session_permission(tid, request_id, outcome).await;
                    let result = json!({"status": "answered"});
                    let resp = json!({"jsonrpc": "2.0", "result": result, "id": id});
                    let _ = write_tx.send(format!("{resp}"));
                }
            }
            "session/list" => {
                let tasks = daemon.tasks().await;
                let sessions: Vec<Value> = tasks
                    .iter()
                    .filter(|t| t.session_id.is_some())
                    .map(|t| {
                        json!({
                            "sessionId": t.session_id.as_deref().unwrap_or(""),
                            "taskId": t.id,
                            "project": t.project,
                            "status": t.status.to_string(),
                            "agent": t.agent,
                        })
                    })
                    .collect();
                let result = json!({"sessions": sessions});
                let resp = json!({"jsonrpc": "2.0", "result": result, "id": id});
                let _ = write_tx.send(format!("{resp}"));
            }
            "shutdown" => {
                let resp = json!({"jsonrpc": "2.0", "result": null, "id": id});
                let _ = write_tx.send(format!("{resp}"));
                break;
            }
            _ => {
                let err = make_error(-32601, &format!("unknown method: {method}"));
                let resp = json!({"jsonrpc": "2.0", "error": err, "id": id});
                let _ = write_tx.send(format!("{resp}"));
            }
        }
    }

    Ok(())
}

fn make_error(code: i32, message: &str) -> Value {
    json!({"code": code, "message": message})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::Store;

    fn test_daemon() -> DaemonHandle {
        let projects = vec![crate::registry::ProjectEntry {
            name: "demo".into(),
            path: ".".into(),
            added_at: "0".into(),
        }];
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        crate::daemon::Daemon::spawn(projects, store)
    }

    #[tokio::test]
    async fn server_starts_and_initializes() {
        let daemon = test_daemon();
        let config = AcpServerConfig {
            listen_addr: "127.0.0.1:0".into(),
        };
        let addr = start_acp_server(config, daemon).await.unwrap();

        // Connect and send initialize
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        use tokio::io::AsyncWriteExt;
        let init = json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "id": 1,
            "params": {}
        });
        stream
            .write_all(format!("{init}\n").as_bytes())
            .await
            .unwrap();

        // Read response
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 4096];
        let n = stream.read(&mut buf).await.unwrap();
        let resp: Value = serde_json::from_slice(&buf[..n]).unwrap();

        assert_eq!(resp["id"], 1);
        assert!(resp["result"]["capabilities"]["sessions"]["create"]
            .as_bool()
            .unwrap());
    }

    #[tokio::test]
    async fn session_new_creates_task() {
        let daemon = test_daemon();
        let config = AcpServerConfig {
            listen_addr: "127.0.0.1:0".into(),
        };
        let addr = start_acp_server(config, daemon).await.unwrap();

        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut lines = BufReader::new(reader).lines();
        use tokio::io::AsyncWriteExt;

        // initialize
        let init = json!({"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": {}});
        writer
            .write_all(format!("{init}\n").as_bytes())
            .await
            .unwrap();
        let _init_response = lines.next_line().await.unwrap().unwrap();

        // session/new
        let new = json!({
            "jsonrpc": "2.0",
            "method": "session/new",
            "id": 2,
            "params": {
                "project": "demo",
                "prompt": "hello from acp server",
                "agent": "claude"
            }
        });
        writer
            .write_all(format!("{new}\n").as_bytes())
            .await
            .unwrap();
        let response = lines.next_line().await.unwrap().unwrap();
        let resp: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(resp["id"], 2);
        assert!(resp["result"]["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("t_"));
    }
}
