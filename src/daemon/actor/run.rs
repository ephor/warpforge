use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};

use warpforge_protocol as wire;

use crate::agent::{AgentEvent, AgentStatus};
use crate::config::{load_workspace_config, try_load_workspace_config};
use crate::portforward::{PfEvent, PfStatus};
use crate::service::{ServiceEvent, ServiceStatus};

use crate::daemon::acp::{AcpUpdate, PolicyCheck};
use crate::daemon::actor::config_observer::split_key;
use crate::daemon::actor::config_observer::CONFIG_POLL_INTERVAL;
use crate::daemon::actor::{Command, Daemon, Event};
use crate::daemon::store::Store;
use crate::daemon::task::{Task, TaskStatus};
use crate::daemon::wire as wireconv;

impl Daemon {
    pub(crate) fn emit(&self, event: Event) {
        // Err just means no subscribers right now — fine.
        let _ = self.event_tx.send(event);
    }

    pub(crate) fn persist(&self, task: &Task) {
        self.persist.task(task);
    }

    /// A blocking store read, for startup only.
    ///
    /// Its one caller — `restore_workflow_runs` — runs inside [`Daemon::spawn`]
    /// before the actor loop starts, so blocking here blocks nothing. A handler
    /// must never use it: that is a blocking disk read on the actor's thread,
    /// which is the whole subject of ADR 0002. Reads from a handler go through
    /// `runtime::store_read` on the blocking pool, and writes through
    /// `self.persist`.
    pub(crate) fn with_store<T>(&self, read: impl FnOnce(&Store) -> T) -> Option<T> {
        let store = self.store.as_ref()?;
        // Recover a poisoned lock instead of taking the daemon down with the
        // persistence thread.
        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        Some(read(&guard))
    }
    /// Carries tasks and metadata only; `session_history` stays empty — a
    /// client needing a transcript asks `session.history` for that one task.
    pub(crate) fn build_snapshot_core(&self) -> wire::Snapshot {
        let mut projects = Vec::new();
        let mut services = Vec::new();
        let mut portforwards = Vec::new();
        for (index, project) in self.projects.iter().enumerate() {
            let config = load_workspace_config(Path::new(&project.path));
            let state = self.build_project_config_state(index, config.as_ref());
            projects.push(state.project);
            services.extend(state.services);
            portforwards.extend(state.portforwards);
        }

        let mut tasks: Vec<wire::TaskInfo> = self.tasks.values().map(wireconv::task_info).collect();
        for task in &mut tasks {
            task.pending_permission = self.pending_permissions.has_pending(&task.id);
        }
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));

        let terminals = self
            .agents
            .live()
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

        // History is read from the store by the caller, then folded; the actor
        // holds no transcript in memory to fold here.
        wire::Snapshot {
            projects,
            services,
            portforwards,
            tasks,
            terminals,
            session_history: HashMap::new(),
            agents: self.configured_agents.clone(),
            accounts: self.account_infos(),
        }
    }

    pub(crate) fn project_path(&self, name: &str) -> Option<String> {
        self.projects
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.path.clone())
    }

    pub(crate) fn task_repo_path(&self, task_id: &str) -> Option<String> {
        self.tasks.get(task_id).and_then(|task| {
            task.worktree
                .clone()
                .or_else(|| self.project_path(&task.project))
        })
    }

    /// Bump a task's `updated_at`, persist, and emit `TaskUpdated` so every
    /// client refetches its diff/branch (used after git ops change the tree).
    pub(crate) fn bump_task(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.updated_at = crate::daemon::task::now_secs();
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
    }

    pub(crate) fn project_index(&self, name: &str) -> usize {
        self.projects
            .iter()
            .position(|p| p.name == name)
            .unwrap_or(0)
    }

    pub(crate) async fn run(
        mut self,
        mut cmd_rx: mpsc::Receiver<Command>,
        mut agent_rx: mpsc::UnboundedReceiver<AgentEvent>,
        mut service_rx: mpsc::UnboundedReceiver<ServiceEvent>,
        mut pf_rx: mpsc::UnboundedReceiver<PfEvent>,
        mut acp_rx: mpsc::UnboundedReceiver<(String, AcpUpdate)>,
        mut policy_rx: mpsc::UnboundedReceiver<PolicyCheck>,
    ) {
        enum ShutdownReply {
            Requested(oneshot::Sender<()>),
            Update(oneshot::Sender<Vec<String>>),
        }

        let mut config_poll = tokio::time::interval(CONFIG_POLL_INTERVAL);
        config_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Quota windows are hours to days wide, so there is nothing to learn from
        // polling every few minutes — and the usage endpoints answer 429 when we
        // do. 20 minutes keeps the numbers fresh enough to act on.
        const LIMITS_INTERVAL: Duration = Duration::from_secs(1200);
        let mut limits_poll = tokio::time::interval(LIMITS_INTERVAL);
        limits_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // first tick completes immediately; skip it so initial fetch is explicit via spawned task in Daemon::spawn
        limits_poll.tick().await;

        let shutdown_reply = loop {
            tokio::select! {
                _ = limits_poll.tick() => {
                    self.capture_credentials();
                    let accounts = self.accounts.clone();
                    let cmd_tx = self.cmd_tx.clone();
                    tokio::spawn(async move {
                        let fetched = crate::daemon::limits::poll::fetch_all(accounts).await;
                        let _ = cmd_tx.send(Command::AgentLimitsUpdated { accounts: fetched }).await;
                    });
                }
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(Command::Shutdown { reply }) => break Some(ShutdownReply::Requested(reply)),
                        Some(Command::UpdateSafety { reply }) => {
                            let blockers = self.update_blockers_snapshot();
                            if blockers.is_empty() {
                                break Some(ShutdownReply::Update(reply));
                            }
                            let _ = reply.send(blockers);
                        }
                        None => break None,
                        Some(cmd) => self.handle_command(cmd).await,
                    }
                }
                Some(ev) = agent_rx.recv() => self.handle_agent_event(ev),
                Some(ev) = service_rx.recv() => self.handle_service_event(ev),
                Some(ev) = pf_rx.recv() => self.handle_pf_event(ev),
                Some((task_id, update)) = acp_rx.recv() => self.handle_acp_update(task_id, update).await,
                Some(check) = policy_rx.recv() => self.handle_policy_check(check).await,
                _ = config_poll.tick() => self.handle_config_changes().await,
            }
        };

        // Teardown — stop everything we started.
        self.services.stop_all().await.ok();
        self.portforwards.stop_all().await.ok();
        // Only ports this daemon handed out. Sweeping the whole range kills
        // whatever else happens to listen there — a developer's own server, or
        // an agent process — and this runs on every shutdown, including the
        // ones the test suite performs on the developer's machine.
        crate::service::kill_listeners_on_ports(&crate::ports::allocated_in_ranges(
            &self.project_port_ranges(),
        ))
        .await;
        self.agents.kill_all();
        // Writes are applied on another thread, so exiting without draining the
        // queue drops the tail of every transcript written since the last
        // batch. Everything above can still enqueue, so flush last.
        self.persist.flush().await;
        match shutdown_reply {
            Some(ShutdownReply::Requested(reply)) => {
                let _ = reply.send(());
            }
            Some(ShutdownReply::Update(reply)) => {
                let _ = reply.send(Vec::new());
            }
            None => {}
        }
    }

    pub(crate) async fn handle_config_changes(&mut self) {
        let ready = self.config_observer.ready(&self.projects, Instant::now());
        for (project_name, fingerprint) in ready {
            let Some(index) = self
                .projects
                .iter()
                .position(|project| project.name == project_name)
            else {
                continue;
            };
            let project_path = self.projects[index].path.clone();

            // An existing but invalid file is commonly just an editor's
            // intermediate save. Keep the last rendered state and retry after
            // the contents change instead of flashing empty controls.
            let config = match try_load_workspace_config(Path::new(&project_path)) {
                Ok(config) => config,
                Err(_) => continue,
            };

            self.remove_undeclared_runtime(&project_name, config.as_ref())
                .await;
            self.config_observer
                .mark_applied(&project_name, fingerprint);
            let state = self.build_project_config_state(index, config.as_ref());
            self.emit(Event::ProjectConfigChanged(state));
        }
    }

    pub(crate) fn handle_agent_event(&mut self, ev: AgentEvent) {
        let known_agent = match &ev {
            AgentEvent::Data { id, .. } | AgentEvent::Exit { id, .. } => {
                self.agents.get(id).is_some()
            }
        };
        self.agents.apply_event(&ev);
        match ev {
            AgentEvent::Data { id, data, .. } => {
                if let Some(agent) = self.agents.get(&id) {
                    self.emit(Event::AgentStatus {
                        id: id.clone(),
                        status: agent.status.clone(),
                    });
                    // Serialize and push the terminal screen for remote clients.
                    if let Ok(parser) = agent.screen.lock() {
                        let screen = wireconv::terminal_screen(&parser);
                        self.emit(Event::TerminalScreen {
                            terminal_id: id.clone(),
                            screen,
                        });
                    }
                    // Raw PTY bytes for terminal-emulator clients (xterm.js).
                    use base64::Engine;
                    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    self.emit(Event::TerminalData {
                        terminal_id: id,
                        data_b64,
                    });
                }
            }
            AgentEvent::Exit { id, .. } if known_agent => self.emit(Event::AgentExited { id }),
            AgentEvent::Exit { .. } => {}
        }
    }

    pub(crate) fn handle_service_event(&mut self, ev: ServiceEvent) {
        let broadcast = match &ev {
            ServiceEvent::Log { key, line, .. } => {
                let (project, service) = split_key(key);
                Event::ServiceLog {
                    project,
                    service,
                    line: line.clone(),
                }
            }
            ServiceEvent::StatusChange { key, status, .. } => {
                let (project, service) = split_key(key);
                let allocated_port = self
                    .services
                    .get(&project, &service)
                    .map(|s| s.allocated_port)
                    .unwrap_or(0);
                Event::ServiceStatus {
                    project,
                    service,
                    status: status.clone(),
                    allocated_port,
                }
            }
        };
        self.services.apply_event(ev);
        match &broadcast {
            Event::ServiceStatus {
                project, service, ..
            } => {
                self.emit_service_status(project, service);
            }
            Event::ServiceLog {
                project, service, ..
            } if self.services.get(project, service).is_some() => self.emit(broadcast),
            _ => {}
        }
    }

    pub(crate) fn handle_pf_event(&mut self, ev: PfEvent) {
        let key = format!("{}/{}", ev.project(), ev.name());
        let broadcast = match &ev {
            PfEvent::Log {
                project,
                name,
                line,
            } => Event::PortForwardLog {
                project: project.clone(),
                name: name.clone(),
                line: line.clone(),
            },
            PfEvent::Active { project, name, .. } | PfEvent::Restarted { project, name, .. } => {
                Event::PortForwardStatus {
                    project: project.clone(),
                    name: name.clone(),
                    status: PfStatus::Active,
                }
            }
            PfEvent::Failed { project, name, .. } => Event::PortForwardStatus {
                project: project.clone(),
                name: name.clone(),
                status: PfStatus::Failed,
            },
        };
        self.portforwards.apply_event(ev);
        if self.portforwards.forwards.contains_key(&key) {
            self.emit(broadcast);
        }
    }

    pub(crate) fn update_blockers_snapshot(&self) -> Vec<String> {
        let mut blockers = Vec::new();
        let active_tasks = self
            .tasks
            .values()
            .filter(|task| matches!(task.status, TaskStatus::Queued | TaskStatus::Running))
            .count();
        if active_tasks > 0 {
            blockers.push(format!("{active_tasks} agent task(s) are active"));
        }
        let terminals = self
            .agents
            .all()
            .filter(|agent| {
                matches!(
                    agent.status,
                    AgentStatus::Spawning | AgentStatus::Running | AgentStatus::NeedsReview
                )
            })
            .count();
        if terminals > 0 {
            blockers.push(format!("{terminals} terminal session(s) are active"));
        }
        let transitioning_services = self
            .services
            .all()
            .filter(|service| matches!(service.status, ServiceStatus::Starting))
            .count();
        if transitioning_services > 0 {
            blockers.push(format!(
                "{transitioning_services} service(s) are still starting"
            ));
        }
        let transitioning_forwards = self
            .portforwards
            .forwards
            .values()
            .filter(|forward| matches!(forward.status, PfStatus::Starting | PfStatus::Restarting))
            .count();
        if transitioning_forwards > 0 {
            blockers.push(format!(
                "{transitioning_forwards} port-forward(s) are transitioning"
            ));
        }
        blockers
    }
}
