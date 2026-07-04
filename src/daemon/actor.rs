//! The daemon actor: a single tokio task that owns all runtime state (projects,
//! dev servers, port-forwards, agent PTYs, tasks) and is the sole mutator of it.
//!
//! Clients (the TUI now; a WebSocket server in Stage 2) never touch the managers
//! directly — they send [`Command`]s in and consume [`Event`]s out. This is the
//! daemon/client boundary the pivot is about: because every observer is on the
//! same event stream, there is no "primary" UI, and nothing assumes a single
//! consumer.
//!
//! The internal [`Event`] here is intentionally *not* the serializable wire type
//! (`warpforge_protocol::Event`): in-process it can carry rich handles like the
//! live vt100 parser. Stage 2 adds a thin translation from this to the wire
//! type for the socket.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::{broadcast, mpsc, oneshot};

use warpforge_protocol as wire;

use crate::agent::{AgentEvent, AgentManager, AgentStatus};
use crate::config::{load_workspace_config, sorted_services};
use crate::portforward::{PfEvent, PfStatus, PortForwardManager};
use crate::registry::ProjectEntry;
use crate::service::{ServiceEvent, ServiceManager, ServiceStatus};

use super::acp::{spawn_acp_session, AcpHandle, AcpUpdate};
use super::store::Store;
use super::task::{Task, TaskStatus};
use super::wire as wireconv;

/// Split a `project/service` service key back into its parts (split on first
/// `/`, which is how `ServiceManager` composes the key).
fn split_key(key: &str) -> (String, String) {
    match key.split_once('/') {
        Some((p, s)) => (p.to_string(), s.to_string()),
        None => (String::new(), key.to_string()),
    }
}

/// Commands from clients to the daemon.
pub enum Command {
    Projects(oneshot::Sender<Vec<ProjectEntry>>),
    Tasks(oneshot::Sender<Vec<Task>>),
    /// Full serializable state snapshot (sent to a client on `state.subscribe`).
    Snapshot(oneshot::Sender<wire::Snapshot>),
    /// Start every declared service + port-forward for a project (what "opening"
    /// a project used to do implicitly in the TUI — now explicit).
    OpenProject { name: String },
    StartService { project: String, service: String },
    StopService { project: String, service: String },
    RestartService { project: String, service: String },
    /// Start every declared service for a project (services only, no port-forwards).
    StartAllServices { project: String },
    StopProject { project: String },
    /// A window of a service's retained log lines (events only carry the tail).
    ServiceLogs {
        project: String,
        service: String,
        after: u64,
        limit: Option<u32>,
        reply: oneshot::Sender<Vec<String>>,
    },
    /// Start every declared port-forward for a project (port-forwards only).
    StartAllPortForwards { project: String },
    /// Start a single declared port-forward by its label.
    StartPortForward { project: String, name: String },
    StopPortForward { project: String, name: String },
    SpawnAgent {
        project: String,
        command: String,
        description: String,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<Result<String>>,
    },
    WriteAgent { id: String, data: Vec<u8> },
    ResizeAgent { id: String, cols: u16, rows: u16 },
    KillAgent { id: String },
    CreateTask {
        project: String,
        prompt: String,
        agent: String,
        tags: Vec<String>,
        include_runtime_context: bool,
        reply: oneshot::Sender<String>,
    },
    CancelTask { id: String },
    /// Compute the task's working-tree diff (git).
    GetDiff { task_id: String, reply: oneshot::Sender<wire::TaskDiff> },
    /// Old (HEAD) + new (working-tree) text of one file.
    GetFileContents {
        task_id: String,
        path: String,
        reply: oneshot::Sender<Option<wire::FileDoc>>,
    },
    /// Write new contents to a file in the task's working tree.
    SaveFile { task_id: String, path: String, content: String },
    /// Accept (keep) or reject (revert) a single hunk in the working tree.
    ResolveHunk {
        task_id: String,
        file: String,
        hunk_index: u32,
        resolution: wire::HunkResolution,
    },
    /// Send a follow-up prompt into a task's running agent session.
    SessionPrompt { task_id: String, text: String },
    /// Answer a permission request the agent raised.
    SessionPermission { task_id: String, request_id: String, outcome: String },
    Shutdown,
}

