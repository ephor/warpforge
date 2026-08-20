use futures::FutureExt;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};

use crate::config::PortForwardConfig;
use crate::service::{now_ms, LogLine};

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum PfStatus {
    Starting,
    Active,
    Restarting,
    Failed,
    Stopped,
}

impl std::fmt::Display for PfStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PfStatus::Starting => write!(f, "starting"),
            PfStatus::Active => write!(f, "active"),
            PfStatus::Restarting => write!(f, "restarting"),
            PfStatus::Failed => write!(f, "failed"),
            PfStatus::Stopped => write!(f, "stopped"),
        }
    }
}

/// Port-forward watcher events. Every variant carries `project` so events can
/// be attributed correctly regardless of which project a client happens to be
/// viewing — the daemon has many simultaneous observers, so "the active
/// project" is not a safe key. (Audit fix: previously attribution was done by
/// the TUI against whatever screen was open, dropping events on the dashboard
/// and misattributing them across project switches.)
#[derive(Debug, Clone)]
pub enum PfEvent {
    Active {
        project: String,
        name: String,
        local_port: u16,
    },
    Restarted {
        project: String,
        name: String,
        local_port: u16,
    },
    Failed {
        project: String,
        name: String,
        local_port: u16,
    },
    Log {
        project: String,
        name: String,
        line: String,
    },
}

impl PfEvent {
    pub fn project(&self) -> &str {
        match self {
            PfEvent::Active { project, .. }
            | PfEvent::Restarted { project, .. }
            | PfEvent::Failed { project, .. }
            | PfEvent::Log { project, .. } => project,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            PfEvent::Active { name, .. }
            | PfEvent::Restarted { name, .. }
            | PfEvent::Failed { name, .. }
            | PfEvent::Log { name, .. } => name,
        }
    }
}

pub struct ManagedPortForward {
    pub name: String,
    #[allow(dead_code)]
    pub namespace: String,
    #[allow(dead_code)]
    pub pod_prefix: String,
    pub local_port: u16,
    #[allow(dead_code)]
    pub remote_port: u16,
    pub status: PfStatus,
    pub last_event: Option<String>,
    /// Captured kubectl stdout + stderr + internal diagnostics
    pub logs: Vec<LogLine>,
    /// Sequence number for the next appended log line (see `service::LogLine`).
    pub next_seq: u64,
    /// Notifying this asks the watcher task to kill its kubectl child and exit
    /// — scoped teardown, so we never `pkill` port-forwards we didn't start.
    stop: Arc<Notify>,
}

