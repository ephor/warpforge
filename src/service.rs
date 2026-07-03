use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
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
    /// Set true when we're deliberately stopping, so the exit waiter can tell
    /// an intentional stop from a crash and report the right status.
    stopping: Arc<AtomicBool>,
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

    #[allow(clippy::too_many_arguments)]
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
        if let Some(existing) = self.services.get(&key) {
            let running = matches!(
                existing.status,
                ServiceStatus::Running | ServiceStatus::Starting
            );
            if running {
                return Ok(());
            }
            // Ensure any lingering old process group is gone before reallocating.
            existing.stopping.store(true, Ordering::SeqCst);
            let old_pgid = existing.pgid;
            kill_group(old_pgid).await;
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

        // Stream stderr — also check readyPattern here since many dev servers
        // (bun, vite, etc.) write their "ready" message to stderr, not stdout.
        if let Some(stderr) = stderr {
            let tx = self.event_tx.clone();
            let k = key.clone();
            let pattern = ready_pattern.map(|s| s.to_string());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(ref pat) = pattern {
                        if line.contains(pat.as_str()) {
                            let _ = tx.send(ServiceEvent::StatusChange {
                                key: k.clone(),
                                status: ServiceStatus::Running,
                            });
                        }
                    }
                    let _ = tx.send(ServiceEvent::Log {
                        key: k.clone(),
                        line: format!("[err] {line}"),
                    });
                }
            });
        }

        // Exit waiter — actually detects the process ending (previously a no-op,
        // so a crashed service showed "running" forever). Reports Stopped for an
        // intentional stop, Failed for an unexpected exit.
        let stopping = Arc::new(AtomicBool::new(false));
        {
            let tx = self.event_tx.clone();
            let k = key.clone();
            let flag = Arc::clone(&stopping);
            tokio::spawn(async move {
                let result = child.wait().await;
                let clean_exit = result.map(|s| s.success()).unwrap_or(false);
                let status = if flag.load(Ordering::SeqCst) || clean_exit {
                    ServiceStatus::Stopped
                } else {
                    ServiceStatus::Failed
                };
                let _ = tx.send(ServiceEvent::StatusChange { key: k, status });
            });
        }

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
            stopping,
        };

        self.services.insert(key, managed);
        Ok(())
    }

    async fn stop_key(&mut self, key: &str) {
        if let Some(svc) = self.services.get_mut(key) {
            svc.stopping.store(true, Ordering::SeqCst);
            let pgid = svc.pgid.take();
            kill_group(pgid).await;
            svc.status = ServiceStatus::Stopped;
        }
    }

    pub async fn stop(&mut self, project_name: &str, service_name: &str) -> Result<()> {
        let key = format!("{project_name}/{service_name}");
        self.stop_key(&key).await;
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
            self.stop_key(&key).await;
        }
        ports::release_project(project_name);
        Ok(())
    }

    /// Kill every service across all projects — used on app exit.
    pub async fn stop_all(&mut self) -> Result<()> {
        let keys: Vec<String> = self.services.keys().cloned().collect();
        for key in keys {
            self.stop_key(&key).await;
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

    /// Every managed service across all projects (for snapshot building).
    pub fn all(&self) -> impl Iterator<Item = &ManagedService> {
        self.services.values()
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
                    // A late "ready" line must not resurrect a stopped service.
                    if svc.status == ServiceStatus::Stopped
                        && status == ServiceStatus::Running
                    {
                        return;
                    }
                    svc.status = status;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    /// A service whose process exits non-zero must be detected and reported as
    /// Failed — previously the exit monitor was a no-op and it stayed "running".
    #[tokio::test]
    async fn crashed_service_reports_failed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut mgr = ServiceManager::new(tx);
        mgr.start("p", ".", 0, "boom", "exit 7", 0, None, None)
            .await
            .unwrap();

        let mut saw_failed = false;
        while let Ok(Some(ev)) = timeout(Duration::from_secs(5), rx.recv()).await {
            if let ServiceEvent::StatusChange { status: ServiceStatus::Failed, .. } = ev {
                saw_failed = true;
                break;
            }
        }
        assert!(saw_failed, "expected a Failed status change for a crashed service");
    }

    /// A clean exit (or an intentional stop) reports Stopped, not Failed.
    #[tokio::test]
    async fn clean_exit_reports_stopped() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut mgr = ServiceManager::new(tx);
        mgr.start("p", ".", 0, "ok", "true", 0, None, None)
            .await
            .unwrap();

        let mut saw_stopped = false;
        while let Ok(Some(ev)) = timeout(Duration::from_secs(5), rx.recv()).await {
            if let ServiceEvent::StatusChange { status, .. } = &ev {
                assert_ne!(*status, ServiceStatus::Failed, "clean exit must not be Failed");
                if *status == ServiceStatus::Stopped {
                    saw_stopped = true;
                    break;
                }
            }
        }
        assert!(saw_stopped, "expected a Stopped status change for a clean exit");
    }
}
