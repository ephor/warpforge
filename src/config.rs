use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceHealthcheck {
    pub url: String,
    pub interval: String,
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
        result.push(name.to_string());
    }

    let mut names: Vec<String> = config.services.keys().cloned().collect();
    names.sort();
    for name in &names {
        visit(name, config, &mut visited, &mut result, 0);
    }
    result
}

pub fn load_workspace_config(project_path: &Path) -> Option<WorkspaceConfig> {
    let config_path = project_path.join(".workspace.yaml");
    if config_path.exists() {
        let text = fs::read_to_string(&config_path).ok()?;
        return serde_yaml::from_str(&text).ok();
    }
    auto_detect(project_path)
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
                if let Ok(compose) =
                    serde_yaml::from_str::<serde_yaml::Value>(&text)
                {
                    if let Some(svcs) = compose["services"].as_mapping() {
                        for (k, v) in svcs {
                            let svc_name = k.as_str().unwrap_or_default().to_string();
                            if let Some(ports) = v["ports"].as_sequence() {
                                if let Some(port_str) = ports.first().and_then(|p| p.as_str()) {
                                    if let Ok(port) =
                                        port_str.split(':').last().unwrap_or("0").parse::<u16>()
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
    })
}

/// Generate a .workspace.yaml file in the given directory.
/// If auto-detection finds services, pre-populates them.
pub fn generate_workspace_yaml(project_path: &Path) -> anyhow::Result<()> {
    let target = project_path.join(".workspace.yaml");
    if target.exists() {
        anyhow::bail!(".workspace.yaml already exists at {}", target.display());
    }

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
        format!("# .workspace.yaml — auto-detected by warpforge\n{yaml}")
    } else {
        // Write template
        format!(
            r#"# .workspace.yaml — Warpforge project configuration
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

    fs::write(&target, content)?;
    println!("Created {}", target.display());
    Ok(())
}

/// Parse human-readable interval string ("5s", "100ms", "2m") to milliseconds.
#[allow(dead_code)]
pub fn parse_interval_ms(interval: &str) -> u64 {
    let (num_str, unit) = if interval.ends_with("ms") {
        (&interval[..interval.len() - 2], "ms")
    } else if interval.ends_with('s') {
        (&interval[..interval.len() - 1], "s")
    } else if interval.ends_with('m') {
        (&interval[..interval.len() - 1], "m")
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