impl ManagedPortForward {
    /// Append a retained line (assigning its seq + timestamp) and trim the ring.
    fn push_log(&mut self, line: String) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        self.logs.push(LogLine {
            seq,
            at_ms: now_ms(),
            line,
        });
        if self.logs.len() > 500 {
            self.logs.drain(..self.logs.len() - 500);
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

pub struct PortForwardManager {
    pub forwards: HashMap<String, ManagedPortForward>,
    pub event_tx: mpsc::UnboundedSender<PfEvent>,
}

impl PortForwardManager {
    pub fn new(event_tx: mpsc::UnboundedSender<PfEvent>) -> Self {
        Self {
            forwards: HashMap::new(),
            event_tx,
        }
    }

    pub async fn start_all(&mut self, project_name: &str, configs: &[PortForwardConfig]) {
        for cfg in configs {
            let label = cfg
                .name
                .clone()
                .unwrap_or_else(|| format!("{}:{}", cfg.namespace, cfg.pod));
            let key = format!("{}/{}", project_name, label);

            if let Some(pf) = self.forwards.get(&key) {
                if matches!(
                    pf.status,
                    PfStatus::Active | PfStatus::Starting | PfStatus::Restarting
                ) {
                    continue;
                }
            }

            let stop = Arc::new(Notify::new());
            self.forwards.insert(
                key.clone(),
                ManagedPortForward {
                    name: label.clone(),
                    namespace: cfg.namespace.clone(),
                    pod_prefix: cfg.pod.clone(),
                    local_port: cfg.local_port,
                    remote_port: cfg.remote_port,
                    status: PfStatus::Starting,
                    last_event: None,
                    logs: vec![LogLine {
                        seq: 0,
                        at_ms: now_ms(),
                        line: format!(
                            "Starting port-forward {}:{} → {}:{} ...",
                            cfg.namespace, cfg.pod, cfg.local_port, cfg.remote_port
                        ),
                    }],
                    next_seq: 1,
                    stop: Arc::clone(&stop),
                },
            );

            let project = project_name.to_string();
            let namespace = cfg.namespace.clone();
            let pod_prefix = cfg.pod.clone();
            let local_port = cfg.local_port;
            let remote_port = cfg.remote_port;
            let event_tx = self.event_tx.clone();
            let name_clone = label.clone();

            tokio::spawn(async move {
                watch_portforward(
                    project,
                    name_clone,
                    namespace,
                    pod_prefix,
                    local_port,
                    remote_port,
                    event_tx,
                    stop,
                )
                .await;
            });
        }
    }

    pub fn apply_event(&mut self, event: PfEvent) {
        let key = format!("{}/{}", event.project(), event.name());
        match &event {
            PfEvent::Log { line, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.push_log(line.clone());
                }
            }
            PfEvent::Active { local_port, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Active;
                    pf.push_log(format!("✓ Forwarding :{local_port}"));
                }
            }
            PfEvent::Restarted { local_port, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Active;
                    pf.last_event = Some(format!("⟳ restarted :{local_port}"));
                    pf.push_log(format!("⟳ Restarted port-forward :{local_port}"));
                }
            }
            PfEvent::Failed { local_port, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Failed;
                    pf.last_event = Some(format!("✗ failed :{local_port}"));
                    pf.push_log(format!(
                        "✗ Port-forward :{local_port} gave up after max retries"
                    ));
                }
            }
        }
    }

    /// A window of a port-forward's retained logs (see `service::LogLine` and
    /// `ManagedPortForward::window` for cursor semantics).
    pub fn log_window(
        &self,
        project_name: &str,
        name: &str,
        after: u64,
        limit: Option<u32>,
    ) -> (Vec<String>, Vec<u64>, u64) {
        let key = format!("{project_name}/{name}");
        self.forwards
            .get(&key)
            .map(|pf| pf.window(after, limit))
            .unwrap_or((Vec::new(), Vec::new(), 0))
    }

    /// The sequence number of the newest retained line (0 when none).
    pub fn newest_seq(&self, project_name: &str, name: &str) -> u64 {
        let key = format!("{project_name}/{name}");
        self.forwards
            .get(&key)
            .map(|pf| pf.next_seq.saturating_sub(1))
            .unwrap_or(0)
    }

    /// Stop every forward we started — signals each watcher, which kills its
    /// own kubectl child. Never touches port-forwards started outside warpforge.
    pub async fn stop_all(&mut self) -> anyhow::Result<()> {
        for pf in self.forwards.values_mut() {
            pf.stop.notify_waiters();
            pf.status = PfStatus::Stopped;
        }
        Ok(())
    }

    pub fn stop_project(&mut self, project_name: &str) {
        let prefix = format!("{project_name}/");
        for (key, pf) in self.forwards.iter_mut() {
            if key.starts_with(&prefix) {
                pf.stop.notify_waiters();
                pf.status = PfStatus::Stopped;
            }
        }
    }

    /// Stop a single named forward within a project.
    /// (Consumed by the daemon's `portforward.stop` command in Stage 2.)
    #[allow(dead_code)]
    pub fn stop(&mut self, project_name: &str, name: &str) {
        let key = format!("{project_name}/{name}");
        if let Some(pf) = self.forwards.get_mut(&key) {
            pf.stop.notify_waiters();
            pf.status = PfStatus::Stopped;
        }
    }

    /// Stop and forget a forward removed from (or changed in) project config.
    pub fn remove(&mut self, project_name: &str, name: &str) {
        let key = format!("{project_name}/{name}");
        self.stop(project_name, name);
        self.forwards.remove(&key);
    }

    #[allow(dead_code)] // retained for symmetry with the other managers
    pub fn list_for_project(&self, project_name: &str) -> Vec<&ManagedPortForward> {
        let prefix = format!("{project_name}/");
        let mut list: Vec<&ManagedPortForward> = self
            .forwards
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, v)| v)
            .collect();
        list.sort_by_key(|pf| pf.local_port);
        list
    }
}

