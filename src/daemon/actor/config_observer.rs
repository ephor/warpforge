use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use warpforge_protocol as wire;

use crate::config::{find_config_file, sorted_services, WorkspaceConfig};
use crate::registry::ProjectEntry;
use crate::service::ServiceStatus;

use crate::daemon::actor::Daemon;
use crate::daemon::wire as wireconv;

/// Split a `project/service` service key back into its parts (split on first
/// `/`, which is how `ServiceManager` composes the key).
pub(crate) fn split_key(key: &str) -> (String, String) {
    match key.split_once('/') {
        Some((p, s)) => (p.to_string(), s.to_string()),
        None => (String::new(), key.to_string()),
    }
}

pub(crate) type ConfigFingerprint = Option<(PathBuf, Vec<u8>)>;

pub(crate) const CONFIG_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const CONFIG_CHANGE_DEBOUNCE: Duration = Duration::from_millis(200);

/// How often the daemon re-runs history pruning. The first sweep happens at
/// start, so a shortened window applies without waiting a day.
pub(crate) const HISTORY_PRUNE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) fn config_fingerprint(project_path: &Path) -> ConfigFingerprint {
    let path = find_config_file(project_path);
    std::fs::read(&path).ok().map(|contents| (path, contents))
}

/// Content-based, debounced observer for registered project configs.
///
/// Resolving the active config path on each pass rather than tracking one inode
/// is important because many editors save by replacing the file atomically.
/// Polling the small config files also keeps the daemon cross-platform without
/// another native watcher dependency.
pub(crate) struct ConfigObserver {
    pub(crate) applied: HashMap<String, ConfigFingerprint>,
    pub(crate) pending: HashMap<String, (ConfigFingerprint, Instant)>,
}

impl ConfigObserver {
    pub(crate) fn new(projects: &[ProjectEntry]) -> Self {
        Self {
            applied: projects
                .iter()
                .map(|project| {
                    (
                        project.name.clone(),
                        config_fingerprint(Path::new(&project.path)),
                    )
                })
                .collect(),
            pending: HashMap::new(),
        }
    }

    pub(crate) fn track(&mut self, project: &ProjectEntry) {
        self.applied.insert(
            project.name.clone(),
            config_fingerprint(Path::new(&project.path)),
        );
        self.pending.remove(&project.name);
    }

    pub(crate) fn untrack(&mut self, project: &str) {
        self.applied.remove(project);
        self.pending.remove(project);
    }

    pub(crate) fn ready(
        &mut self,
        projects: &[ProjectEntry],
        now: Instant,
    ) -> Vec<(String, ConfigFingerprint)> {
        let registered: HashSet<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        self.applied
            .retain(|project, _| registered.contains(project.as_str()));
        self.pending
            .retain(|project, _| registered.contains(project.as_str()));

        let mut ready = Vec::new();
        for project in projects {
            let current = config_fingerprint(Path::new(&project.path));
            if self.applied.get(&project.name) == Some(&current) {
                self.pending.remove(&project.name);
                continue;
            }

            match self.pending.get_mut(&project.name) {
                Some((pending, since)) if *pending == current => {
                    if now.duration_since(*since) >= CONFIG_CHANGE_DEBOUNCE {
                        ready.push((project.name.clone(), current));
                    }
                }
                Some((pending, since)) => {
                    *pending = current;
                    *since = now;
                }
                None => {
                    self.pending.insert(project.name.clone(), (current, now));
                }
            }
        }
        ready
    }

    pub(crate) fn mark_applied(&mut self, project: &str, fingerprint: ConfigFingerprint) {
        self.applied.insert(project.to_string(), fingerprint);
        self.pending.remove(project);
    }
}

