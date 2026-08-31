//! Read-only accessors, log windowing, and event application — the state
//! queries other modules (snapshots, TUI, wire) are built on.

use super::{ManagedService, ServiceEvent, ServiceManager, ServiceStatus};

impl ServiceManager {
    pub fn get(&self, project_name: &str, service_name: &str) -> Option<&ManagedService> {
        self.services.get(&format!("{project_name}/{service_name}"))
    }

    #[allow(dead_code)] // test seam: lets tests mutate a managed service directly
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
