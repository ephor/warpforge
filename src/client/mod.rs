//! Daemon client for the TUI. Connects to `wf daemon` over WebSocket, maintains
//! a local projection of daemon state (services, port-forwards, terminals) that
//! the existing TUI render code reads through manager-shaped views, and sends
//! commands back. The TUI no longer owns any process/PTY/port state — the
//! daemon does, and the TUI is just another client alongside the desktop app.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::Message;
use warpforge_protocol as wire;

use crate::agent::AgentStatus;
use crate::portforward::PfStatus;
use crate::registry::ProjectEntry;
use crate::service::ServiceStatus;

// ── Views: manager-shaped so the existing render code reads them unchanged ──

pub struct ServiceView {
    pub project: String,
    pub name: String,
    pub status: ServiceStatus,
    pub original_port: u16,
    pub allocated_port: u16,
    pub logs: Vec<String>,
}

pub struct PfView {
    pub project: String,
    pub name: String,
    pub status: PfStatus,
    pub local_port: u16,
    pub logs: Vec<String>,
}

/// A remote PTY terminal (the TUI's live agent pane), rendered from serialized
/// screens rather than a local vt100 parser.
pub struct TermView {
    pub id: String,
    pub project: String,
    pub command: String,
    pub description: String,
    pub status: AgentStatus,
    pub started_at: u64,
    pub screen: Option<wire::TerminalScreen>,
}

#[derive(Default)]
pub struct ServiceProjection {
    pub items: Vec<ServiceView>,
}
impl ServiceProjection {
    pub fn list_for_project(&self, project: &str) -> Vec<&ServiceView> {
        self.items.iter().filter(|s| s.project == project).collect()
    }
}

#[derive(Default)]
pub struct PfProjection {
    pub items: Vec<PfView>,
}
impl PfProjection {
    pub fn list_for_project(&self, project: &str) -> Vec<&PfView> {
        let mut v: Vec<&PfView> = self.items.iter().filter(|p| p.project == project).collect();
        v.sort_by_key(|p| p.local_port);
        v
    }
}

#[derive(Default)]
pub struct AgentProjection {
    pub items: Vec<TermView>,
}
impl AgentProjection {
    pub fn list_for_project(&self, project: &str) -> Vec<&TermView> {
        self.items.iter().filter(|t| t.project == project).collect()
    }
}

