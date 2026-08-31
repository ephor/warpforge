//! Spawning and readiness detection: port allocation, environment
//! interpolation, and the async tasks that stream a process's logs, status,
//! and exit into [`ServiceEvent`]s.

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

use super::{ManagedService, ServiceEvent, ServiceManager, ServiceStatus};
use crate::ports;

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

/// Find a surviving `${svc.port}` placeholder in interpolated env values —
/// a dependency whose port was never allocated (failed pin, range conflict,
/// or a typo in the placeholder). Returns the refusal message naming the
/// unresolved service.
fn unresolved_port_placeholder(
    env: &HashMap<String, String>,
    port_map: &HashMap<String, u16>,
    service_name: &str,
) -> Option<String> {
    for value in env.values() {
        let mut rest = value.as_str();
        while let Some(pos) = rest.find("${") {
            let Some(end) = rest[pos..].find('}') else {
                break;
            };
            let placeholder = &rest[pos + 2..pos + end];
            if let Some(dep) = placeholder.strip_suffix(".port") {
                if !port_map.contains_key(dep) {
                    return Some(format!(
                        "service {service_name} references ${{{dep}.port}} but {dep} has no allocated port (its pinned port failed or its project has a range conflict); fix or start {dep} first"
                    ));
                }
            }
            rest = &rest[pos + end + 1..];
        }
    }
    None
}

pub fn spawn_port_ready_probe(
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

impl ServiceManager {
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &mut self,
        project_name: &str,
        project_path: &str,
        range: (u16, u16),
        pin: ports::PortPin,
        service_name: &str,
        command: &str,
        original_port: u16,
        env: Option<&HashMap<String, String>>,
        ready_pattern: Option<&str>,
        // Set when the project's port ranges conflict — services refuse to
        // start until the conflict is resolved (ADR 0006 decision 4).
        conflict: Option<&str>,
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
            super::stop::kill_group(old_pgid).await;
            ports::release(project_name, service_name);
        }

        // A range conflict is a config problem: refuse loudly, exactly like a
        // pinned-port failure, instead of starting into someone else's ports.
        // A pinned port that cannot be bound fails the service — no fallback.
        let allocation = if let Some(reason) = conflict {
            Err(reason.to_string())
        } else if original_port > 0 {
            ports::allocate(range, project_name, service_name, original_port, pin)
        } else {
            Ok(0)
        };
        let allocated_port = match allocation {
            Ok(port) => port,
            Err(message) => {
                self.record_start_failure(&key, project_name, service_name, command, message);
                return Ok(());
            }
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
            // A surviving ${svc.port} placeholder means a dependency never got
            // a port (its pin failed, or its project has a range conflict).
            // Starting the dependent with the placeholder as a literal — a
            // URL, a config value — is a silent wrong-port bug. Invariant 4:
            // the dependent fails as loudly as the pin itself did.
            if let Some(message) =
                unresolved_port_placeholder(&interpolated, &port_map, service_name)
            {
                self.record_start_failure(&key, project_name, service_name, command, message);
                return Ok(());
            }
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
            port_pinned: pin == ports::PortPin::Strict,
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

    /// Record a refused start (pinned port taken / outside range / range
    /// conflict) as a `Failed` service so the reason reaches the client the
    /// same way any other failure does: a status change plus a log marker.
    fn record_start_failure(
        &mut self,
        key: &str,
        project_name: &str,
        service_name: &str,
        command: &str,
        message: String,
    ) {
        let run_id = self.next_run_id;
        self.next_run_id = self.next_run_id.saturating_add(1);
        let existing_logs = self
            .services
            .get(key)
            .map(|s| s.logs.clone())
            .unwrap_or_default();
        let next_seq = existing_logs
            .last()
            .map(|l| l.seq.saturating_add(1))
            .unwrap_or(0);
        let mut managed = ManagedService {
            name: service_name.to_string(),
            project_name: project_name.to_string(),
            command: command.to_string(),
            status: ServiceStatus::Failed,
            logs: existing_logs,
            next_seq,
            original_port: 0,
            allocated_port: 0,
            port_pinned: false,
            pgid: None,
            run_id,
            stopping: Arc::new(AtomicBool::new(false)),
        };
        managed.push_log(format!("[service failed] {message}"));
        self.services.insert(key.to_string(), managed);
        let _ = self.event_tx.send(ServiceEvent::StatusChange {
            key: key.to_string(),
            run_id,
            status: ServiceStatus::Failed,
            exit_code: None,
        });
    }
}