/// State deltas broadcast to every subscribed client.
#[derive(Clone)]
pub enum Event {
    ServiceStatus { project: String, service: String, status: ServiceStatus, allocated_port: u16 },
    ServiceLog { project: String, service: String, line: String },
    PortForwardStatus { project: String, name: String, status: PfStatus },
    PortForwardLog { project: String, name: String, line: String },
    /// A PTY agent was created; carries the live vt100 parser so an in-process
    /// client can render it. (Stage 3 replaces this with serialized screens.)
    AgentSpawned { id: String, project: String, screen: Arc<Mutex<vt100::Parser>> },
    AgentStatus { id: String, status: AgentStatus },
    AgentExited { id: String },
    TaskCreated(Task),
    TaskUpdated(Task),
    /// Structured ACP session activity for a task (tool calls, agent text,
    /// file edits, permission requests) — already in wire shape.
    SessionUpdate { task_id: String, update: wire::SessionUpdate },
    /// A PTY terminal's rendered screen changed (serialized, so clients need no
    /// terminal emulator — the daemon owns the one authoritative vt100 parser).
    TerminalScreen { terminal_id: String, screen: wire::TerminalScreen },
}

/// Cloneable handle clients use to talk to the daemon.
#[derive(Clone)]
pub struct DaemonHandle {
    cmd_tx: mpsc::Sender<Command>,
    event_tx: broadcast::Sender<Event>,
}

impl DaemonHandle {
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.event_tx.subscribe()
    }

    pub async fn send(&self, cmd: Command) {
        let _ = self.cmd_tx.send(cmd).await;
    }

    pub async fn projects(&self) -> Vec<ProjectEntry> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Projects(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn tasks(&self) -> Vec<Task> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Tasks(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn snapshot(&self) -> wire::Snapshot {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Snapshot(tx)).await;
        rx.await.unwrap_or_default()
    }

    pub async fn create_task(
        &self,
        project: &str,
        prompt: &str,
        agent: &str,
        tags: Vec<String>,
        include_runtime_context: bool,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CreateTask {
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            tags,
            include_runtime_context,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    pub async fn diff(&self, task_id: &str) -> wire::TaskDiff {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GetDiff { task_id: task_id.to_string(), reply: tx }).await;
        rx.await.unwrap_or_default()
    }

    pub async fn file_contents(&self, task_id: &str, path: &str) -> Option<wire::FileDoc> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::GetFileContents {
            task_id: task_id.to_string(),
            path: path.to_string(),
            reply: tx,
        })
        .await;
        rx.await.ok().flatten()
    }

    /// A window of a service's retained log lines (for backfill; live tail
    /// arrives via `ServiceLog` events).
    pub async fn service_logs(
        &self,
        project: &str,
        service: &str,
        after: u64,
        limit: Option<u32>,
    ) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::ServiceLogs {
            project: project.to_string(),
            service: service.to_string(),
            after,
            limit,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
    }

    /// Ask the daemon to tear down (stop services, port-forwards, agents) and
    /// end its actor loop. Used on SIGTERM so we don't leave orphans.
    pub async fn shutdown(&self) {
        self.send(Command::Shutdown).await;
    }

    pub async fn session_prompt(&self, task_id: &str, text: &str) {
        self.send(Command::SessionPrompt { task_id: task_id.into(), text: text.into() }).await;
    }

    pub async fn session_permission(&self, task_id: &str, request_id: &str, outcome: &str) {
        self.send(Command::SessionPermission {
            task_id: task_id.into(),
            request_id: request_id.into(),
            outcome: outcome.into(),
        })
        .await;
    }

    pub async fn spawn_agent(
        &self,
        project: &str,
        command: &str,
        description: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SpawnAgent {
            project: project.to_string(),
            command: command.to_string(),
            description: description.to_string(),
            cols,
            rows,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_else(|_| Err(anyhow::anyhow!("daemon closed")))
    }
}

