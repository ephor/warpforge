//! Resolved port ranges, owned by the daemon actor (ADR 0006).
//!
//! A project's range is resolved data — local override > declared config
//! range > sticky registry range > fresh scan — never an index into
//! `projects.json`. `recompute_port_ranges` is the single place that
//! resolution happens; it also persists newly assigned sticky ranges so a
//! project keeps its range across add/remove of other projects.

use std::path::Path;
#[cfg(test)]
use std::sync::{Arc, Mutex};

use warpforge_protocol as wire;

use crate::config::{self, load_workspace_config, PortFallback};
use crate::ports::{resolve_ranges, PortPin, ProjectPortInput, RangeSource};
use crate::registry::PortRange;

use crate::daemon::actor::Daemon;

/// Where newly-resolved sticky port ranges are persisted. The real daemon
/// writes the registry (`~/.warpforge/projects.json`); test builds inject an
/// in-memory sink so no test run can ever touch the developer's registry.
#[derive(Clone, Default)]
pub(crate) enum PortRangeSink {
    /// The real registry writer (production).
    #[default]
    Registry,
    /// Test-local sink: records every write for assertions.
    #[cfg(test)]
    Memory(Arc<Mutex<Vec<(String, PortRange)>>>),
}

impl PortRangeSink {
    /// The sink a plain [`Daemon::spawn`] uses: in-memory under `cargo test`,
    /// the real registry otherwise.
    pub(crate) fn for_current_build() -> Self {
        #[cfg(test)]
        {
            Self::memory()
        }
        #[cfg(not(test))]
        {
            Self::Registry
        }
    }

    #[cfg(test)]
    pub(crate) fn memory() -> Self {
        Self::Memory(Arc::new(Mutex::new(Vec::new())))
    }

    /// Persist a newly assigned sticky range. A project missing from the
    /// registry (test-injected entries, or a race with removal) is a no-op,
    /// not an error worth logging — nothing a log line could fix.
    fn store(&self, name: &str, range: PortRange) -> Result<(), String> {
        match self {
            Self::Registry => {
                let known = crate::registry::list_projects()
                    .map(|projects| projects.iter().any(|p| p.name == name))
                    .unwrap_or(false);
                if !known {
                    return Ok(());
                }
                crate::registry::set_port_range(name, Some(range)).map_err(|e| e.to_string())
            }
            #[cfg(test)]
            Self::Memory(log) => {
                log.lock().unwrap().push((name.to_string(), range));
                Ok(())
            }
        }
    }

    fn is_registry(&self) -> bool {
        matches!(self, Self::Registry)
    }
}

/// Old positional formula, kept only for the one-time migration of registry
/// entries that predate stored ranges (captured at daemon boot). Never used
/// for fresh assignments.
fn positional_range(index: usize) -> (u16, u16) {
    let start = (4000 + index.saturating_mul(100)).min(u16::MAX as usize - 99) as u16;
    (start, start + 99)
}

fn range_bounds(r: PortRange) -> (u16, u16) {
    (r.start, r.start + r.size.saturating_sub(1))
}

pub(crate) fn range_source(source: RangeSource) -> wire::PortRangeSource {
    match source {
        RangeSource::Assigned => wire::PortRangeSource::Auto,
        RangeSource::Sticky => wire::PortRangeSource::Sticky,
        RangeSource::Declared => wire::PortRangeSource::Declared,
        RangeSource::LocalOverride => wire::PortRangeSource::LocalOverride,
    }
}