// ── Watcher task ──────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn watch_portforward(
    project: String,
    name: String,
    namespace: String,
    pod_prefix: String,
    local_port: u16,
    remote_port: u16,
    event_tx: mpsc::UnboundedSender<PfEvent>,
    stop: Arc<Notify>,
) {
    let mut connected_once = false;
    let mut reconnect_delay = 2000u64;
    let mut consecutive_failures = 0u32;
    const MAX_CONSECUTIVE_FAILURES: u32 = 15;

    loop {
        if stop.notified().now_or_never().is_some() {
            return;
        }

        // Check if port is already active
        if is_port_active(local_port).await {
            if connected_once {
                // Port active and we were connected — just wait and recheck
                consecutive_failures = 0;
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(2)) => {}
                    _ = stop.notified() => return,
                }
                continue;
            }

            let _ = event_tx.send(PfEvent::Log {
                project: project.clone(),
                name: name.clone(),
                line: format!("Port {local_port} already in use, reclaiming stale port-forward"),
            });
            kill_stale_port_forward(local_port).await;
            if !wait_for_port_released(local_port, &stop).await {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    let _ = event_tx.send(PfEvent::Failed {
                        project: project.clone(),
                        name: name.clone(),
                        local_port,
                    });
                    return;
                }
                let _ = event_tx.send(PfEvent::Log {
                    project: project.clone(),
                    name: name.clone(),
                    line: format!("Port {local_port} still in use (failure {consecutive_failures}/{MAX_CONSECUTIVE_FAILURES}), retry in {reconnect_delay}ms"),
                });
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(reconnect_delay)) => {}
                    _ = stop.notified() => return,
                }
                reconnect_delay = next_reconnect_delay(reconnect_delay);
                continue;
            }
        }

        if connected_once {
            let _ = event_tx.send(PfEvent::Log {
                project: project.clone(),
                name: name.clone(),
                line: "Connection lost, reconnecting".to_string(),
            });
        }

        // Resolve pod name
        let pod = match resolve_pod(&project, &namespace, &pod_prefix, &name, &event_tx).await {
            Some(p) => p,
            None => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    let _ = event_tx.send(PfEvent::Failed {
                        project: project.clone(),
                        name: name.clone(),
                        local_port,
                    });
                    return;
                }
                let _ = event_tx.send(PfEvent::Log {
                    project: project.clone(),
                    name: name.clone(),
                    line: format!("No pod matching '{pod_prefix}' in namespace '{namespace}' (failure {consecutive_failures}/{MAX_CONSECUTIVE_FAILURES}), retry in 3s"),
                });
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(3)) => {}
                    _ = stop.notified() => return,
                }
                continue;
            }
        };

        let _ = event_tx.send(PfEvent::Log {
            project: project.clone(),
            name: name.clone(),
            line: format!("kubectl port-forward pod/{pod} {local_port}:{remote_port}"),
        });

        let port_arg = format!("{local_port}:{remote_port}");
        let mut child = match Command::new("kubectl")
            .args([
                "port-forward",
                "-n",
                &namespace,
                &format!("pod/{pod}"),
                &port_arg,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    let _ = event_tx.send(PfEvent::Failed {
                        project: project.clone(),
                        name: name.clone(),
                        local_port,
                    });
                    return;
                }
                let _ = event_tx.send(PfEvent::Log {
                    project: project.clone(),
                    name: name.clone(),
                    line: format!("Failed to spawn kubectl: {e} (failure {consecutive_failures}/{MAX_CONSECUTIVE_FAILURES})"),
                });
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(reconnect_delay)) => {}
                    _ = stop.notified() => return,
                }
                reconnect_delay = next_reconnect_delay(reconnect_delay);
                continue;
            }
        };

        // Stream stdout
        if let Some(stdout) = child.stdout.take() {
            let tx = event_tx.clone();
            let n = name.clone();
            let pr = project.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(PfEvent::Log {
                        project: pr.clone(),
                        name: n.clone(),
                        line,
                    });
                }
            });
        }

        // Stream stderr (filter benign errors)
        if let Some(stderr) = child.stderr.take() {
            let tx = event_tx.clone();
            let n = name.clone();
            let pr = project.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !is_benign_forward_error(&line) {
                        let _ = tx.send(PfEvent::Log {
                            project: pr.clone(),
                            name: n.clone(),
                            line: format!("[err] {line}"),
                        });
                    }
                }
            });
        }

        // Wait for port to actually become active
        if wait_for_port_active(local_port, &stop).await {
            let _ = event_tx.send(PfEvent::Log {
                project: project.clone(),
                name: name.clone(),
                line: format!("localhost:{local_port} → pod/{pod}:{remote_port}"),
            });

            if !connected_once {
                let _ = event_tx.send(PfEvent::Active {
                    project: project.clone(),
                    name: name.clone(),
                    local_port,
                });
            } else {
                let _ = event_tx.send(PfEvent::Restarted {
                    project: project.clone(),
                    name: name.clone(),
                    local_port,
                });
            }

            connected_once = true;
            consecutive_failures = 0;
            reconnect_delay = 2000;

            // Wait for child to exit or stop signal
            tokio::select! {
                _ = child.wait() => {
                    // Child exited, will reconnect
                }
                _ = stop.notified() => {
                    let _ = child.start_kill();
                    return;
                }
            }
        } else {
            // Port never became active
            let _ = child.start_kill();
            consecutive_failures += 1;
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                let _ = event_tx.send(PfEvent::Log {
                    project: project.clone(),
                    name: name.clone(),
                    line: format!(
                        "Failed to connect after {MAX_CONSECUTIVE_FAILURES} attempts, giving up"
                    ),
                });
                let _ = event_tx.send(PfEvent::Failed {
                    project: project.clone(),
                    name: name.clone(),
                    local_port,
                });
                return;
            }
            let _ = event_tx.send(PfEvent::Log {
                project: project.clone(),
                name: name.clone(),
                line: format!("Failed to connect (failure {consecutive_failures}/{MAX_CONSECUTIVE_FAILURES}), retry in {reconnect_delay}ms"),
            });
            tokio::select! {
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(reconnect_delay)) => {}
                _ = stop.notified() => return,
            }
            reconnect_delay = next_reconnect_delay(reconnect_delay);
        }
    }
}

