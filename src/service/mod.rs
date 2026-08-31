use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

use crate::ports;

/// A single retained log line with a monotonic per-service sequence number and
/// the wall-clock time (epoch millis) it was captured. Sequence numbers let
/// clients read "everything after cursor X" cheaply and never lose/gain lines
/// as the ring buffer drops old entries; timestamps let tooling show age.
#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    pub seq: u64,
    pub at_ms: u64,
    pub line: String,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
    pub logs: Vec<LogLine>,
    /// Sequence number for the next appended log line (monotonic, never reused,
    /// even across restarts). Log `seq` values are assigned from this.
    pub next_seq: u64,
    /// Port declared in .warpforge.yaml (0 = none)
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
        /// Exit code from a stopped/crashed process, when known (None for a
        /// signal kill). Drives the `[service failed: exit code=N]` marker.
        exit_code: Option<i32>,
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
                    exit_code: None,
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

/// Kill whatever listens on exactly these ports.
///
/// Unlike [`kill_listeners_in_ranges`] this touches only ports the caller knows
/// warpforge allocated, so it can never reach a process warpforge did not
/// start.
pub async fn kill_listeners_on_ports(ports: &[u16]) {
    #[cfg(unix)]
    {
        if ports.is_empty() {
            return;
        }
        for &port in ports {
            kill_listeners_in_range(port, port, "TERM").await;
        }
        sleep(Duration::from_millis(600)).await;
        for &port in ports {
            kill_listeners_in_range(port, port, "KILL").await;
        }
    }

    #[cfg(not(unix))]
    let _ = ports;
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

impl ManagedService {
    /// Append a retained line (assigning its seq + timestamp) and trim the ring.
    pub fn push_log(&mut self, line: String) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        self.logs.push(LogLine {
            seq,
            at_ms: now_ms(),
            line,
        });
        if self.logs.len() > 2000 {
            self.logs.drain(..self.logs.len() - 2000);
        }
    }

    /// Slice the ring by seq cursor and cap to `limit`; returns raw lines, their
    /// timestamps (millis, index-aligned), and the cursor to pass back as `after`.
    /// `after` is inclusive ("start from this seq"), so `0` returns the oldest
    /// retained line and polling with the returned cursor returns only newer ones.
    pub fn window(&self, after: u64, limit: Option<u32>) -> (Vec<String>, Vec<u64>, u64) {
        let mut lines: Vec<&LogLine> = self.logs.iter().filter(|l| l.seq >= after).collect();
        if let Some(n) = limit {
            let n = n as usize;
            if lines.len() > n {
                lines = lines.split_off(lines.len() - n);
            }
        }
        let (text, at): (Vec<String>, Vec<u64>) =
            lines.iter().map(|l| (l.line.clone(), l.at_ms)).unzip();
        (text, at, self.next_seq)
    }
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
        let next_seq = existing_logs
            .last()
            .map(|l| l.seq.saturating_add(1))
            .unwrap_or(0);

        let managed = ManagedService {
            name: service_name.to_string(),
            project_name: project_name.to_string(),
            command: command.to_string(),
            status: ServiceStatus::Starting,
            logs: existing_logs,
            next_seq,
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
                            exit_code: None,
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
                            exit_code: None,
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
                let exit_code = result.as_ref().ok().and_then(|s| s.code());
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
                    exit_code,
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

    /// Stop and forget a service that is no longer declared in project config.
    pub async fn remove(&mut self, project_name: &str, service_name: &str) -> Result<()> {
        let key = format!("{project_name}/{service_name}");
        self.stop_key(&key).await;
        self.services.remove(&key);
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

    /// A window of a service's retained logs: every line with `seq > after`,
    /// trimmed to the last `limit` lines when a limit is given. Returns the raw
    /// lines, their capture timestamps (millis, index-aligned), and the cursor
    /// (`next_seq`) to pass back as `after` to poll for new lines. `after=0`
    /// returns the full buffer — with no limit, that is everything retained.
    pub fn log_window(
        &self,
        project_name: &str,
        service_name: &str,
        after: u64,
        limit: Option<u32>,
    ) -> (Vec<String>, Vec<u64>, u64) {
        let Some(svc) = self.get(project_name, service_name) else {
            return (Vec::new(), Vec::new(), 0);
        };
        svc.window(after, limit)
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
                    svc.push_log(line);
                }
            }
            ServiceEvent::StatusChange {
                key,
                run_id,
                status,
                exit_code,
            } => {
                if let Some(svc) = self.services.get_mut(&key) {
                    if svc.run_id != run_id {
                        return;
                    }
                    // A late "ready" line must not resurrect a stopped service.
                    if svc.status == ServiceStatus::Stopped && status == ServiceStatus::Running {
                        return;
                    }
                    let old = svc.status.clone();
                    svc.status = status;
                    if old != svc.status {
                        svc.push_log(match svc.status {
                            ServiceStatus::Running => "[service running]".to_string(),
                            ServiceStatus::Stopped => "[service stopped]".to_string(),
                            ServiceStatus::Failed => match exit_code {
                                Some(code) => format!("[service failed: exit code={code}]"),
                                None => "[service failed]".to_string(),
                            },
                            ServiceStatus::Starting => "[service starting]".to_string(),
                        });
                    }
                }
            }
        }
    }

    /// The sequence number of the newest retained line (0 when empty). Used to
    /// expose a monotonic log cursor in runtime listings.
    pub fn newest_seq(&self, project_name: &str, service_name: &str) -> u64 {
        self.get(project_name, service_name)
            .map(|s| s.next_seq.saturating_sub(1))
            .unwrap_or(0)
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
                next_seq: 0,
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
            exit_code: None,
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
            exit_code: None,
        });
        assert_eq!(
            mgr.services.get(&key).unwrap().status,
            ServiceStatus::Running
        );
    }

    /// Seq cursor semantics + lifecycle markers: a status change injects a
    /// marker into the log stream, sequences stay monotonic, and `log_window`
    /// returns only lines newer than the cursor plus the next cursor to poll.
    #[test]
    fn log_window_cursor_and_lifecycle_markers() {
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
                next_seq: 0,
                original_port: 4000,
                allocated_port: 4000,
                pgid: None,
                run_id: 1,
                stopping: Arc::new(AtomicBool::new(false)),
            },
        );

        mgr.apply_event(ServiceEvent::Log {
            key: key.clone(),
            run_id: 1,
            line: "boot".into(),
        });
        mgr.apply_event(ServiceEvent::StatusChange {
            key: key.clone(),
            run_id: 1,
            status: ServiceStatus::Running,
            exit_code: None,
        });
        mgr.apply_event(ServiceEvent::StatusChange {
            key: key.clone(),
            run_id: 1,
            status: ServiceStatus::Failed,
            exit_code: Some(7),
        });

        let svc = mgr.get("p", "web").unwrap();
        let (all, at, cursor) = svc.window(0, None);
        assert_eq!(
            all,
            vec!["boot", "[service running]", "[service failed: exit code=7]"]
        );
        assert_eq!(at.len(), 3, "timestamps must align with lines");
        assert_eq!(cursor, 3, "three lines => next seq 3");

        // Cursor reads only what is newer than it; a limit tails to the newest.
        let (newer, _, _) = svc.window(1, None);
        assert_eq!(
            newer,
            vec!["[service running]", "[service failed: exit code=7]"]
        );
        let (tail, _, _) = svc.window(0, Some(2));
        assert_eq!(
            tail,
            vec!["[service running]", "[service failed: exit code=7]"]
        );

        // Snapshot-visible newest_seq.
        assert_eq!(mgr.newest_seq("p", "web"), 2);
    }
}
