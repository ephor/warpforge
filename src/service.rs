use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

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
    /// Monotonic run identifier. Async log/status tasks include this so late
    /// events from an older process cannot overwrite a newer restart.
    run_id: u64,
    /// Set true when we're deliberately stopping, so the exit waiter can tell
    /// an intentional stop from a crash and report the right status.
    stopping: Arc<AtomicBool>,
}

pub enum ServiceEvent {
    Log {
        key: String,
        run_id: u64,
        line: String,
    },
    StatusChange {
        key: String,
        run_id: u64,
        status: ServiceStatus,
    },
}

fn line_indicates_ready(line: &str, ready_pattern: Option<&str>) -> bool {
    if ready_pattern.is_some_and(|pat| line.contains(pat)) {
        return true;
    }
    let lower = line.to_ascii_lowercase();
    lower.contains("ready in")
        || lower.contains("listening on")
        || lower.contains("server running")
        || lower.contains("started server")
        || lower.contains("local:")
        || lower.contains("localhost:")
        || lower.contains("0.0.0.0:")
}

fn spawn_port_ready_probe(
    tx: mpsc::UnboundedSender<ServiceEvent>,
    key: String,
    run_id: u64,
    port: u16,
    stopping: Arc<AtomicBool>,
) {
    if port == 0 {
        return;
    }
    tokio::spawn(async move {
        for _ in 0..600 {
            if stopping.load(Ordering::SeqCst) {
                return;
            }
            let addr = ("127.0.0.1", port);
            if matches!(
                timeout(Duration::from_millis(250), TcpStream::connect(addr)).await,
                Ok(Ok(_))
            ) {
                let _ = tx.send(ServiceEvent::StatusChange {
                    key,
                    run_id,
                    status: ServiceStatus::Running,
                });
                return;
            }
            sleep(Duration::from_millis(500)).await;
        }
    });
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

/// Last-resort cleanup for orphan dev servers from an older daemon process.
///
/// Managed services are stopped through their process groups. This fallback is
/// intentionally narrower: it only kills processes currently listening inside
/// Warpforge-owned project port ranges, and only the listener PID. That frees
/// the port without risking an accidental group kill of a user's shell.
pub async fn kill_listeners_in_ranges(ranges: &[(u16, u16)]) {
    #[cfg(unix)]
    {
        for &(start, end) in ranges {
            kill_listeners_in_range(start, end, "TERM").await;
        }
        sleep(Duration::from_millis(600)).await;
        for &(start, end) in ranges {
            kill_listeners_in_range(start, end, "KILL").await;
        }
    }

    #[cfg(not(unix))]
    let _ = ranges;
}

#[cfg(unix)]
async fn kill_listeners_in_range(start: u16, end: u16, signal: &str) {
    let spec = format!("-iTCP:{start}-{end}");
    let Ok(output) = Command::new("lsof")
        .args(["-nP", "-t", &spec, "-sTCP:LISTEN"])
        .output()
        .await
    else {
        return;
    };

    if !output.status.success() {
        return;
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let pid = line.trim();
        if pid.is_empty() || pid == std::process::id().to_string() {
            continue;
        }
        let _ = Command::new("kill")
            .args([format!("-{signal}"), pid.to_string()])
            .output()
            .await;
    }
}

pub struct ServiceManager {
    services: HashMap<String, ManagedService>,
    pub event_tx: mpsc::UnboundedSender<ServiceEvent>,
    next_run_id: u64,
}

#[allow(dead_code)]
impl ServiceManager {
    pub fn new(event_tx: mpsc::UnboundedSender<ServiceEvent>) -> Self {
        Self {
            services: HashMap::new(),
            event_tx,
            next_run_id: 1,
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
        let stopping = Arc::new(AtomicBool::new(false));
        let run_id = self.next_run_id;
        self.next_run_id = self.next_run_id.saturating_add(1);

        // Preserve existing logs on restart
        let existing_logs = self
            .services
            .get(&key)
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
            run_id,
            stopping: Arc::clone(&stopping),
        };

        self.services.insert(key.clone(), managed);

        spawn_port_ready_probe(
            self.event_tx.clone(),
            key.clone(),
            run_id,
            allocated_port,
            Arc::clone(&stopping),
        );

        // Stream stdout
        if let Some(stdout) = stdout {
            let tx = self.event_tx.clone();
            let k = key.clone();
            let rid = run_id;
            let pattern = ready_pattern.map(|s| s.to_string());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line_indicates_ready(&line, pattern.as_deref()) {
                        let _ = tx.send(ServiceEvent::StatusChange {
                            key: k.clone(),
                            run_id: rid,
                            status: ServiceStatus::Running,
                        });
                    }
                    let _ = tx.send(ServiceEvent::Log {
                        key: k.clone(),
                        run_id: rid,
                        line,
                    });
                }
            });
        }

        // Stream stderr — also check readyPattern here since many dev servers
        // (bun, vite, etc.) write their "ready" message to stderr, not stdout.
        if let Some(stderr) = stderr {
            let tx = self.event_tx.clone();
            let k = key.clone();
            let rid = run_id;
            let pattern = ready_pattern.map(|s| s.to_string());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line_indicates_ready(&line, pattern.as_deref()) {
                        let _ = tx.send(ServiceEvent::StatusChange {
                            key: k.clone(),
                            run_id: rid,
                            status: ServiceStatus::Running,
                        });
                    }
                    let _ = tx.send(ServiceEvent::Log {
                        key: k.clone(),
                        run_id: rid,
                        line: format!("[err] {line}"),
                    });
                }
            });
        }

        // Exit waiter — actually detects the process ending (previously a no-op,
        // so a crashed service showed "running" forever). Reports Stopped for an
        // intentional stop, Failed for an unexpected exit.
        {
            let tx = self.event_tx.clone();
            let k = key.clone();
            let rid = run_id;
            let flag = Arc::clone(&stopping);
            tokio::spawn(async move {
                let result = child.wait().await;
                let clean_exit = result.map(|s| s.success()).unwrap_or(false);
                let status = if flag.load(Ordering::SeqCst) || clean_exit {
                    ServiceStatus::Stopped
                } else {
                    ServiceStatus::Failed
                };
                let _ = tx.send(ServiceEvent::StatusChange {
                    key: k,
                    run_id: rid,
                    status,
                });
            });
        }
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
        let mut projects: Vec<String> = self
            .services
            .values()
            .map(|svc| svc.project_name.clone())
            .collect();
        projects.sort();
        projects.dedup();
        let keys: Vec<String> = self.services.keys().cloned().collect();
        for key in keys {
            self.stop_key(&key).await;
        }
        for project in projects {
            ports::release_project(&project);
        }
        Ok(())
    }

    pub fn get(&self, project_name: &str, service_name: &str) -> Option<&ManagedService> {
        self.services.get(&format!("{project_name}/{service_name}"))
    }

    pub fn get_mut(
        &mut self,
        project_name: &str,
        service_name: &str,
    ) -> Option<&mut ManagedService> {
        self.services
            .get_mut(&format!("{project_name}/{service_name}"))
    }

    pub fn list_for_project(&self, project_name: &str) -> Vec<&ManagedService> {
        self.services
            .values()
            .filter(|s| s.project_name == project_name)
            .collect()
    }

    pub fn list(&self) -> Vec<&ManagedService> {
        self.services.values().collect()
    }

    /// Every managed service across all projects (for snapshot building).
    pub fn all(&self) -> impl Iterator<Item = &ManagedService> {
        self.services.values()
    }

    pub fn apply_event(&mut self, event: ServiceEvent) {
        match event {
            ServiceEvent::Log { key, run_id, line } => {
                if let Some(svc) = self.services.get_mut(&key) {
                    if svc.run_id != run_id {
                        return;
                    }
                    svc.logs.push(line);
                    if svc.logs.len() > 2000 {
                        svc.logs.drain(..svc.logs.len() - 2000);
                    }
                }
            }
            ServiceEvent::StatusChange {
                key,
                run_id,
                status,
            } => {
                if let Some(svc) = self.services.get_mut(&key) {
                    if svc.run_id != run_id {
                        return;
                    }
                    // A late "ready" line must not resurrect a stopped service.
                    if svc.status == ServiceStatus::Stopped && status == ServiceStatus::Running {
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
            if let ServiceEvent::StatusChange {
                status: ServiceStatus::Failed,
                ..
            } = ev
            {
                saw_failed = true;
                break;
            }
        }
        assert!(
            saw_failed,
            "expected a Failed status change for a crashed service"
        );
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
                assert_ne!(
                    *status,
                    ServiceStatus::Failed,
                    "clean exit must not be Failed"
                );
                if *status == ServiceStatus::Stopped {
                    saw_stopped = true;
                    break;
                }
            }
        }
        assert!(
            saw_stopped,
            "expected a Stopped status change for a clean exit"
        );
    }

    /// Readiness must not depend on framework-specific log text. If a declared
    /// service port starts accepting TCP connections, the service is running.
    #[tokio::test]
    async fn open_port_reports_running_without_logs() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        spawn_port_ready_probe(
            tx,
            "p/web".to_string(),
            1,
            port,
            Arc::new(AtomicBool::new(false)),
        );

        let mut saw_running = false;
        while let Ok(Some(ev)) = timeout(Duration::from_secs(5), rx.recv()).await {
            if let ServiceEvent::StatusChange {
                status: ServiceStatus::Running,
                ..
            } = ev
            {
                saw_running = true;
                break;
            }
        }
        assert!(
            saw_running,
            "expected a Running status change for an open port"
        );
    }

    #[test]
    fn stale_run_events_do_not_overwrite_current_service() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut mgr = ServiceManager::new(tx);
        let key = "p/web".to_string();
        mgr.services.insert(
            key.clone(),
            ManagedService {
                name: "web".into(),
                project_name: "p".into(),
                command: "dev".into(),
                status: ServiceStatus::Starting,
                logs: Vec::new(),
                original_port: 4000,
                allocated_port: 4000,
                pgid: None,
                run_id: 2,
                stopping: Arc::new(AtomicBool::new(false)),
            },
        );

        mgr.apply_event(ServiceEvent::StatusChange {
            key: key.clone(),
            run_id: 1,
            status: ServiceStatus::Stopped,
        });
        mgr.apply_event(ServiceEvent::Log {
            key: key.clone(),
            run_id: 1,
            line: "old process noise".into(),
        });

        let svc = mgr.services.get(&key).unwrap();
        assert_eq!(svc.status, ServiceStatus::Starting);
        assert!(svc.logs.is_empty());

        mgr.apply_event(ServiceEvent::StatusChange {
            key: key.clone(),
            run_id: 2,
            status: ServiceStatus::Running,
        });
        assert_eq!(
            mgr.services.get(&key).unwrap().status,
            ServiceStatus::Running
        );
    }
}