async fn is_port_active(port: u16) -> bool {
    Command::new("lsof")
        .args(["-i", &format!(":{port}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn kill_stale_port_forward(port: u16) {
    let _ = Command::new("pkill")
        .args(["-f", &format!("kubectl port-forward.*{port}:")])
        .status()
        .await;
}

async fn wait_for_port_released(port: u16, stop: &Arc<Notify>) -> bool {
    for _ in 0..15 {
        if !is_port_active(port).await {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(200)) => {}
            _ = stop.notified() => return false,
        }
    }
    false
}

async fn wait_for_port_active(port: u16, stop: &Arc<Notify>) -> bool {
    for _ in 0..10 {
        if is_port_active(port).await {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(300)) => {}
            _ = stop.notified() => return false,
        }
    }
    false
}

fn is_benign_forward_error(line: &str) -> bool {
    line.contains("error copying from local connection to remote stream")
        || line.contains("error copying from remote stream to local connection")
}

fn next_reconnect_delay(current: u64) -> u64 {
    std::cmp::min(current * 2, 30000)
}

async fn resolve_pod(
    project: &str,
    namespace: &str,
    pod_prefix: &str,
    name: &str,
    event_tx: &mpsc::UnboundedSender<PfEvent>,
) -> Option<String> {
    let out = match Command::new("kubectl")
        .args(["get", "pods", "-n", namespace, "-o", "name"])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            let _ = event_tx.send(PfEvent::Log {
                project: project.to_string(),
                name: name.to_string(),
                line: format!("[error] kubectl get pods failed: {e}"),
            });
            return None;
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let _ = event_tx.send(PfEvent::Log {
            project: project.to_string(),
            name: name.to_string(),
            line: format!("[error] kubectl: {}", stderr.trim()),
        });
        return None;
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let pods: Vec<&str> = text
        .lines()
        .filter_map(|l| l.strip_prefix("pod/"))
        .collect();

    if pods.is_empty() {
        let _ = event_tx.send(PfEvent::Log {
            project: project.to_string(),
            name: name.to_string(),
            line: format!("[warn] No pods found in namespace '{namespace}'"),
        });
        return None;
    }

    // Exact → prefix → substring
    if pods.contains(&pod_prefix) {
        return Some(pod_prefix.to_string());
    }
    if let Some(p) = pods.iter().find(|p| p.starts_with(pod_prefix)) {
        return Some(p.to_string());
    }
    if let Some(p) = pods.iter().find(|p| p.contains(pod_prefix)) {
        return Some(p.to_string());
    }

    let _ = event_tx.send(PfEvent::Log {
        project: project.to_string(),
        name: name.to_string(),
        line: format!(
            "[warn] No pod matching '{pod_prefix}' — available: {}",
            pods.join(", ")
        ),
    });
    None
}
