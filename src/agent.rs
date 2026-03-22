use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum AgentStatus {
    Spawning,
    Running,
    NeedsReview,
    Completed,
    Failed,
}

impl std::fmt::Display for AgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentStatus::Spawning => write!(f, "spawning"),
            AgentStatus::Running => write!(f, "running"),
            AgentStatus::NeedsReview => write!(f, "needs-review"),
            AgentStatus::Completed => write!(f, "completed"),
            AgentStatus::Failed => write!(f, "failed"),
        }
    }
}

#[allow(dead_code)]
pub struct Agent {
    pub id: String,
    pub project_name: String,
    pub command: String,
    pub description: String,
    pub status: AgentStatus,
    /// Unix timestamp (secs) when spawned — used for elapsed time display
    pub started_at: u64,
    /// Raw PTY output bytes accumulated for vt100 parsing
    pub output: Vec<u8>,
    /// Channel to send input to PTY
    pub input_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// vt100 parser state (shared so render can access it)
    pub screen: Arc<Mutex<vt100::Parser>>,
    cols: u16,
    rows: u16,
}

/// Notification sent from PTY reader to UI event loop
pub enum AgentEvent {
    Data { id: String, needs_review: bool },
    Exit { id: String, #[allow(dead_code)] code: i32 },
}

#[allow(dead_code)]
const REVIEW_PATTERNS: &[&str] = &[
    "waiting for input",
    "Press enter to continue",
    "What would you like",
    "Do you want to",
    "Accept changes",
    "[Y/n]",
    "[y/N]",
];

pub struct AgentManager {
    agents: HashMap<String, Agent>,
    /// Forwarded to app event loop for rerender triggers
    pub event_tx: mpsc::UnboundedSender<AgentEvent>,
}

#[allow(dead_code)]
impl AgentManager {
    pub fn new(event_tx: mpsc::UnboundedSender<AgentEvent>) -> Self {
        Self {
            agents: HashMap::new(),
            event_tx,
        }
    }

    pub fn spawn(
        &mut self,
        project_name: &str,
        project_path: &str,
        command: &str,
        description: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string()[..8].to_string();
        let pty_system = NativePtySystem::default();

        let pair: PtyPair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("failed to open PTY")?;

        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", command]);
        cmd.cwd(project_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // Spawn child then drop slave FD in parent — required for proper PTY behaviour
        let PtyPair { master, slave } = pair;
        let _child = slave.spawn_command(cmd)?;
        drop(slave);

        let mut pty_writer = master.take_writer()?;
        let mut pty_reader = master.try_clone_reader()?;

        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let screen = Arc::new(Mutex::new(vt100::Parser::new(rows, cols, 0)));

        // Writer task: sync I/O — must run in spawn_blocking, flush after each write
        tokio::task::spawn_blocking(move || {
            while let Some(data) = input_rx.blocking_recv() {
                if pty_writer.write_all(&data).is_err() {
                    break;
                }
                let _ = pty_writer.flush();
            }
        });

        // Reader task: PTY output → screen + event channel + review pattern detection
        let screen_clone = Arc::clone(&screen);
        let event_tx = self.event_tx.clone();
        let agent_id = id.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            // Ring buffer of recent text for pattern matching
            let mut recent = String::new();
            loop {
                match pty_reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = event_tx.send(AgentEvent::Exit { id: agent_id, code: 0 });
                        break;
                    }
                    Ok(n) => {
                        let chunk = &buf[..n];
                        screen_clone.lock().unwrap().process(chunk);

                        // Track recent text for review pattern detection
                        if let Ok(text) = std::str::from_utf8(chunk) {
                            recent.push_str(text);
                            if recent.len() > 2000 {
                                recent = recent[recent.len() - 2000..].to_string();
                            }
                        }

                        let needs_review = REVIEW_PATTERNS.iter().any(|p| recent.contains(p));
                        let _ = event_tx.send(AgentEvent::Data {
                            id: agent_id.clone(),
                            needs_review,
                        });
                    }
                }
            }
        });

        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let agent = Agent {
            id: id.clone(),
            project_name: project_name.to_string(),
            command: command.to_string(),
            description: if description.is_empty() {
                format!("{command} session")
            } else {
                description.to_string()
            },
            status: AgentStatus::Running,
            started_at,
            output: Vec::new(),
            input_tx,
            screen,
            cols,
            rows,
        };

        self.agents.insert(id.clone(), agent);
        Ok(id)
    }

    pub fn write(&self, id: &str, data: Vec<u8>) {
        if let Some(agent) = self.agents.get(id) {
            let _ = agent.input_tx.send(data);
        }
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) {
        if let Some(agent) = self.agents.get_mut(id) {
            agent.cols = cols;
            agent.rows = rows;
            agent.screen.lock().unwrap().set_size(rows, cols);
        }
    }

    pub fn get(&self, id: &str) -> Option<&Agent> {
        self.agents.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Agent> {
        self.agents.get_mut(id)
    }

    pub fn list_for_project(&self, project_name: &str) -> Vec<&Agent> {
        self.agents
            .values()
            .filter(|a| a.project_name == project_name)
            .collect()
    }

    pub fn kill(&mut self, id: &str) {
        self.agents.remove(id);
    }

    pub fn kill_project_agents(&mut self, project_name: &str) {
        self.agents.retain(|_, a| a.project_name != project_name);
    }

    pub fn all_ids(&self) -> Vec<String> {
        self.agents.keys().cloned().collect()
    }

    /// Kill all agents — used on app exit.
    /// Dropping input_tx causes the PTY writer task to exit.
    /// The PTY reader (spawn_blocking) will be abandoned — caller must process::exit.
    pub fn kill_all(&mut self) {
        self.agents.clear();
    }
}