impl Daemon {
    /// Re-resolve every project's port range from current state and persist
    /// sticky assignments that changed. Returns the names of projects whose
    /// resolved range (or conflict) changed, so callers can broadcast updates.
    pub(crate) fn recompute_port_ranges(&mut self) -> Vec<String> {
        let inputs: Vec<ProjectPortInput> = self
            .projects
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let local_override = entry.port_range_override.map(range_bounds);
                let declared = load_workspace_config(Path::new(&entry.path))
                    .and_then(|config| config.ports)
                    .and_then(|ports| match config::parse_range(&ports.range) {
                        Some(range) => Some(range),
                        None => {
                            eprintln!(
                                "warpforge: project \"{}\" has an invalid ports.range {:?} — ignoring it",
                                entry.name, ports.range
                            );
                            None
                        }
                    });
                // One-time migration: only entries that predate stored ranges
                // (captured at daemon boot) get their positional range, then
                // it is frozen below. Anything registered afterwards falls
                // through to `sticky: None` and gets a fresh scan.
                let sticky = entry.port_range.map(range_bounds).or_else(|| {
                    if self.positional_migration.contains(&entry.name) {
                        Some(positional_range(index))
                    } else {
                        None
                    }
                });
                ProjectPortInput {
                    name: entry.name.clone(),
                    declared,
                    sticky,
                    local_override,
                }
            })
            .collect();

        let mut affected = Vec::new();
        for resolved in resolve_ranges(&inputs) {
            let previous = self.port_ranges.get(&resolved.name);
            let changed = !previous.is_some_and(|prev| {
                prev.range == resolved.range
                    && prev.source == resolved.source
                    && prev.conflict_with == resolved.conflict_with
            });

            // Freeze the migration / new assignments: write the resolved range
            // back to the registry whenever it differs from the stored one.
            let stored = PortRange {
                start: resolved.range.0,
                size: resolved.range.1 - resolved.range.0 + 1,
            };
            if let Some(entry) = self.projects.iter_mut().find(|p| p.name == resolved.name) {
                if entry.port_range != Some(stored) {
                    match self.port_range_sink.store(&resolved.name, stored) {
                        Ok(()) => {
                            if self.port_range_sink.is_registry() {
                                eprintln!(
                                    "warpforge: stored port range {}-{} for project \"{}\"",
                                    stored.start,
                                    stored.start + stored.size - 1,
                                    resolved.name
                                );
                            }
                            // Only claim the stored range once it actually
                            // landed; a failed store retries on the next
                            // recompute instead of silently diverging.
                            entry.port_range = Some(stored);
                        }
                        Err(e) => eprintln!(
                            "warpforge: could not store port range for project \"{}\": {e}",
                            resolved.name
                        ),
                    }
                }
            }

            if changed {
                affected.push(resolved.name.clone());
            }
            self.port_ranges.insert(resolved.name.clone(), resolved);
        }
        affected
    }

    pub(crate) fn port_range_for(&self, project: &str) -> Option<(u16, u16)> {
        self.port_ranges.get(project).map(|r| r.range)
    }

    pub(crate) fn port_conflict_for(&self, project: &str) -> Option<&str> {
        self.port_ranges
            .get(project)
            .and_then(|r| r.conflict_with.as_deref())
    }

    /// Whether a service's declared port is a hard pin: the project has an
    /// explicit range (declared or overridden) and the service declares a
    /// port, unless it opted back into fallback with `portFallback: auto`.
    pub(crate) fn port_pin_for(
        &self,
        project: &str,
        service: &crate::config::ServiceConfig,
    ) -> PortPin {
        let explicit = matches!(
            self.port_ranges.get(project).map(|r| r.source),
            Some(RangeSource::Declared | RangeSource::LocalOverride)
        );
        let declares_port = service.port.unwrap_or(0) > 0;
        let opted_in = service.port_fallback == Some(PortFallback::Auto);
        if explicit && declares_port && !opted_in {
            PortPin::Strict
        } else {
            PortPin::Auto
        }
    }

    /// Broadcast `ProjectConfigChanged` for every named project. Callers must
    /// include every project whose resolved range moved — a client that misses
    /// one shows a range the project no longer has.
    pub(crate) fn broadcast_project_config(&mut self, names: &[String]) {
        for name in names {
            let config = load_workspace_config(Path::new(
                &self
                    .projects
                    .iter()
                    .find(|p| p.name == *name)
                    .map(|p| p.path.clone())
                    .unwrap_or_default(),
            ));
            let state = self.build_project_config_state(name, config.as_ref());
            self.emit(crate::daemon::actor::Event::ProjectConfigChanged(state));
        }
    }

    /// Re-resolve every project's port range and broadcast every project whose
    /// resolved range (or conflict) changed — a relocation can move other
    /// projects too. `always` names a project that is broadcast even when its
    /// range did not move (the one whose config changed for other reasons).
    pub(crate) fn recompute_and_broadcast_port_ranges(&mut self, always: Option<&str>) {
        let mut affected = self.recompute_port_ranges();
        if let Some(name) = always {
            if !affected.iter().any(|n| n == name) {
                affected.push(name.to_string());
            }
        }
        self.broadcast_project_config(&affected);
    }

    /// Why a project's services refuse to start, if its declared range
    /// collides with another project's.
    pub(crate) fn start_blocker_for(&self, project: &str) -> Option<String> {
        let other = self.port_conflict_for(project)?;
        let range = self
            .port_range_for(project)
            .map(|(s, e)| format!("{s}-{e}"))
            .unwrap_or_default();
        Some(format!(
            "project \"{project}\" declares port range {range} which conflicts with project \"{other}\"; move one of them to a different range before starting services"
        ))
    }

    /// Apply a local port-range override: write it to the registry only
    /// (ADR 0006 invariant 1 — the shared config is never touched), re-resolve
    /// every range, and broadcast every affected project — a relocation can
    /// move other projects too.
    pub(crate) fn set_port_range_override(
        &mut self,
        project: &str,
        range: Option<PortRange>,
    ) -> Result<(), String> {
        if !self.projects.iter().any(|p| p.name == project) {
            return Err(format!("Project \"{project}\" is not registered"));
        }
        crate::registry::set_port_range_override(project, range)
            .map_err(|e| format!("registry: {e}"))?;
        if let Some(entry) = self.projects.iter_mut().find(|p| p.name == project) {
            entry.port_range_override = range;
        }
        self.recompute_and_broadcast_port_ranges(Some(project));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::ResolvedRange;

    fn resolved(name: &str, range: (u16, u16), source: RangeSource) -> ResolvedRange {
        ResolvedRange {
            name: name.into(),
            range,
            source,
            conflict_with: None,
        }
    }

    #[test]
    fn range_source_maps_to_wire() {
        assert_eq!(
            range_source(RangeSource::Assigned),
            wire::PortRangeSource::Auto
        );
        assert_eq!(
            range_source(RangeSource::LocalOverride),
            wire::PortRangeSource::LocalOverride
        );
    }

    #[test]
    fn positional_range_matches_the_old_formula() {
        assert_eq!(positional_range(0), (4000, 4099));
        assert_eq!(positional_range(3), (4300, 4399));
    }
}