impl Daemon {
    pub(crate) fn build_project_config_state(
        &self,
        project_name: &str,
        config: Option<&WorkspaceConfig>,
    ) -> wire::ProjectConfigState {
        let Some(project) = self.projects.iter().find(|p| p.name == project_name) else {
            panic!("build_project_config_state: unknown project {project_name:?}");
        };
        let (start, end) = self.port_range_for(&project.name).unwrap_or((4000, 4099));
        let (port_range_source, port_range_conflict) = self
            .port_ranges
            .get(&project.name)
            .map(|resolved| {
                (
                    crate::daemon::actor::ports::range_source(resolved.source),
                    resolved.conflict_with.clone(),
                )
            })
            .unwrap_or((wire::PortRangeSource::Auto, None));
        let declared_services = config.map(sorted_services).unwrap_or_default();
        let agent_templates = config
            .and_then(|c| c.agent_templates.as_ref())
            .map(|templates| {
                templates
                    .iter()
                    .map(|(name, template)| (name.clone(), template.command.clone()))
                    .collect()
            })
            .unwrap_or_default();

        // Start from every declared service in a stopped state, then overlay a
        // matching live process. This lets clients render Start controls before
        // a service has ever been launched.
        let mut service_map: HashMap<String, wire::ServiceInfo> = config
            .map(|config| {
                config
                    .services
                    .iter()
                    .map(|(name, service)| {
                        (
                            name.clone(),
                            wire::ServiceInfo {
                                project: project.name.clone(),
                                name: name.clone(),
                                command: service.command.clone(),
                                status: wire::ServiceStatus::Stopped,
                                original_port: service.port.unwrap_or(0),
                                allocated_port: 0,
                                // A pinned service that has never started is
                                // still pinned: report from the resolved
                                // range, not from a live process.
                                port_pinned: self.port_pin_for(&project.name, service)
                                    == crate::ports::PortPin::Strict,
                                log_seq: 0,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        for service in self.services.list_for_project(&project.name) {
            if let Some(declared) = service_map.get_mut(&service.name) {
                declared.status = wireconv::service_status(&service.status);
                declared.allocated_port = service.allocated_port;
                declared.port_pinned = service.port_pinned;
                declared.log_seq = self.services.newest_seq(&project.name, &service.name);
                if matches!(
                    service.status,
                    ServiceStatus::Starting | ServiceStatus::Running
                ) {
                    // A running process still reflects the definition it was
                    // launched with. Stopped/failed entries use the refreshed
                    // config so their next Start is represented accurately.
                    declared.command = service.command.clone();
                    declared.original_port = service.original_port;
                }
            }
        }
        let mut services: Vec<_> = service_map.into_values().collect();
        services.sort_by(|a, b| a.name.cmp(&b.name));

        // As with services, declared port-forwards exist in client state even
        // before kubectl has been started. Live state wins only while that
        // forward is still present in the current config.
        let mut pf_map: HashMap<String, wire::PortForwardInfo> = config
            .map(|config| {
                config
                    .portforwards
                    .iter()
                    .map(|pf| {
                        let name = pf
                            .name
                            .clone()
                            .unwrap_or_else(|| format!("{}:{}", pf.namespace, pf.pod));
                        (
                            name.clone(),
                            wire::PortForwardInfo {
                                project: project.name.clone(),
                                name,
                                namespace: pf.namespace.clone(),
                                pod: pf.pod.clone(),
                                local_port: pf.local_port,
                                remote_port: pf.remote_port,
                                status: wire::PortForwardStatus::Stopped,
                                log_seq: 0,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        for pf in self.portforwards.list_for_project(&project.name) {
            if pf_map.contains_key(&pf.name) {
                pf_map.insert(
                    pf.name.clone(),
                    wire::PortForwardInfo {
                        project: project.name.clone(),
                        name: pf.name.clone(),
                        namespace: pf.namespace.clone(),
                        pod: pf.pod_prefix.clone(),
                        local_port: pf.local_port,
                        remote_port: pf.remote_port,
                        status: wireconv::pf_status(&pf.status),
                        log_seq: self.portforwards.newest_seq(&project.name, &pf.name),
                    },
                );
            }
        }
        let mut portforwards: Vec<_> = pf_map.into_values().collect();
        portforwards.sort_by(|a, b| a.name.cmp(&b.name));

        wire::ProjectConfigState {
            project: wire::ProjectInfo {
                name: project.name.clone(),
                path: project.path.clone(),
                port_range: (start, end),
                port_range_source,
                port_range_conflict,
                declared_services,
                agent_templates,
            },
            services,
            portforwards,
        }
    }
}