pub struct Daemon {
    projects: Vec<ProjectEntry>,
    tasks: HashMap<String, Task>,
    /// Live agent sessions keyed by task id. One per task in v1; the map (not a
    /// field on Task) is what keeps multi-session-per-task additive later.
    sessions: HashMap<String, AcpHandle>,
    agents: AgentManager,
    services: ServiceManager,
    portforwards: PortForwardManager,
    event_tx: broadcast::Sender<Event>,
    acp_tx: mpsc::UnboundedSender<(String, AcpUpdate)>,
    store: Option<Store>,
}

impl Daemon {
    /// Construct the daemon and run its actor loop on a background task.
    /// Persisted tasks are loaded from the store (Running/Queued tasks come back
    /// as Interrupted — no live-session resumption in v1).
    pub fn spawn(projects: Vec<ProjectEntry>, store: Option<Store>) -> DaemonHandle {
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let (event_tx, _) = broadcast::channel(2048);
        let (agent_tx, agent_rx) = mpsc::unbounded_channel();
        let (service_tx, service_rx) = mpsc::unbounded_channel();
        let (pf_tx, pf_rx) = mpsc::unbounded_channel();
        let (acp_tx, acp_rx) = mpsc::unbounded_channel();

        let tasks = store
            .as_ref()
            .and_then(|s| s.load_tasks().ok())
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();

        let daemon = Daemon {
            projects,
            tasks,
            sessions: HashMap::new(),
            agents: AgentManager::new(agent_tx),
            services: ServiceManager::new(service_tx),
            portforwards: PortForwardManager::new(pf_tx),
            event_tx: event_tx.clone(),
            acp_tx,
            store,
        };

        tokio::spawn(daemon.run(cmd_rx, agent_rx, service_rx, pf_rx, acp_rx));

        DaemonHandle { cmd_tx, event_tx }
    }

    fn emit(&self, event: Event) {
        // Err just means no subscribers right now — fine.
        let _ = self.event_tx.send(event);
    }

    fn persist(&self, task: &Task) {
        if let Some(store) = &self.store {
            let _ = store.upsert_task(task);
        }
    }

