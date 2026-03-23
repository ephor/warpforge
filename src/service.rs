use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::ports;

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum ServiceStatus {
    Starting,
    Running,
    Stopped,
    Failed,
}

impl std::fmt::Display for ServiceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceStatus::Starting => write!(f, "starting"),
            ServiceStatus::Running => write!(f, "running"),
            ServiceStatus::Stopped => write!(f, "stopped"),
            ServiceStatus::Failed => write!(f, "failed"),
        }
    }
}

#[allow(dead_code)]
pub struct ManagedService {
    pub name: String,
    pub project_name: String,
    pub command: String,
    pub status: ServiceStatus,
    pub logs: Vec<String>,
    /// Port declared in .workspace.yaml (0 = none)
    pub original_port: u16,
    /// Actual port the process is listening on (allocated from range)
    pub allocated_port: u16,
    /// Process-group ID — used to kill the entire tree (sh → npm → node)
    pgid: Option<u32>,
    child: Option<Child>,
}

pub enum ServiceEvent {
    Log { key: String, line: String },
    StatusChange { key: String, status: ServiceStatus },
}

/// Kill the entire process group so that sh→npm→node (etc.) all die together.
async fn kill_group(pgid: Option<u32>) {
    #[cfg(unix)]
    if let Some(id) = pgid {
        // `kill -9 -<pgid>` sends SIGKILL to every process in the group
        tokio::process::Command::new("kill")
            .args(["-9", &format!("-{id}")])
            .output()
            .await
            .ok();
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

pub struct ServiceManager {
    services: HashMap<String, ManagedService>,
    pub event_tx: mpsc::UnboundedSender<ServiceEvent>,
}

#[allow(dead_code)]
impl ServiceManager {
    pub fn new(event_tx: mpsc::UnboundedSender<ServiceEvent>) -> Self {
        Self {
            services: HashMap::new(),
            event_tx,
        }
    }

    pub async fn start(
        &mut self,
        project_name: &str,
        project_path: &str,
        project_index: usize,
        service_name: &str,
        command: &str,
        original_port: u16,
        env: Option<&HashMap<String, String>>,
        ready_pattern: Option<&str>,
    ) -> Result<()> {
        let key = format!("{project_name}/{service_name}");
        // Already running — skip. Stopped/Failed — allow restart.
        if self.services.contains_key(&key) {
            let running = matches!(
                self.services[&key].status,
                ServiceStatus::Running | ServiceStatus::Starting
            );
            if running { return Ok(()); }
            // Kill old child and wait for it to fully exit before reallocating port
            let (old_pgid, old_child) = self.services.get_mut(&key)
                .map(|s| (s.pgid.take(), s.child.take()))
                .unwrap_or((None, None));
            kill_group(old_pgid).await;
            if let Some(mut child) = old_child {
                child.kill().await.ok();
                child.wait().await.ok();
            }
            ports::release(project_name, service_name);
        }

        // Allocate a port from this project's range
        let allocated_port = if original_port > 0 {
            ports::allocate(project_index, project_name, service_name, original_port)
                .unwrap_or(original_port)
        } else {
            0
        };

        // Build env: interpolate ${svc.port} refs + inject PORT
        let mut port_map: HashMap<String, u16> = self
            .services
            .values()
            .filter(|s| s.project_name == project_name && s.allocated_port > 0)
            .map(|s| (s.name.clone(), s.allocated_port))
            .collect();
        if allocated_port > 0 {
            port_map.insert(service_name.to_string(), allocated_port);
        }

        let mut cmd = Command::new("sh");
        cmd.args(["-c", command])
            .current_dir(project_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Own process group so we can kill the entire subtree at once
        #[cfg(unix)]
        cmd.process_group(0);

        if allocated_port > 0 {
            cmd.env("PORT", allocated_port.to_string());
        }

        if let Some(env_vars) = env {
            let interpolated = ports::interpolate_env(env_vars, &port_map);
            for (k, v) in &interpolated {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn()?;
        // Capture PGID right after spawn (== child PID when process_group(0) is used)
        #[cfg(unix)]
        let pgid: Option<u32> = child.id();
        #[cfg(not(unix))]
        let pgid: Option<u32> = None;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Stream stdout
        if let Some(stdout) = stdout {
            let tx = self.event_tx.clone();
            let k = key.clone();
            let pattern = ready_pattern.map(|s| s.to_string());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(ref pat) = pattern {
                        if line.contains(pat.as_str()) {
                            let _ = tx.send(ServiceEvent::StatusChange {
                                key: k.clone(),
                                status: ServiceStatus::Running,
                            });
                        }
                    }
                    let _ = tx.send(ServiceEvent::Log { key: k.clone(), line });
                }
            });
        }

        // Stream stderr
        if let Some(stderr) = stderr {
            let tx = self.event_tx.clone();
            let k = key.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(ServiceEvent::Log {
                        key: k.clone(),
                        line: format!("[err] {line}"),
                    });
                }
            });
        }

        // Monitor exit
        let tx = self.event_tx.clone();
        let k = key.clone();
        let pid = child.id();
        tokio::spawn(async move {
            // We can't use child here since it's moved; the kill_on_drop handles cleanup.
            // For exit monitoring, rely on log stream EOF as proxy.
            let _ = tx;
            let _ = k;
            let _ = pid;
        });

        // Preserve existing logs on restart
        let existing_logs = self.services.get(&key)
            .map(|s| s.logs.clone())
            .unwrap_or_default();

        let managed = ManagedService {
            name: service_name.to_string(),
            project_name: project_name.to_string(),
            command: command.to_string(),
            status: ServiceStatus::Starting,
            logs: existing_logs,
            original_port,
            allocated_port,
            pgid,
            child: Some(child),
        };

        self.services.insert(key, managed);
        Ok(())
    }

    pub async fn stop(&mut self, project_name: &str, service_name: &str) -> Result<()> {
        let key = format!("{project_name}/{service_name}");
        if let Some(svc) = self.services.get_mut(&key) {
            let pgid = svc.pgid.take();
            kill_group(pgid).await;
            if let Some(mut child) = svc.child.take() {
                child.kill().await.ok();
                child.wait().await.ok();
            }
            svc.status = ServiceStatus::Stopped;
        }
        ports::release(project_name, service_name);
        Ok(())
    }

    pub async fn stop_project(&mut self, project_name: &str) -> Result<()> {
        let keys: Vec<String> = self
            .services
            .keys()
            .filter(|k| k.starts_with(&format!("{project_name}/")))
            .cloned()
            .collect();
        for key in keys {
            if let Some(svc) = self.services.get_mut(&key) {
                let pgid = svc.pgid.take();
                kill_group(pgid).await;
                if let Some(mut child) = svc.child.take() {
                    child.kill().await.ok();
                    child.wait().await.ok();
                }
                svc.status = ServiceStatus::Stopped;
            }
        }
        ports::release_project(project_name);
        Ok(())
    }

    /// Kill every service across all projects — used on app exit.
    pub async fn stop_all(&mut self) -> Result<()> {
        let keys: Vec<String> = self.services.keys().cloned().collect();
        for key in keys {
            if let Some(svc) = self.services.get_mut(&key) {
                let pgid = svc.pgid.take();
                kill_group(pgid).await;
                if let Some(mut child) = svc.child.take() {
                    child.kill().await.ok();
                    child.wait().await.ok();
                }
                svc.status = ServiceStatus::Stopped;
            }
        }
        Ok(())
    }

    pub fn get(&self, project_name: &str, service_name: &str) -> Option<&ManagedService> {
        self.services.get(&format!("{project_name}/{service_name}"))
    }

    pub fn get_mut(&mut self, project_name: &str, service_name: &str) -> Option<&mut ManagedService> {
        self.services.get_mut(&format!("{project_name}/{service_name}"))
    }

    pub fn list_for_project(&self, project_name: &str) -> Vec<&ManagedService> {
        self.services
            .values()
            .filter(|s| s.project_name == project_name)
            .collect()
    }

    pub fn apply_event(&mut self, event: ServiceEvent) {
        match event {
            ServiceEvent::Log { key, line } => {
                if let Some(svc) = self.services.get_mut(&key) {
                    svc.logs.push(line);
                    if svc.logs.len() > 2000 {
                        svc.logs.drain(..svc.logs.len() - 2000);
                    }
                }
            }
            ServiceEvent::StatusChange { key, status } => {
                if let Some(svc) = self.services.get_mut(&key) {
                    svc.status = status;
                }
            }
        }
    }
}
