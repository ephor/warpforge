//! Stopping and process-group teardown, plus the lsof-based listener sweep.
//!
//! `kill_listeners_on_ports` only ever touches ports this process handed out
//! (ADR 0006 invariant 3): a pinned range legitimately holds processes
//! warpforge never started, so there is no range-scan kill anywhere — not at
//! teardown, and not at daemon startup.

use anyhow::Result;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::sleep;

use super::{ServiceManager, ServiceStatus};
use crate::ports;

/// Kill the entire process group so that sh→npm→node (etc.) all die together.
pub(super) async fn kill_group(pgid: Option<u32>) {
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

/// Kill whatever listens on exactly these ports.
///
/// Callers may only pass ports they know warpforge allocated — filtered
/// through [`crate::ports::allocated_in_ranges`] — so this can never reach a
/// process warpforge did not start.
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

impl ServiceManager {
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
}
