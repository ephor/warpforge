use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceHealthcheck {
    pub url: String,
    pub interval: String,
}

/// Explicit override for how a service reacts when its configured `port` is
/// taken. `auto` opts back into first-free-in-range shifting; `None` means
/// "infer": strict when the port is pinned, auto otherwise. (The ADR only
/// ever specifies `auto` as the opt-out — a `strict` value would be a no-op,
/// so it is not expressible.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortFallback {
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceConfig {
    pub command: String,
    pub port: Option<u16>,
    pub env: Option<HashMap<String, String>>,
    pub healthcheck: Option<ServiceHealthcheck>,
    #[serde(rename = "readyPattern")]
    pub ready_pattern: Option<String>,
    /// Services that must be running before this one starts
    #[serde(rename = "dependsOn", default)]
    pub depends_on: Vec<String>,
    #[serde(rename = "portFallback", default)]
    pub port_fallback: Option<PortFallback>,
}

/// Project-level committed port range, e.g. `range: "4200-4299"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortsConfig {
    /// Inclusive range string, e.g. "4200-4299".
    pub range: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTemplate {
    pub command: String,
    pub description: Option<String>,
}

/// One kubectl port-forward entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardConfig {
    pub namespace: String,
    /// Pod name or prefix (warpforge finds first matching pod)
    pub pod: String,
    #[serde(rename = "localPort")]
    pub local_port: u16,
    #[serde(rename = "remotePort")]
    pub remote_port: u16,
    /// Human-readable label shown in TUI
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub name: String,
    #[serde(default)]
    pub services: HashMap<String, ServiceConfig>,
    #[serde(rename = "agentTemplates")]
    pub agent_templates: Option<HashMap<String, AgentTemplate>>,
    #[serde(default)]
    pub portforwards: Vec<PortForwardConfig>,
    #[serde(default)]
    pub ports: Option<PortsConfig>,
}

/// Topologically sorted service names respecting `depends_on`.
/// Dependencies start first. Falls back to alphabetical on cycles.
pub fn sorted_services(config: &WorkspaceConfig) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();

    fn visit(
        name: &str,
        config: &WorkspaceConfig,
        visited: &mut std::collections::HashSet<String>,
        result: &mut Vec<String>,
        depth: usize,
    ) {
        if visited.contains(name) || depth > 20 {
            return;
        }
        visited.insert(name.to_string());
        if let Some(svc) = config.services.get(name) {
            for dep in &svc.depends_on {
                visit(dep, config, visited, result, depth + 1);
            }
        }
        if config.services.contains_key(name) {
            result.push(name.to_string());
        }
    }

    let mut names: Vec<String> = config.services.keys().cloned().collect();
    names.sort();
    for name in &names {
        visit(name, config, &mut visited, &mut result, 0);
    }
    result
}

/// Config file names in priority order: new → legacy. `.warpforge/` is the
/// preferred home for warpforge files (workspace config, workflows); the
/// root-level names keep working for existing projects.
const CONFIG_NAMES: &[&str] = &[
    ".warpforge/workspace.yaml",
    ".warpforge.yaml",
    ".wf.yaml",
    ".workspace.yaml",
];

/// Load a project's config while preserving the distinction between a missing
/// config and an existing file that could not be read or parsed.
///
/// Config observers use this to avoid replacing the last good UI state while
/// an editor is in the middle of writing invalid YAML.
pub fn try_load_workspace_config(project_path: &Path) -> Result<Option<WorkspaceConfig>> {
    for name in CONFIG_NAMES {
        let config_path = project_path.join(name);
        if config_path.exists() {
            let text = fs::read_to_string(&config_path)
                .with_context(|| format!("reading {}", config_path.display()))?;
            let config = serde_yaml::from_str(&text)
                .with_context(|| format!("parsing {}", config_path.display()))?;
            return Ok(Some(config));
        }
    }
    Ok(auto_detect(project_path))
}

pub fn load_workspace_config(project_path: &Path) -> Option<WorkspaceConfig> {
    try_load_workspace_config(project_path).ok().flatten()
}

/// Return the first existing config file path, or the default
/// `.warpforge/workspace.yaml` for projects that have no config yet. Callers
/// writing to the returned path must create its parent directory first.
pub fn find_config_file(project_path: &Path) -> std::path::PathBuf {
    for name in CONFIG_NAMES {
        let p = project_path.join(name);
        if p.exists() {
            return p;
        }
    }
    project_path.join(CONFIG_NAMES[0])
}