    /// Build the serializable snapshot handed to a client on subscribe.
    fn build_snapshot(&self) -> wire::Snapshot {
        let projects = self
            .projects
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let (start, end) = crate::ports::port_range(i);
                let config = load_workspace_config(std::path::Path::new(&p.path));
                let declared_services =
                    config.as_ref().map(sorted_services).unwrap_or_default();
                let agent_templates = config
                    .as_ref()
                    .and_then(|c| c.agent_templates.clone())
                    .map(|m| m.into_iter().map(|(k, v)| (k, v.command)).collect())
                    .unwrap_or_default();
                wire::ProjectInfo {
                    name: p.name.clone(),
                    path: p.path.clone(),
                    port_range: (start, end),
                    declared_services,
                    agent_templates,
                }
            })
            .collect();

        let services = self
            .services
            .all()
            .map(|s| wire::ServiceInfo {
                project: s.project_name.clone(),
                name: s.name.clone(),
                command: s.command.clone(),
                status: wireconv::service_status(&s.status),
                original_port: s.original_port,
                allocated_port: s.allocated_port,
                log_seq: 0,
            })
            .collect();

        let portforwards = self
            .portforwards
            .forwards
            .iter()
            .map(|(key, pf)| {
                let project = key.split_once('/').map(|(p, _)| p).unwrap_or("").to_string();
                wire::PortForwardInfo {
                    project,
                    name: pf.name.clone(),
                    namespace: pf.namespace.clone(),
                    pod: pf.pod_prefix.clone(),
                    local_port: pf.local_port,
                    remote_port: pf.remote_port,
                    status: wireconv::pf_status(&pf.status),
                }
            })
            .collect();

        let mut tasks: Vec<wire::TaskInfo> =
            self.tasks.values().map(wireconv::task_info).collect();
        tasks.sort_by_key(|t| t.created_at);

        let terminals = self
            .agents
            .all()
            .map(|a| {
                let (cols, rows) = a.dims();
                wire::TerminalInfo {
                    id: a.id.clone(),
                    project: a.project_name.clone(),
                    command: a.command.clone(),
                    started_at: a.started_at,
                    cols,
                    rows,
                }
            })
            .collect();

        wire::Snapshot {
            projects,
            services,
            portforwards,
            tasks,
            terminals,
        }
    }

    fn project_path(&self, name: &str) -> Option<String> {
        self.projects.iter().find(|p| p.name == name).map(|p| p.path.clone())
    }

    fn project_index(&self, name: &str) -> usize {
        self.projects.iter().position(|p| p.name == name).unwrap_or(0)
    }

    async fn run(
        mut self,
        mut cmd_rx: mpsc::Receiver<Command>,
        mut agent_rx: mpsc::UnboundedReceiver<AgentEvent>,
        mut service_rx: mpsc::UnboundedReceiver<ServiceEvent>,
        mut pf_rx: mpsc::UnboundedReceiver<PfEvent>,
        mut acp_rx: mpsc::UnboundedReceiver<(String, AcpUpdate)>,
    ) {
        loop {
            tokio::select! {
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(Command::Shutdown) | None => break,
                        Some(cmd) => self.handle_command(cmd).await,
                    }
                }
                Some(ev) = agent_rx.recv() => self.handle_agent_event(ev),
                Some(ev) = service_rx.recv() => self.handle_service_event(ev),
                Some(ev) = pf_rx.recv() => self.handle_pf_event(ev),
                Some((task_id, update)) = acp_rx.recv() => self.handle_acp_update(task_id, update),
            }
        }

        // Teardown — stop everything we started.
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        self.agents.kill_all();
    }

    fn handle_agent_event(&mut self, ev: AgentEvent) {
        self.agents.apply_event(&ev);
        match ev {
            AgentEvent::Data { id, .. } => {
                if let Some(agent) = self.agents.get(&id) {
                    self.emit(Event::AgentStatus { id: id.clone(), status: agent.status.clone() });
                    // Serialize and push the terminal screen for remote clients.
                    if let Ok(parser) = agent.screen.lock() {
                        let screen = wireconv::terminal_screen(&parser);
                        self.emit(Event::TerminalScreen { terminal_id: id, screen });
                    }
                }
            }
            AgentEvent::Exit { id, .. } => self.emit(Event::AgentExited { id }),
        }
    }

    fn handle_service_event(&mut self, ev: ServiceEvent) {
        let broadcast = match &ev {
            ServiceEvent::Log { key, line } => {
                let (project, service) = split_key(key);
                Event::ServiceLog { project, service, line: line.clone() }
            }
            ServiceEvent::StatusChange { key, status } => {
                let (project, service) = split_key(key);
                let allocated_port = self
                    .services
                    .get(&project, &service)
                    .map(|s| s.allocated_port)
                    .unwrap_or(0);
                Event::ServiceStatus { project, service, status: status.clone(), allocated_port }
            }
        };
        self.services.apply_event(ev);
        self.emit(broadcast);
    }

    fn handle_pf_event(&mut self, ev: PfEvent) {
        let broadcast = match &ev {
            PfEvent::Log { project, name, line } => {
                Event::PortForwardLog { project: project.clone(), name: name.clone(), line: line.clone() }
            }
            PfEvent::Active { project, name, .. } | PfEvent::Restarted { project, name, .. } => {
                Event::PortForwardStatus { project: project.clone(), name: name.clone(), status: PfStatus::Active }
            }
            PfEvent::Failed { project, name, .. } => {
                Event::PortForwardStatus { project: project.clone(), name: name.clone(), status: PfStatus::Failed }
            }
        };
        self.portforwards.apply_event(ev);
        self.emit(broadcast);
    }

    async fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::Shutdown => {}
            Command::Projects(reply) => {
                let _ = reply.send(self.projects.clone());
            }
            Command::Tasks(reply) => {
                let mut tasks: Vec<Task> = self.tasks.values().cloned().collect();
                tasks.sort_by_key(|t| t.created_at);
                let _ = reply.send(tasks);
            }
            Command::Snapshot(reply) => {
                let _ = reply.send(self.build_snapshot());
            }
            Command::OpenProject { name } => self.open_project(&name).await,
            Command::StartService { project, service } => {
                self.start_one_service(&project, &service).await;
            }
            Command::StopService { project, service } => {
                self.services.stop(&project, &service).await.ok();
            }
            Command::RestartService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.start_one_service(&project, &service).await;
            }
            Command::StartAllServices { project } => {
                self.start_services(&project).await;
            }
            Command::StopProject { project } => {
                self.services.stop_project(&project).await.ok();
                self.portforwards.stop_project(&project);
            }
            Command::ServiceLogs { project, service, after, limit, reply } => {
                let lines = self
                    .services
                    .get(&project, &service)
                    .map(|s| {
                        let start = (after as usize).min(s.logs.len());
                        let mut window: Vec<String> = s.logs[start..].to_vec();
                        if let Some(n) = limit {
                            let n = n as usize;
                            if window.len() > n {
                                window = window.split_off(window.len() - n);
                            }
                        }
                        window
                    })
                    .unwrap_or_default();
                let _ = reply.send(lines);
            }
            Command::StartAllPortForwards { project } => {
                self.start_portforwards(&project).await;
            }
            Command::StartPortForward { project, name } => {
                self.start_one_portforward(&project, &name).await;
            }
            Command::StopPortForward { project, name } => {
                self.portforwards.stop(&project, &name);
            }
            Command::SpawnAgent { project, command, description, cols, rows, reply } => {
                let result = match self.project_path(&project) {
                    Some(path) => self
                        .agents
                        .spawn(&project, &path, &command, &description, cols, rows),
                    None => Err(anyhow::anyhow!("unknown project: {project}")),
                };
                if let Ok(ref id) = result {
                    if let Some(agent) = self.agents.get(id) {
                        self.emit(Event::AgentSpawned {
                            id: id.clone(),
                            project: project.clone(),
                            screen: Arc::clone(&agent.screen),
                        });
                    }
                }
                let _ = reply.send(result);
            }
            Command::WriteAgent { id, data } => self.agents.write(&id, data),
            Command::ResizeAgent { id, cols, rows } => self.agents.resize(&id, cols, rows),
            Command::KillAgent { id } => {
                self.agents.kill(&id);
                self.emit(Event::AgentExited { id });
            }
            Command::CreateTask { project, prompt, agent, tags, include_runtime_context, reply } => {
                let task = Task::new(&project, &prompt, &agent, tags);
                let id = task.id.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.persist(&task);
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id.clone());
                self.start_session(&id, &project, &agent, &prompt, include_runtime_context);
            }
            Command::GetDiff { task_id, reply } => {
                // Resolve the repo path (sync) before awaiting git, so no shared
                // borrow of self is held across the await.
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let files = match repo {
                    Some(path) => super::diff::working_diff(&path).await.unwrap_or_default(),
                    None => Vec::new(),
                };
                let _ = reply.send(wire::TaskDiff { task_id, files });
            }
            Command::GetFileContents { task_id, path, reply } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                let doc = match repo {
                    Some(p) => super::diff::file_doc(&p, &path).await.ok(),
                    None => None,
                };
                let _ = reply.send(doc);
            }
            Command::SaveFile { task_id, path, content } => {
                let repo = self
                    .tasks
                    .get(&task_id)
                    .and_then(|t| self.project_path(&t.project));
                if let Some(p) = repo {
                    if super::diff::save_file(&p, &path, &content).is_ok() {
                        // Nudge clients so the diff/file list refetches.
                        if let Some(task) = self.tasks.get_mut(&task_id) {
                            task.updated_at = super::task::now_secs();
                            let updated = task.clone();
                            self.persist(&updated);
                            self.emit(Event::TaskUpdated(updated));
                        }
                    }
                }
            }
            Command::ResolveHunk { task_id, file, hunk_index, resolution } => {
                // accept keeps the change (no-op); only reject touches the tree.
                if resolution == wire::HunkResolution::Reject {
                    let repo = self
                        .tasks
                        .get(&task_id)
                        .and_then(|t| self.project_path(&t.project));
                    if let Some(path) = repo {
                        if super::diff::reject_hunk(&path, &file, hunk_index).await.is_ok() {
                            if let Some(task) = self.tasks.get_mut(&task_id) {
                                task.updated_at = super::task::now_secs();
                                if task.files_changed > 0 {
                                    task.files_changed -= 1;
                                }
                                let updated = task.clone();
                                self.persist(&updated);
                                self.emit(Event::TaskUpdated(updated));
                            }
                        }
                    }
                }
            }
            Command::CancelTask { id } => {
                if let Some(handle) = self.sessions.remove(&id) {
                    handle.cancel();
                }
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(TaskStatus::Done);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            Command::SessionPrompt { task_id, text } => {
                // Always echo the developer's message so every client shows the
                // same conversation.
                self.emit(Event::SessionUpdate {
                    task_id: task_id.clone(),
                    update: wire::SessionUpdate::UserMessage { text: text.clone() },
                });
                match self.sessions.get(&task_id) {
                    Some(handle) => handle.prompt(text),
                    None => {
                        // No live session (interrupted after a restart, or the
                        // agent exited). Say so instead of dropping the message.
                        self.emit(Event::SessionUpdate {
                            task_id: task_id.clone(),
                            update: wire::SessionUpdate::AgentText {
                                text: "⚠ No live agent session for this task — its \
                                       session ended (e.g. daemon restart). Re-run \
                                       the task to continue."
                                    .into(),
                            },
                        });
                    }
                }
            }
            Command::SessionPermission { task_id, request_id, outcome } => {
                if let Some(handle) = self.sessions.get(&task_id) {
                    handle.answer(request_id, outcome);
                }
            }
        }
    }

    /// "Opening" a project starts both its declared services and port-forwards
    /// (what entering a project did implicitly in the TUI).
    async fn open_project(&mut self, name: &str) {
        self.start_services(name).await;
        self.start_portforwards(name).await;
    }

    /// Start every declared service for a project (no port-forwards).
    async fn start_services(&mut self, name: &str) {
        let Some(path) = self.project_path(name) else { return };
        let index = self.project_index(name);
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else { return };

        for svc_name in sorted_services(&config) {
            if let Some(svc) = config.services.get(&svc_name) {
                self.services
                    .start(
                        name,
                        &path,
                        index,
                        &svc_name,
                        &svc.command,
                        svc.port.unwrap_or(0),
                        svc.env.as_ref(),
                        svc.ready_pattern.as_deref(),
                    )
                    .await
                    .ok();
                self.emit_service_status(name, &svc_name);
            }
        }
    }

    /// Start every declared port-forward for a project (no services).
    async fn start_portforwards(&mut self, name: &str) {
        let Some(path) = self.project_path(name) else { return };
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else { return };
        self.portforwards.start_all(name, &config.portforwards).await;
    }

    /// Start a single declared port-forward, matched by its label (explicit
    /// `name:` in config, else the `namespace:pod` fallback the manager uses).
    async fn start_one_portforward(&mut self, project: &str, label: &str) {
        let Some(path) = self.project_path(project) else { return };
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else { return };
        let matched: Vec<_> = config
            .portforwards
            .into_iter()
            .filter(|cfg| {
                let cfg_label = cfg
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", cfg.namespace, cfg.pod));
                cfg_label == label
            })
            .collect();
        self.portforwards.start_all(project, &matched).await;
    }

    async fn start_one_service(&mut self, project: &str, service: &str) {
        let Some(path) = self.project_path(project) else { return };
        let index = self.project_index(project);
        let Some(config) = load_workspace_config(std::path::Path::new(&path)) else { return };
        let Some(svc) = config.services.get(service) else { return };
        self.services
            .start(
                project,
                &path,
                index,
                service,
                &svc.command,
                svc.port.unwrap_or(0),
                svc.env.as_ref(),
                svc.ready_pattern.as_deref(),
            )
            .await
            .ok();
        self.emit_service_status(project, service);
    }

    /// Resolve a task's `agent` to a spawnable ACP command: a named template
    /// from the project's `.workspace.yaml` wins; otherwise the string is
    /// treated as a raw command (the protocol allows either).
    fn resolve_agent_command(&self, project: &str, agent: &str) -> String {
        if let Some(path) = self.project_path(project) {
            if let Some(config) = load_workspace_config(std::path::Path::new(&path)) {
                if let Some(tmpl) = config.agent_templates.and_then(|m| m.get(agent).cloned()) {
                    return tmpl.command;
                }
            }
        }
        agent.to_string()
    }

    /// A context block describing the project's currently-running services and
    /// their live URLs — prepended to the agent's first prompt so it knows the
    /// app is already up and can hit real endpoints / run tests against it.
    fn runtime_context(&self, project: &str) -> Option<String> {
        let mut lines: Vec<String> = self
            .services
            .all()
            .filter(|s| {
                s.project_name == project
                    && s.allocated_port > 0
                    && matches!(s.status, ServiceStatus::Running | ServiceStatus::Starting)
            })
            .map(|s| format!("- {} → http://localhost:{}", s.name, s.allocated_port))
            .collect();
        if lines.is_empty() {
            return None;
        }
        lines.sort();
        Some(format!(
            "[warpforge] These services are already running for this project — \
             you can hit these endpoints and run tests against them:\n{}",
            lines.join("\n")
        ))
    }

    /// Spawn an ACP agent session for a task and remember its handle.
    fn start_session(
        &mut self,
        task_id: &str,
        project: &str,
        agent: &str,
        prompt: &str,
        include_runtime_context: bool,
    ) {
        let cwd = self.project_path(project).unwrap_or_else(|| ".".to_string());
        let command = self.resolve_agent_command(project, agent);
        let full_prompt = match include_runtime_context.then(|| self.runtime_context(project)).flatten() {
            Some(ctx) => format!("{ctx}\n\n{prompt}"),
            None => prompt.to_string(),
        };
        match spawn_acp_session(
            task_id.to_string(),
            command,
            cwd,
            full_prompt,
            self.acp_tx.clone(),
        ) {
            Ok(handle) => {
                self.sessions.insert(task_id.to_string(), handle);
            }
            Err(e) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(format!("failed to start agent: {e}"));
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    fn handle_acp_update(&mut self, task_id: String, update: AcpUpdate) {
        match update {
            AcpUpdate::SessionStarted { session_id } => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.attach_session(session_id);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::AgentText(text) => self.emit_session(&task_id, wire::SessionUpdate::AgentText { text }),
            AcpUpdate::AgentThought(text) => {
                self.emit_session(&task_id, wire::SessionUpdate::AgentThought { text })
            }
            AcpUpdate::ToolCall { id, title, status, kind, content } => self.emit_session(
                &task_id,
                wire::SessionUpdate::ToolCall {
                    tool_call_id: id,
                    title,
                    status: wireconv::tool_status(&status),
                    tool_kind: kind,
                    content,
                },
            ),
            AcpUpdate::Plan { entries } => {
                self.emit_session(&task_id, wire::SessionUpdate::Plan { entries })
            }
            AcpUpdate::AvailableCommands { commands } => {
                self.emit_session(&task_id, wire::SessionUpdate::AvailableCommands { commands })
            }
            AcpUpdate::FileEdit { path } => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.files_changed += 1;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.emit_session(&task_id, wire::SessionUpdate::FileEdit { path });
            }
            AcpUpdate::PermissionRequest { request_id, title, options } => self.emit_session(
                &task_id,
                wire::SessionUpdate::PermissionRequest { request_id, title, options },
            ),
            AcpUpdate::TurnEnded { stop_reason } => {
                self.emit_session(&task_id, wire::SessionUpdate::TurnEnded { stop_reason });
                // A finished turn with edits is ready for review.
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    if task.status == TaskStatus::Running {
                        task.set_status(TaskStatus::NeedsReview);
                        let updated = task.clone();
                        self.persist(&updated);
                        self.emit(Event::TaskUpdated(updated));
                    }
                }
            }
            AcpUpdate::Error(message) => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    fn emit_session(&self, task_id: &str, update: wire::SessionUpdate) {
        self.emit(Event::SessionUpdate { task_id: task_id.to_string(), update });
    }

    /// Broadcast a service's current status. Emitted right after a start so a
    /// client learns the service exists (it may have subscribed before it did)
    /// — without this, newly started services never appear for other clients.
    fn emit_service_status(&self, project: &str, service: &str) {
        if let Some(svc) = self.services.get(project, service) {
            self.emit(Event::ServiceStatus {
                project: project.to_string(),
                service: service.to_string(),
                status: svc.status.clone(),
                allocated_port: svc.allocated_port,
            });
        }
    }
}
