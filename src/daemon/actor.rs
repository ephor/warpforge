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

use crate::agent::{AgentEvent, AgentManager, AgentStatus};
use crate::config::{load_workspace_config, sorted_services};
use crate::portforward::{PfEvent, PfStatus, PortForwardManager};
use crate::registry::ProjectEntry;
use crate::service::{ServiceEvent, ServiceManager, ServiceStatus};

use super::task::{Task, TaskStatus};

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
    /// Start every declared service + port-forward for a project (what "opening"
    /// a project used to do implicitly in the TUI — now explicit).
    OpenProject { name: String },
    StartService { project: String, service: String },
    StopService { project: String, service: String },
    RestartService { project: String, service: String },
    StopProject { project: String },
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
        reply: oneshot::Sender<String>,
    },
    CancelTask { id: String },
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

    pub async fn create_task(
        &self,
        project: &str,
        prompt: &str,
        agent: &str,
        tags: Vec<String>,
    ) -> String {
        let (tx, rx) = oneshot::channel();
        self.send(Command::CreateTask {
            project: project.to_string(),
            prompt: prompt.to_string(),
            agent: agent.to_string(),
            tags,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or_default()
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
    agents: AgentManager,
    services: ServiceManager,
    portforwards: PortForwardManager,
    event_tx: broadcast::Sender<Event>,
}

impl Daemon {
    /// Construct the daemon and run its actor loop on a background task.
    pub fn spawn(projects: Vec<ProjectEntry>) -> DaemonHandle {
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let (event_tx, _) = broadcast::channel(2048);
        let (agent_tx, agent_rx) = mpsc::unbounded_channel();
        let (service_tx, service_rx) = mpsc::unbounded_channel();
        let (pf_tx, pf_rx) = mpsc::unbounded_channel();

        let daemon = Daemon {
            projects,
            tasks: HashMap::new(),
            agents: AgentManager::new(agent_tx),
            services: ServiceManager::new(service_tx),
            portforwards: PortForwardManager::new(pf_tx),
            event_tx: event_tx.clone(),
        };

        tokio::spawn(daemon.run(cmd_rx, agent_rx, service_rx, pf_rx));

        DaemonHandle { cmd_tx, event_tx }
    }

    fn emit(&self, event: Event) {
        // Err just means no subscribers right now — fine.
        let _ = self.event_tx.send(event);
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
                    self.emit(Event::AgentStatus { id, status: agent.status.clone() });
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
            Command::StopProject { project } => {
                self.services.stop_project(&project).await.ok();
                self.portforwards.stop_project(&project);
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
            Command::CreateTask { project, prompt, agent, tags, reply } => {
                let task = Task::new(&project, &prompt, &agent, tags);
                let id = task.id.clone();
                self.tasks.insert(id.clone(), task.clone());
                self.emit(Event::TaskCreated(task));
                let _ = reply.send(id);
                // Stage 4 will attach a real ACP session here; for now the task
                // sits Queued until the session layer exists.
            }
            Command::CancelTask { id } => {
                if let Some(task) = self.tasks.get_mut(&id) {
                    task.set_status(TaskStatus::Done);
                    let updated = task.clone();
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    async fn open_project(&mut self, name: &str) {
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
            }
        }
        self.portforwards.start_all(name, &config.portforwards).await;
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
    }
}