fn auto_detect(project_path: &Path) -> Option<WorkspaceConfig> {
    let mut services = HashMap::new();
    let name = project_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Detect package.json dev script
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(text) = fs::read_to_string(&pkg_path) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) {
                if pkg["scripts"]["dev"].is_string() {
                    let is_bun = project_path.join("bun.lock").exists()
                        || project_path.join("bunfig.toml").exists();
                    services.insert(
                        "app".to_string(),
                        ServiceConfig {
                            command: if is_bun { "bun run dev" } else { "npm run dev" }.to_string(),
                            port: Some(3000),
                            env: None,
                            healthcheck: None,
                            ready_pattern: None,
                            depends_on: vec![],
                            port_fallback: None,
                        },
                    );
                }
            }
        }
    }

    // Detect docker-compose
    let compose_names = [
        "docker-compose.yaml",
        "docker-compose.yml",
        "compose.yaml",
        "compose.yml",
    ];
    'compose: for compose_name in &compose_names {
        let compose_path = project_path.join(compose_name);
        if compose_path.exists() {
            if let Ok(text) = fs::read_to_string(&compose_path) {
                if let Ok(compose) = serde_yaml::from_str::<serde_yaml::Value>(&text) {
                    if let Some(svcs) = compose["services"].as_mapping() {
                        for (k, v) in svcs {
                            let svc_name = k.as_str().unwrap_or_default().to_string();
                            if let Some(ports) = v["ports"].as_sequence() {
                                if let Some(port_str) = ports.first().and_then(|p| p.as_str()) {
                                    if let Ok(port) = port_str
                                        .split(':')
                                        .next_back()
                                        .unwrap_or("0")
                                        .parse::<u16>()
                                    {
                                        if port > 0 {
                                            services.insert(
                                                svc_name.clone(),
                                                ServiceConfig {
                                                    command: format!(
                                                        "docker compose up {svc_name}"
                                                    ),
                                                    port: Some(port),
                                                    env: None,
                                                    healthcheck: None,
                                                    ready_pattern: None,
                                                    depends_on: vec![],
                                                    port_fallback: None,
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            break 'compose;
        }
    }

    if services.is_empty() {
        return None;
    }

    Some(WorkspaceConfig {
        name,
        services,
        agent_templates: None,
        portforwards: vec![],
        ports: None,
    })
}

/// Generate a `.warpforge/workspace.yaml` file in the given directory.
/// If auto-detection finds services, pre-populates them. Refuses to run when
/// any config (new or legacy location) already exists.
pub fn generate_workspace_yaml(project_path: &Path) -> anyhow::Result<()> {
    for name in CONFIG_NAMES {
        let existing = project_path.join(name);
        if existing.exists() {
            anyhow::bail!("config already exists at {}", existing.display());
        }
    }
    let target = project_path.join(CONFIG_NAMES[0]);

    let name = project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf())
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let content = if let Some(config) = auto_detect(project_path) {
        // Serialize detected config
        let yaml = serde_yaml::to_string(&config)?;
        format!("# .warpforge/workspace.yaml — auto-detected by warpforge\n{yaml}")
    } else {
        // Write template
        format!(
            r#"# .warpforge/workspace.yaml — Warpforge project configuration
name: {name}

services:
  app:
    command: npm run dev
    port: 3000
    # env:
    #   DATABASE_URL: postgres://localhost:${{db.port}}/mydb
    # healthcheck:
    #   url: http://localhost:${{app.port}}/api/health
    #   interval: 5s

# agentTemplates:
#   dev:
#     command: claude
#     description: "Interactive development session"
"#
        )
    };

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    fs::write(&target, content)?;
    println!("Created {}", target.display());
    Ok(())
}

/// Parse an inclusive range string: `"4200-4299"`, or a bare `"4200"`
/// meaning start with the default range size (100).
/// Rejects inverted/zero-width ranges and privileged starts (< 1024).
pub fn parse_range(s: &str) -> Option<(u16, u16)> {
    const DEFAULT_RANGE_SIZE: u16 = 100;
    let (start_str, end) = match s.split_once('-') {
        Some((start, end)) => (start, end.parse::<u16>().ok()?),
        None => (
            s,
            s.parse::<u16>().ok()?.checked_add(DEFAULT_RANGE_SIZE - 1)?,
        ),
    };
    let start = start_str.parse::<u16>().ok()?;
    if start < 1024 || end <= start {
        return None;
    }
    Some((start, end))
}

/// Parse human-readable interval string ("5s", "100ms", "2m") to milliseconds.
#[allow(dead_code)]
pub fn parse_interval_ms(interval: &str) -> u64 {
    let (num_str, unit) = if let Some(stripped) = interval.strip_suffix("ms") {
        (stripped, "ms")
    } else if let Some(stripped) = interval.strip_suffix('s') {
        (stripped, "s")
    } else if let Some(stripped) = interval.strip_suffix('m') {
        (stripped, "m")
    } else {
        return 5000;
    };
    let num: u64 = match num_str.parse() {
        Ok(n) => n,
        Err(_) => return 5000,
    };
    match unit {
        "ms" => num,
        "s" => num * 1000,
        "m" => num * 60_000,
        _ => 5000,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_accepts_explicit_range() {
        assert_eq!(parse_range("4200-4299"), Some((4200, 4299)));
    }

    #[test]
    fn parse_range_accepts_bare_start_with_default_size() {
        assert_eq!(parse_range("4200"), Some((4200, 4299)));
    }

    #[test]
    fn parse_range_rejects_inverted_range() {
        assert_eq!(parse_range("4299-4200"), None);
    }

    #[test]
    fn parse_range_rejects_zero_width_range() {
        assert_eq!(parse_range("4200-4200"), None);
    }

    #[test]
    fn parse_range_rejects_privileged_start() {
        assert_eq!(parse_range("80-179"), None);
        assert_eq!(parse_range("80"), None);
        assert_eq!(parse_range("1023-1100"), None);
    }

    #[test]
    fn parse_range_accepts_lowest_legal_start() {
        assert_eq!(parse_range("1024-1123"), Some((1024, 1123)));
    }

    #[test]
    fn parse_range_rejects_garbage() {
        assert_eq!(parse_range(""), None);
        assert_eq!(parse_range("abc"), None);
        assert_eq!(parse_range("4200-"), None);
        assert_eq!(parse_range("70000"), None);
    }

    #[test]
    fn parse_range_rejects_start_that_overflows_default_size() {
        assert_eq!(parse_range("65500"), None);
        assert_eq!(parse_range("65535"), None);
    }
}