#[derive(Default)]
pub struct ClientState {
    pub projects: Vec<ProjectEntry>,
    pub services: ServiceProjection,
    pub portforwards: PfProjection,
    pub agents: AgentProjection,
    pub tasks: Vec<wire::TaskInfo>,
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct Client {
    state: Arc<Mutex<ClientState>>,
    out_tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: std::sync::atomic::AtomicU64,
    /// Notified whenever state changes, so the TUI loop can redraw.
    pub redraw: Arc<Notify>,
}

impl Client {
    /// Connect to the running daemon, auto-spawning it if necessary.
    pub async fn connect() -> Result<Arc<Self>> {
        let endpoint = ensure_daemon().await?;
        let (ws, _) = tokio_tungstenite::connect_async(&endpoint.url)
            .await
            .with_context(|| format!("connecting to daemon at {}", endpoint.url))?;
        let (mut sink, mut stream) = ws.split();

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let state = Arc::new(Mutex::new(ClientState::default()));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let redraw = Arc::new(Notify::new());

        // Auth then subscribe.
        if !endpoint.token.is_empty() {
            let _ = sink
                .send(Message::Text(
                    json!({ "auth": endpoint.token }).to_string().into(),
                ))
                .await;
        }
        let _ = sink
            .send(Message::Text(
                json!({ "id": 0, "method": "state.subscribe", "params": {} })
                    .to_string()
                    .into(),
            ))
            .await;

        // Writer task.
        tokio::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                if sink.send(Message::Text(line.into())).await.is_err() {
                    break;
                }
            }
        });

        // Reader task.
        {
            let state = Arc::clone(&state);
            let pending = Arc::clone(&pending);
            let redraw = Arc::clone(&redraw);
            tokio::spawn(async move {
                while let Some(Ok(msg)) = stream.next().await {
                    let Message::Text(text) = msg else { continue };
                    let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    if let Some(id) = v.get("id").and_then(Value::as_u64) {
                        if v.get("event").is_none() {
                            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                                let _ = tx.send(v.clone());
                            }
                            continue;
                        }
                    }
                    if let Ok(ev) = serde_json::from_value::<wire::Event>(
                        json!({ "event": v.get("event"), "data": v.get("data") }),
                    ) {
                        apply_event(&state, ev);
                        redraw.notify_waiters();
                    }
                }
            });
        }

        Ok(Arc::new(Self {
            state,
            out_tx,
            pending,
            next_id: std::sync::atomic::AtomicU64::new(1),
            redraw,
        }))
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, ClientState> {
        self.state.lock().unwrap()
    }

    fn notify(&self, method: &str, params: Value) {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = self
            .out_tx
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
    }

    async fn request(&self, method: &str, params: Value) -> Option<Value> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let _ = self
            .out_tx
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
        rx.await.ok()
    }

    // ── Commands ──
    pub fn open_project(&self, project: &str) {
        self.notify("service.startAll", json!({ "project": project }));
    }
    pub fn start_service(&self, project: &str, service: &str) {
        self.notify(
            "service.start",
            json!({ "project": project, "service": service }),
        );
    }
    pub fn stop_service(&self, project: &str, service: &str) {
        self.notify(
            "service.stop",
            json!({ "project": project, "service": service }),
        );
    }
    pub fn restart_service(&self, project: &str, service: &str) {
        self.notify(
            "service.restart",
            json!({ "project": project, "service": service }),
        );
    }
    pub fn stop_all_services(&self, project: &str) {
        self.notify("service.stopAll", json!({ "project": project }));
    }
    pub fn restart_all(&self, project: &str) {
        self.notify("service.stopAll", json!({ "project": project }));
        self.notify("service.startAll", json!({ "project": project }));
    }

    pub async fn spawn_terminal(&self, project: &str, command: &str) -> Option<String> {
        let resp = self
            .request(
                "terminal.spawn",
                json!({ "project": project, "command": command }),
            )
            .await?;
        resp.get("result")?
            .get("terminalId")?
            .as_str()
            .map(String::from)
    }
    pub fn terminal_input(&self, terminal_id: &str, data: &[u8]) {
        let data_b64 = base64::engine::general_purpose::STANDARD.encode(data);
        self.notify(
            "terminal.input",
            json!({ "terminalId": terminal_id, "dataB64": data_b64 }),
        );
    }
    pub fn terminal_resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        self.notify(
            "terminal.resize",
            json!({ "terminalId": terminal_id, "cols": cols, "rows": rows }),
        );
    }
    pub fn terminal_kill(&self, terminal_id: &str) {
        self.notify("terminal.kill", json!({ "terminalId": terminal_id }));
    }
}

// ── Event application ──

fn apply_event(state: &Arc<Mutex<ClientState>>, ev: wire::Event) {
    let mut s = state.lock().unwrap();
    match ev {
        wire::Event::Snapshot(snap) => *s = from_snapshot(snap),
        wire::Event::ServiceStatus {
            project,
            service,
            status,
            allocated_port,
        } => {
            match s
                .services
                .items
                .iter_mut()
                .find(|x| x.project == project && x.name == service)
            {
                Some(v) => {
                    v.status = service_status(status);
                    v.allocated_port = allocated_port;
                }
                None => s.services.items.push(ServiceView {
                    project,
                    name: service,
                    status: service_status(status),
                    original_port: 0,
                    allocated_port,
                    logs: Vec::new(),
                }),
            }
        }
        wire::Event::ServiceLog {
            project,
            service,
            line,
            ..
        } => {
            if let Some(v) = s
                .services
                .items
                .iter_mut()
                .find(|x| x.project == project && x.name == service)
            {
                push_log(&mut v.logs, line);
            }
        }
        wire::Event::PortForwardStatus {
            project,
            name,
            status,
        } => {
            if let Some(v) = s
                .portforwards
                .items
                .iter_mut()
                .find(|x| x.project == project && x.name == name)
            {
                v.status = pf_status(status);
            }
        }
        wire::Event::PortForwardLog {
            project,
            name,
            line,
            ..
        } => {
            if let Some(v) = s
                .portforwards
                .items
                .iter_mut()
                .find(|x| x.project == project && x.name == name)
            {
                push_log(&mut v.logs, line);
            }
        }
        wire::Event::TerminalScreen {
            terminal_id,
            screen,
        } => match s.agents.items.iter_mut().find(|t| t.id == terminal_id) {
            Some(t) => t.screen = Some(screen),
            None => s.agents.items.push(TermView {
                id: terminal_id,
                project: String::new(),
                command: String::new(),
                description: String::new(),
                status: AgentStatus::Running,
                started_at: 0,
                screen: Some(screen),
            }),
        },
        wire::Event::TerminalExited { terminal_id, .. } => {
            s.agents.items.retain(|t| t.id != terminal_id);
        }
        wire::Event::TaskCreated(t) | wire::Event::TaskUpdated(t) => {
            match s.tasks.iter_mut().find(|x| x.id == t.id) {
                Some(x) => *x = t,
                None => s.tasks.push(t),
            }
        }
        _ => {}
    }
}

