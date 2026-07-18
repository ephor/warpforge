use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceRuntimeKind {
    Local,
    DockerCompose,
    Kubernetes,
    Mixed,
}

impl ServiceRuntimeKind {
    pub fn label(&self) -> &str {
        match self {
            Self::Local => "local",
            Self::DockerCompose => "docker-compose",
            Self::Kubernetes => "kubernetes",
            Self::Mixed => "mixed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct UserRuntimeAnswers {
    pub agent: String,
    pub runtime_kind: ServiceRuntimeKind,
    pub compose_path: String,
    pub k8s_manifests_path: String,
    pub k8s_helm_file: String,
    pub k8s_release_names: String,
    pub k8s_namespace: String,
    pub dev_commands: String,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct BootstrapContext {
    pub repo_summary: String,
    pub existing_config_yaml: String,
    pub user_answers: UserRuntimeAnswers,
    pub project_path: String,
}

// ── Repo Summary ─────────────────────────────────────────────────────────────

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
];

const KEY_FILES: &[&str] = &[
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "vite.config.js",
    "next.config.js",
    "next.config.mjs",
    "nuxt.config.ts",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "Dockerfile",
    "Makefile",
    "CMakeLists.txt",
    "pnpm-workspace.yaml",
    "Chart.yaml",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    ".env",
    ".env.example",
];

pub fn build_repo_summary(project_path: &str) -> String {
    let path = Path::new(project_path);
    let mut out = String::new();

    // File tree (max 3 levels, skip junk)
    out.push_str("## File tree\n\n");
    let mut entries = Vec::new();
    collect_tree(path, 0, 3, &mut entries);
    for e in &entries {
        out.push_str(e);
        out.push('\n');
    }
    out.push('\n');

    // Key files
    out.push_str("## Key files\n\n");
    for name in KEY_FILES {
        let file = path.join(name);
        if file.exists() {
            if let Ok(content) = std::fs::read_to_string(&file) {
                let truncated = truncate_file_content(&content, 2000);
                out.push_str(&format!("### {name}\n\n```\n{truncated}\n```\n\n"));
            }
        }
    }

    // docker-compose services summary
    for compose_name in &[
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ] {
        let compose_path = path.join(compose_name);
        if compose_path.exists() {
            if let Ok(text) = std::fs::read_to_string(&compose_path) {
                if let Ok(compose) = serde_yaml::from_str::<serde_yaml::Value>(&text) {
                    if let Some(svcs) = compose["services"].as_mapping() {
                        out.push_str(&format!("### {compose_name} services\n\n"));
                        for (k, v) in svcs {
                            let svc_name = k.as_str().unwrap_or("?");
                            let ports = v["ports"]
                                .as_sequence()
                                .map(|p| {
                                    p.iter()
                                        .filter_map(|x| x.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                })
                                .unwrap_or_default();
                            let image = v["image"].as_str().unwrap_or("");
                            out.push_str(&format!("- {svc_name}: image={image} ports=[{ports}]\n"));
                        }
                        out.push('\n');
                    }
                }
            }
            break;
        }
    }

    out
}

fn collect_tree(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<String>) {
    if depth > max_depth {
        return;
    }
    let Ok(read) = dir.read_dir() else {
        return;
    };
    let indent = "  ".repeat(depth);
    let mut entries: Vec<String> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && depth == 0 && name != ".env" && name != ".env.example" {
            continue;
        }
        if entry.path().is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            entries.push(format!("{indent}{name}/"));
            collect_tree(&entry.path(), depth + 1, max_depth, out);
        } else {
            entries.push(format!("{indent}{name}"));
        }
    }
    entries.sort();
    out.extend(entries);
}

fn truncate_file_content(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars {
        content.to_string()
    } else {
        format!("{}... ({} bytes total)", &content[..max_chars], content.len())
    }
}

// ── Prompt Builders ───────────────────────────────────────────────────────────

pub fn build_system_prompt(ctx: &BootstrapContext) -> String {
    let runtime_desc = match ctx.user_answers.runtime_kind {
        ServiceRuntimeKind::DockerCompose => {
            "Services run via `docker compose up`. \
             The daemon should invoke `docker compose up -d <service>` for each."
        }
        ServiceRuntimeKind::Kubernetes => {
            "Dependencies live in Kubernetes. Expose them with `portforwards` \
             entries (namespace/pod/localPort/remotePort) — the daemon runs \
             `kubectl port-forward` for each. Local app processes still go under \
             `services`."
        }
        ServiceRuntimeKind::Mixed => {
            "Some things run locally, some in Docker, some in Kubernetes. Local \
             app processes and `docker compose` commands go under `services`; \
             Kubernetes dependencies go under `portforwards` \
             (namespace/pod/localPort/remotePort). Never put `kubectl` in a \
             service command."
        }
        ServiceRuntimeKind::Local => {
            "Services are expected to run as local processes \
             (e.g., `npm run dev`, `node server.js`, `bun dev`)."
        }
    };

    let dev_cmds: String = ctx
        .user_answers
        .dev_commands
        .split(',')
        .map(|c| format!("- {}", c.trim()))
        .filter(|c| !c.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let notes = if ctx.user_answers.notes.is_empty() {
        "(none)"
    } else {
        &ctx.user_answers.notes
    };

    format!(
        r#"You are configuring a Warpforge workspace for AI coding agents.

Warpforge has a local Rust daemon that:
- Owns projects, services, and their lifecycle.
- Starts services as OS processes based on a YAML config (.warpforge.yaml).
- Tracks dependencies: a service will only start after all "dependsOn" are ready.
- Detects readiness via:
  - "readyPattern": a regex matched against captured logs, OR
  - process exit status for one-shot commands.
- Manages port isolation: each project gets a dedicated port range starting at 4000.
  - If a service declares "port", Warpforge picks a free port in that range.
  - The resolved port is available as ${{service.port}} in env variables.
- Manages "portforwards" (usually for Kubernetes) as long-running processes
  (e.g., using "kubectl port-forward"), restarts them with backoff if they drop.

## Runtime kind
{runtime_desc}

## Dev commands
{dev_cmds}

## User notes
{notes}
"#
    )
}

pub fn build_user_prompt(ctx: &BootstrapContext) -> String {
    let mut prompt = format!(
        r#"Here is the repository summary:
{repo_summary}

Here is the current .warpforge.yaml (may be a minimal default):
{existing_config}

## .warpforge.yaml schema — follow it EXACTLY

name: <project-name>              # required, string

services:                         # a MAP keyed by service name (NOT a list)
  <service-name>:
    command: <shell command>      # required; started from the project root by the daemon
    port: <number>                # optional; local port the service should listen on
    readyPattern: <regex>         # optional; matched against the service's stdout to detect "ready"
    dependsOn: [<name>, ...]      # optional; service/portforward names that must be ready first
    env:                          # optional
      KEY: value

portforwards:                     # a LIST; each is a kubectl port-forward the daemon runs for you
  - name: <label>                 # optional label (referenced by services' dependsOn)
    namespace: <k8s namespace>    # required
    pod: <pod name or prefix>     # required; the daemon finds the first pod matching this prefix
    localPort: <number>           # required; port exposed on localhost
    remotePort: <number>          # required; port on the pod

Hard rules:
- A portforward has ONLY these fields: name, namespace, pod, localPort, remotePort.
  It NEVER has `command`, `port`, or `dependsOn`. Do NOT write `kubectl ...`
  anywhere — the daemon builds the kubectl invocation from those fields.
- `services` is a map keyed by name, not a list.
- Put local app processes (bun/npm/pnpm dev, servers, workers, `docker compose`
  commands) under `services`. Put remote/Kubernetes dependencies reachable via
  `kubectl port-forward` under `portforwards`.

Example of a valid file:

name: my-app
services:
  api:
    command: cd apps/api && bun run dev
    port: 4000
    readyPattern: "Listening on"
    dependsOn: [postgres]
  web:
    command: cd apps/web && bun run dev
    port: 3000
    readyPattern: "Local:"
    dependsOn: [api]
portforwards:
  - name: postgres
    namespace: postgres
    pod: postgres-cluster-pooler
    localPort: 5432
    remotePort: 5432

Task:
Write .warpforge.yaml for THIS repository following the schema above:
- Model every real service (frontend, backend, workers, etc.) under `services`
  with its actual dev command, a `port`, and a `readyPattern` taken from its
  real startup log line.
- Use `dependsOn` for correct startup order.
- Add `portforwards` for the Kubernetes/remote dependencies this project needs,
  using namespace/pod/localPort/remotePort — never a command.

Deliverable:
- Create or update `.warpforge.yaml` in the project root with your file-editing
  tools. It must exist on disk when you finish.
- Keep it valid YAML matching the schema, then summarize what you configured.
"#,
        repo_summary = ctx.repo_summary,
        existing_config = ctx.existing_config_yaml,
    );

    // Add runtime-specific context
    match ctx.user_answers.runtime_kind {
        ServiceRuntimeKind::DockerCompose => {
            prompt.push_str(&format!(
                "\nDocker Compose file: {}\n",
                ctx.user_answers.compose_path
            ));
            if let Ok(text) = std::fs::read_to_string(&ctx.user_answers.compose_path) {
                prompt.push_str(&format!(
                    "\nCompose file content:\n```yaml\n{text}\n```\n"
                ));
            }
        }
        ServiceRuntimeKind::Kubernetes | ServiceRuntimeKind::Mixed => {
            if !ctx.user_answers.k8s_helm_file.is_empty() {
                prompt.push_str(&format!(
                    "\nHelm chart/values file: {}\n",
                    ctx.user_answers.k8s_helm_file
                ));
                if let Ok(text) = std::fs::read_to_string(&ctx.user_answers.k8s_helm_file) {
                    prompt.push_str(&format!(
                        "\nHelm file content:\n```yaml\n{text}\n```\n"
                    ));
                }
            }
            if !ctx.user_answers.k8s_release_names.is_empty() {
                prompt.push_str(&format!(
                    "\nK8s release/service names: {}\n",
                    ctx.user_answers.k8s_release_names
                ));
            }
            if !ctx.user_answers.k8s_namespace.is_empty() {
                prompt.push_str(&format!(
                    "\nK8s namespace: {}\n",
                    ctx.user_answers.k8s_namespace
                ));
            }
            if !ctx.user_answers.k8s_manifests_path.is_empty() {
                prompt.push_str(&format!(
                    "\nK8s manifests directory: {}\n",
                    ctx.user_answers.k8s_manifests_path
                ));
                let manifests_dir = std::path::Path::new(&ctx.user_answers.k8s_manifests_path);
                if manifests_dir.is_dir() {
                    prompt.push_str("\nManifest files found:\n");
                    if let Ok(read) = manifests_dir.read_dir() {
                        for entry in read.flatten().take(20) {
                            let name = entry.file_name();
                            let name_str = name.to_string_lossy();
                            if name_str.ends_with(".yaml") || name_str.ends_with(".yml") {
                                prompt.push_str(&format!("- {name_str}\n"));
                                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                                    let truncated = truncate_file_content(&text, 500);
                                    prompt.push_str(&format!(
                                        "  ```yaml\n  {truncated}\n  ```\n"
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }

    prompt
}

// ── YAML Validation ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ValidationIssue {
    pub severity: IssueSeverity,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueSeverity {
    Error,
    Warning,
}

pub fn validate_config_yaml(yaml_str: &str) -> Result<(crate::config::WorkspaceConfig, Vec<ValidationIssue>), String> {
    let config: crate::config::WorkspaceConfig =
        serde_yaml::from_str(yaml_str).map_err(|e| format!("YAML parse error: {e}"))?;

    let mut issues = Vec::new();

    if config.name.is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: "Missing project name".into(),
        });
    }

    // A dependency may name another service or a portforward (services often
    // wait on a kubectl port-forward before starting).
    let pf_names: std::collections::HashSet<&str> = config
        .portforwards
        .iter()
        .filter_map(|pf| pf.name.as_deref())
        .collect();
    for (name, svc) in &config.services {
        if svc.command.is_empty() {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Service '{name}' has empty command"),
            });
        }
        for dep in &svc.depends_on {
            if !config.services.contains_key(dep.as_str()) && !pf_names.contains(dep.as_str()) {
                issues.push(ValidationIssue {
                    severity: IssueSeverity::Error,
                    message: format!("Service '{name}' depends on unknown service '{dep}'"),
                });
            }
        }
    }

    for pf in &config.portforwards {
        if pf.pod.is_empty() {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Port-forward '{}' has empty pod", pf.name.as_deref().unwrap_or("(unnamed)")),
            });
        }
        if pf.local_port == 0 && pf.remote_port == 0 {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Warning,
                message: format!("Port-forward '{}' has no ports configured", pf.name.as_deref().unwrap_or("(unnamed)")),
            });
        }
    }

    Ok((config, issues))
}

pub fn extract_yaml_from_response(response: &str) -> String {
    // Strip markdown code fences if present
    let trimmed = response.trim();
    let stripped = if trimmed.starts_with("```yaml") {
        trimmed.strip_prefix("```yaml").unwrap_or(trimmed)
    } else if trimmed.starts_with("```") {
        trimmed.strip_prefix("```").unwrap_or(trimmed)
    } else {
        trimmed
    };
    let stripped = if stripped.ends_with("```") {
        stripped.strip_suffix("```").unwrap_or(stripped)
    } else {
        stripped
    };
    stripped.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_yaml_from_response() {
        let input = "```yaml\nname: test\nservices: {}\n```";
        let output = extract_yaml_from_response(input);
        assert_eq!(output, "name: test\nservices: {}");
    }

    #[test]
    fn test_extract_yaml_no_fences() {
        let input = "name: test\nservices: {}";
        let output = extract_yaml_from_response(input);
        assert_eq!(output, "name: test\nservices: {}");
    }

    #[test]
    fn test_validate_config_empty_name() {
        let yaml = "name: \"\"\nservices: {}";
        let result = validate_config_yaml(yaml);
        assert!(result.is_ok());
        let (_, issues) = result.unwrap();
        assert!(issues.iter().any(|i| i.severity == IssueSeverity::Error));
    }
}
