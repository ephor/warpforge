use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};

use crate::config::PortForwardConfig;

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
    pub logs: Vec<String>,
    /// Notifying this asks the watcher task to kill its kubectl child and exit
    /// — scoped teardown, so we never `pkill` port-forwards we didn't start.
    stop: Arc<Notify>,
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
                    logs: vec![format!(
                        "Starting port-forward {}:{} → {}:{} ...",
                        cfg.namespace, cfg.pod, cfg.local_port, cfg.remote_port
                    )],
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
                    pf.logs.push(line.clone());
                    if pf.logs.len() > 500 {
                        pf.logs.drain(..pf.logs.len() - 500);
                    }
                }
            }
            PfEvent::Active { local_port, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Active;
                    pf.logs.push(format!("✓ Forwarding :{local_port}"));
                }
            }
            PfEvent::Restarted { local_port, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Active;
                    pf.last_event = Some(format!("⟳ restarted :{local_port}"));
                    pf.logs
                        .push(format!("⟳ Restarted port-forward :{local_port}"));
                }
            }
            PfEvent::Failed { local_port, .. } => {
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Failed;
                    pf.last_event = Some(format!("✗ failed :{local_port}"));
                    pf.logs.push(format!(
                        "✗ Port-forward :{local_port} gave up after max retries"
                    ));
                }
            }
        }
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
    let mut attempt = 0u32;
    let max_retries = 10;

    loop {
        // Resolve pod name, emit diagnostic if it fails
        let pod = match resolve_pod(&project, &namespace, &pod_prefix, &name, &event_tx).await {
            Some(p) => p,
            None => {
                let _ = event_tx.send(PfEvent::Log {
                    project: project.clone(),
                    name: name.clone(),
                    line: format!("[attempt {attempt}] No pod matching '{pod_prefix}' in namespace '{namespace}' — retrying in 3s"),
                });
                // Cancellable sleep — a stop during backoff must exit promptly.
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(3)) => {}
                    _ = stop.notified() => return,
                }
                attempt += 1;
                if attempt >= max_retries {
                    let _ = event_tx.send(PfEvent::Failed {
                        project,
                        name,
                        local_port,
                    });
                    return;
                }
                continue;
            }
        };

        let _ = event_tx.send(PfEvent::Log {
            project: project.clone(),
            name: name.clone(),
            line: format!(
                "[attempt {attempt}] kubectl port-forward pod/{pod} {local_port}:{remote_port}"
            ),
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
                let _ = event_tx.send(PfEvent::Log {
                    project: project.clone(),
                    name: name.clone(),
                    line: format!("[error] Failed to spawn kubectl: {e}"),
                });
                let _ = event_tx.send(PfEvent::Failed {
                    project,
                    name,
                    local_port,
                });
                return;
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

        // Stream stderr
        if let Some(stderr) = child.stderr.take() {
            let tx = event_tx.clone();
            let n = name.clone();
            let pr = project.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(PfEvent::Log {
                        project: pr.clone(),
                        name: n.clone(),
                        line: format!("[err] {line}"),
                    });
                }
            });
        }

        // Give kubectl a moment to bind
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

        if attempt == 0 {
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

        // Wait for the child to exit OR a stop request. On stop, dropping the
        // child (kill_on_drop) terminates only our kubectl process.
        tokio::select! {
            _ = child.wait() => {}
            _ = stop.notified() => {
                let _ = child.start_kill();
                return;
            }
        }

        attempt += 1;
        if attempt >= max_retries {
            let _ = event_tx.send(PfEvent::Failed {
                project,
                name,
                local_port,
            });
            return;
        }

        let delay = match attempt {
            1 => 2,
            2..=3 => 5,
            _ => 10,
        };
        let _ = event_tx.send(PfEvent::Log {
            project: project.clone(),
            name: name.clone(),
            line: format!("[attempt {attempt}] Process exited — retry in {delay}s"),
        });
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(delay)) => {}
            _ = stop.notified() => return,
        }
    }
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