fn from_snapshot(snap: wire::Snapshot) -> ClientState {
    ClientState {
        projects: snap
            .projects
            .iter()
            .map(|p| ProjectEntry {
                name: p.name.clone(),
                path: p.path.clone(),
                added_at: String::new(),
            })
            .collect(),
        services: ServiceProjection {
            items: snap
                .services
                .into_iter()
                .map(|s| ServiceView {
                    project: s.project,
                    name: s.name,
                    status: service_status(s.status),
                    original_port: s.original_port,
                    allocated_port: s.allocated_port,
                    logs: Vec::new(),
                })
                .collect(),
        },
        portforwards: PfProjection {
            items: snap
                .portforwards
                .into_iter()
                .map(|p| PfView {
                    project: p.project,
                    name: p.name,
                    status: pf_status(p.status),
                    local_port: p.local_port,
                    logs: Vec::new(),
                })
                .collect(),
        },
        agents: AgentProjection {
            items: snap
                .terminals
                .into_iter()
                .map(|t| TermView {
                    id: t.id,
                    project: t.project,
                    command: t.command.clone(),
                    description: t.command,
                    status: AgentStatus::Running,
                    started_at: t.started_at,
                    screen: None,
                })
                .collect(),
        },
        tasks: snap.tasks,
    }
}

fn push_log(logs: &mut Vec<String>, line: String) {
    logs.push(line);
    if logs.len() > 2000 {
        let excess = logs.len() - 2000;
        logs.drain(..excess);
    }
}

fn service_status(s: wire::ServiceStatus) -> ServiceStatus {
    match s {
        wire::ServiceStatus::Starting => ServiceStatus::Starting,
        wire::ServiceStatus::Running => ServiceStatus::Running,
        wire::ServiceStatus::Stopped => ServiceStatus::Stopped,
        wire::ServiceStatus::Failed => ServiceStatus::Failed,
    }
}

fn pf_status(s: wire::PortForwardStatus) -> PfStatus {
    match s {
        wire::PortForwardStatus::Starting => PfStatus::Starting,
        wire::PortForwardStatus::Active => PfStatus::Active,
        wire::PortForwardStatus::Restarting => PfStatus::Restarting,
        wire::PortForwardStatus::Failed => PfStatus::Failed,
        wire::PortForwardStatus::Stopped => PfStatus::Stopped,
    }
}

// ── Daemon discovery / auto-spawn ──

fn daemon_json_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".warpforge")
        .join("daemon.json")
}

fn read_endpoint() -> Option<wire::DaemonEndpoint> {
    let text = std::fs::read_to_string(daemon_json_path()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Return a reachable endpoint, spawning `wf daemon` if none is running.
async fn ensure_daemon() -> Result<wire::DaemonEndpoint> {
    if let Some(ep) = read_endpoint() {
        if tokio_tungstenite::connect_async(&ep.url).await.is_ok() {
            return Ok(ep);
        }
    }

    // Spawn the daemon using our own executable.
    let exe = std::env::current_exe().context("locating warpforge executable")?;
    std::process::Command::new(exe)
        .arg("daemon")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("spawning `wf daemon`")?;

    // Wait for it to publish a reachable endpoint.
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(ep) = read_endpoint() {
            if tokio_tungstenite::connect_async(&ep.url).await.is_ok() {
                return Ok(ep);
            }
        }
    }
    Err(anyhow!("daemon did not become reachable"))
}
