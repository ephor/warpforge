use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

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
            PfStatus::Starting   => write!(f, "starting"),
            PfStatus::Active     => write!(f, "active"),
            PfStatus::Restarting => write!(f, "restarting"),
            PfStatus::Failed     => write!(f, "failed"),
            PfStatus::Stopped    => write!(f, "stopped"),
        }
    }
}

#[derive(Debug, Clone)]
pub enum PfEvent {
    Active     { name: String, local_port: u16 },
    Restarted  { name: String, local_port: u16 },
    Failed     { name: String, local_port: u16 },
    Log        { name: String, line: String },
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
}

pub struct PortForwardManager {
    pub forwards: HashMap<String, ManagedPortForward>,
    pub event_tx: mpsc::UnboundedSender<PfEvent>,
}

impl PortForwardManager {
    pub fn new(event_tx: mpsc::UnboundedSender<PfEvent>) -> Self {
        Self { forwards: HashMap::new(), event_tx }
    }

    pub async fn start_all(&mut self, project_name: &str, configs: &[PortForwardConfig]) {
        for cfg in configs {
            let label = cfg.name.clone()
                .unwrap_or_else(|| format!("{}:{}", cfg.namespace, cfg.pod));
            let key = format!("{}/{}", project_name, label);

            if let Some(pf) = self.forwards.get(&key) {
                if matches!(pf.status, PfStatus::Active | PfStatus::Starting | PfStatus::Restarting) {
                    continue;
                }
            }

            self.forwards.insert(key.clone(), ManagedPortForward {
                name: label.clone(),
                namespace: cfg.namespace.clone(),
                pod_prefix: cfg.pod.clone(),
                local_port: cfg.local_port,
                remote_port: cfg.remote_port,
                status: PfStatus::Starting,
                last_event: None,
                logs: vec![format!("Starting port-forward {}:{} → {}:{} ...",
                    cfg.namespace, cfg.pod, cfg.local_port, cfg.remote_port)],
            });

            let namespace   = cfg.namespace.clone();
            let pod_prefix  = cfg.pod.clone();
            let local_port  = cfg.local_port;
            let remote_port = cfg.remote_port;
            let event_tx    = self.event_tx.clone();
            let name_clone  = label.clone();

            tokio::spawn(async move {
                watch_portforward(name_clone, namespace, pod_prefix, local_port, remote_port, event_tx).await;
            });
        }
    }

    pub fn apply_event(&mut self, project_name: &str, event: PfEvent) {
        match &event {
            PfEvent::Log { name, line } => {
                let key = format!("{project_name}/{name}");
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.logs.push(line.clone());
                    if pf.logs.len() > 500 {
                        pf.logs.drain(..pf.logs.len() - 500);
                    }
                }
            }
            PfEvent::Active { name, local_port } => {
                let key = format!("{project_name}/{name}");
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Active;
                    pf.logs.push(format!("✓ Forwarding :{local_port}"));
                }
            }
            PfEvent::Restarted { name, local_port } => {
                let key = format!("{project_name}/{name}");
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Active;
                    pf.last_event = Some(format!("⟳ restarted :{local_port}"));
                    pf.logs.push(format!("⟳ Restarted port-forward :{local_port}"));
                }
            }
            PfEvent::Failed { name, local_port } => {
                let key = format!("{project_name}/{name}");
                if let Some(pf) = self.forwards.get_mut(&key) {
                    pf.status = PfStatus::Failed;
                    pf.last_event = Some(format!("✗ failed :{local_port}"));
                    pf.logs.push(format!("✗ Port-forward :{local_port} gave up after max retries"));
                }
            }
        }
    }

    pub async fn stop_all(&mut self) -> anyhow::Result<()> {
        tokio::process::Command::new("pkill")
            .args(["-f", "kubectl port-forward"])
            .output().await.ok();
        Ok(())
    }

    #[allow(dead_code)]
    pub fn stop_project(&mut self, project_name: &str) {
        let prefix = format!("{project_name}/");
        for (key, pf) in self.forwards.iter_mut() {
            if key.starts_with(&prefix) {
                pf.status = PfStatus::Stopped;
            }
        }
        std::process::Command::new("pkill")
            .args(["-f", "kubectl port-forward"])
            .output().ok();
    }

    pub fn list_for_project(&self, project_name: &str) -> Vec<&ManagedPortForward> {
        let prefix = format!("{project_name}/");
        let mut list: Vec<&ManagedPortForward> = self.forwards.iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, v)| v)
            .collect();
        list.sort_by_key(|pf| pf.local_port);
        list
    }
}

// ── Watcher task ──────────────────────────────────────────────────────────────

async fn watch_portforward(
    name: String,
    namespace: String,
    pod_prefix: String,
    local_port: u16,
    remote_port: u16,
    event_tx: mpsc::UnboundedSender<PfEvent>,
) {
    let mut attempt = 0u32;
    let max_retries = 10;

    loop {
        // Resolve pod name, emit diagnostic if it fails
        let pod = match resolve_pod(&namespace, &pod_prefix, &name, &event_tx).await {
            Some(p) => p,
            None => {
                let _ = event_tx.send(PfEvent::Log {
                    name: name.clone(),
                    line: format!("[attempt {attempt}] No pod matching '{pod_prefix}' in namespace '{namespace}' — retrying in 3s"),
                });
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                attempt += 1;
                if attempt >= max_retries {
                    let _ = event_tx.send(PfEvent::Failed { name, local_port });
                    return;
                }
                continue;
            }
        };

        let _ = event_tx.send(PfEvent::Log {
            name: name.clone(),
            line: format!("[attempt {attempt}] kubectl port-forward pod/{pod} {local_port}:{remote_port}"),
        });

        let port_arg = format!("{local_port}:{remote_port}");
        let mut child = match Command::new("kubectl")
            .args(["port-forward", "-n", &namespace, &format!("pod/{pod}"), &port_arg])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = event_tx.send(PfEvent::Log {
                    name: name.clone(),
                    line: format!("[error] Failed to spawn kubectl: {e}"),
                });
                let _ = event_tx.send(PfEvent::Failed { name, local_port });
                return;
            }
        };

        // Stream stdout
        if let Some(stdout) = child.stdout.take() {
            let tx = event_tx.clone();
            let n = name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(PfEvent::Log { name: n.clone(), line });
                }
            });
        }

        // Stream stderr
        if let Some(stderr) = child.stderr.take() {
            let tx = event_tx.clone();
            let n = name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(PfEvent::Log { name: n.clone(), line: format!("[err] {line}") });
                }
            });
        }

        // Give kubectl a moment to bind
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

        if attempt == 0 {
            let _ = event_tx.send(PfEvent::Active { name: name.clone(), local_port });
        } else {
            let _ = event_tx.send(PfEvent::Restarted { name: name.clone(), local_port });
        }

        let _ = child.wait().await;

        attempt += 1;
        if attempt >= max_retries {
            let _ = event_tx.send(PfEvent::Failed { name, local_port });
            return;
        }

        let delay = match attempt { 1 => 2, 2..=3 => 5, _ => 10 };
        let _ = event_tx.send(PfEvent::Log {
            name: name.clone(),
            line: format!("[attempt {attempt}] Process exited — retry in {delay}s"),
        });
        tokio::time::sleep(tokio::time::Duration::from_secs(delay)).await;
    }
}

async fn resolve_pod(
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
                name: name.to_string(),
                line: format!("[error] kubectl get pods failed: {e}"),
            });
            return None;
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let _ = event_tx.send(PfEvent::Log {
            name: name.to_string(),
            line: format!("[error] kubectl: {}", stderr.trim()),
        });
        return None;
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let pods: Vec<&str> = text.lines()
        .filter_map(|l| l.strip_prefix("pod/"))
        .collect();

    if pods.is_empty() {
        let _ = event_tx.send(PfEvent::Log {
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
        name: name.to_string(),
        line: format!("[warn] No pod matching '{pod_prefix}' — available: {}", pods.join(", ")),
    });
    None
}
