use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceRuntimeKind {
    Local,
    DockerCompose,
    Kubernetes,
    Mixed,
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
    "coverage",
    "generated",
    ".turbo",
    ".astro",
    ".keycloakify",
    "dist_keycloak",
    ".next",
    ".nuxt",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
];

const KEY_FILES: &[&str] = &[
    "package.json",
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
    "lerna.json",
    "turbo.json",
    "nx.json",
    "Procfile",
    "docker-bake.hcl",
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

    // Show the workspace skeleton, not application source/generated files.
    // Package scripts and focused excerpts below carry the service evidence.
    out.push_str("## File tree\n\n");
    let mut entries = Vec::new();
    collect_tree(path, path, 0, 1, &mut entries);
    if entries.len() > 250 {
        entries.truncate(250);
        entries.push("... (file tree limited to 250 entries)".into());
    }
    for e in &entries {
        out.push_str(e);
        out.push('\n');
    }
    out.push('\n');

    let mut key_files = Vec::new();
    collect_key_files(path, 0, 5, &mut key_files);
    key_files.sort_by(|left, right| {
        config_evidence_priority(left)
            .cmp(&config_evidence_priority(right))
            .then_with(|| left.cmp(right))
    });

    // Only runnable packages matter here; build-only libraries overwhelm large
    // monorepos without helping the agent discover services.
    out.push_str("## Runnable package scripts\n\n");
    let mut package_count = 0;
    for summary in key_files
        .iter()
        .filter(|file| file.file_name().and_then(|n| n.to_str()) == Some("package.json"))
        .filter_map(|file| summarize_package_json(path, file))
        .take(30)
    {
        out.push_str(&summary);
        package_count += 1;
    }
    if package_count == 0 {
        out.push_str("(none found)\n\n");
    }

    // docker-compose services summary (commands, dependencies, and port
    // mappings are more useful than a blind excerpt for service discovery).
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
                            let command = yaml_scalar_or_sequence(&v["command"]);
                            let depends_on = yaml_keys_or_sequence(&v["depends_on"]);
                            out.push_str(&format!(
                                "- {svc_name}: image={image} command={command} ports=[{ports}] dependsOn=[{depends_on}]\n"
                            ));
                        }
                        out.push('\n');
                    }
                }
            }
            break;
        }
    }

    out.push_str("## Runtime evidence excerpts\n\n");
    for file in key_files
        .iter()
        .filter(|file| should_excerpt_config(file))
        .take(24)
    {
        if let Ok(content) = std::fs::read_to_string(file) {
            let relative = file.strip_prefix(path).unwrap_or(file).display();
            let file_name = file
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let content = if file_name.starts_with(".env") {
                focused_env_excerpt(&content)
            } else if file_name.starts_with("vite.config.") || is_runnable_package_entrypoint(file)
            {
                focused_source_excerpt(&content)
            } else {
                content
            };
            if content.trim().is_empty() {
                continue;
            }
            let max_chars = 3_000;
            let truncated = truncate_file_content(&content, max_chars);
            out.push_str(&format!("### {relative}\n\n```\n{truncated}\n```\n\n"));
        }
    }

    truncate_file_content(&out, 32_000)
}

fn collect_tree(root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<String>) {
    if depth > max_depth {
        return;
    }
    let Ok(read) = dir.read_dir() else {
        return;
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && depth == 0 && name != ".env" && name != ".env.example" {
            continue;
        }
        if file_type.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .unwrap_or(&entry.path())
                .display()
                .to_string();
            out.push(format!("{relative}/"));
            collect_tree(root, &entry.path(), depth + 1, max_depth, out);
        } else if depth == 0 {
            let relative = entry
                .path()
                .strip_prefix(root)
                .unwrap_or(&entry.path())
                .display()
                .to_string();
            out.push(relative);
        }
    }
}

fn collect_key_files(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<std::path::PathBuf>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(read) = dir.read_dir() else {
        return;
    };
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                collect_key_files(&path, depth + 1, max_depth, out);
            }
        } else if KEY_FILES.contains(&name.as_str())
            || name.starts_with("vite.config.")
            || safe_env_evidence_file(&name)
            || is_runnable_package_entrypoint(&path)
        {
            out.push(path);
        }
    }
}

fn summarize_package_json(root: &Path, file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let package: serde_json::Value = serde_json::from_str(&text).ok()?;
    let relative_path = file.strip_prefix(root).unwrap_or(file);
    let relative = relative_path.display();
    let name = package["name"].as_str().unwrap_or("(unnamed)");
    let package_manager = package["packageManager"].as_str().unwrap_or("");
    let mut out = format!("### {relative}\nname: {name}\n");
    if !package_manager.is_empty() {
        out.push_str(&format!("packageManager: {package_manager}\n"));
    }
    if let Some(scripts) = package["scripts"].as_object() {
        let mut scripts: Vec<_> = scripts
            .iter()
            .filter(|(script, _)| runtime_script_name(script))
            .collect();
        if scripts.is_empty() && relative_path != Path::new("package.json") {
            return None;
        }
        scripts.sort_by_key(|(name, _)| *name);
        out.push_str("scripts:\n");
        for (script, command) in scripts {
            if let Some(command) = command.as_str() {
                out.push_str(&format!("- {script}: {command}\n"));
            }
        }
    } else {
        out.push_str("scripts: (none)\n");
    }
    out.push('\n');
    Some(out)
}

fn runtime_script_name(name: &str) -> bool {
    name == "dev"
        || name.starts_with("dev:")
        || name == "start"
        || name.starts_with("start:")
        || name == "serve"
        || name.starts_with("serve:")
        || name == "preview"
        || name.starts_with("port-forward")
}

fn config_evidence_priority(path: &Path) -> u8 {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.ends_with(".example") {
        1
    } else if name.starts_with("vite.config.") {
        2
    } else if name.starts_with(".env") {
        3
    } else if is_runnable_package_entrypoint(path) {
        4
    } else if matches!(
        name,
        "docker-compose.yml" | "docker-compose.yaml" | "compose.yml" | "compose.yaml"
    ) {
        5
    } else if name == "package.json" {
        6
    } else {
        7
    }
}

fn should_excerpt_config(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    name != "package.json"
        && (safe_env_evidence_file(name)
            || name.starts_with("vite.config.")
            || is_runnable_package_entrypoint(path)
            || matches!(
                name,
                "Procfile" | "Makefile" | "pyproject.toml" | "Cargo.toml" | "go.mod"
            ))
}

fn safe_env_evidence_file(name: &str) -> bool {
    name.starts_with(".env") && (!name.contains(".local") || name.ends_with(".example"))
}

fn is_runnable_package_entrypoint(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !matches!(name, "main.ts" | "index.ts") {
        return false;
    }
    let Some(source_dir) = path.parent() else {
        return false;
    };
    if source_dir.file_name().and_then(|name| name.to_str()) != Some("src") {
        return false;
    }
    let Some(package_root) = source_dir.parent() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(package_root.join("package.json")) else {
        return false;
    };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    package["scripts"]
        .as_object()
        .is_some_and(|scripts| scripts.keys().any(|name| runtime_script_name(name)))
}

fn redact_env_content(content: &str) -> String {
    let mut output = Vec::new();
    let mut inside_private_key = false;

    for line in content.lines() {
        if inside_private_key {
            if line.contains("END PRIVATE KEY") {
                inside_private_key = false;
            }
            continue;
        }

        let Some((key, separator, value)) = split_env_assignment(line) else {
            if line.contains("BEGIN PRIVATE KEY") {
                output.push("<redacted private key>".to_string());
                inside_private_key = !line.contains("END PRIVATE KEY");
            } else {
                output.push(line.to_string());
            }
            continue;
        };
        let upper = key.to_ascii_uppercase();
        if [
            "PASSWORD",
            "SECRET",
            "TOKEN",
            "PRIVATE_KEY",
            "ACCESS_KEY",
            "API_KEY",
        ]
        .iter()
        .any(|marker| upper.contains(marker))
        {
            output.push(format!("{key}{separator}<redacted>"));
            inside_private_key = value.contains("BEGIN PRIVATE KEY")
                && !value.contains("END PRIVATE KEY")
                && !value.contains("\\n");
            continue;
        }
        if let (Some(scheme), Some(at)) = (value.find("://"), value.rfind('@')) {
            if at > scheme + 3 {
                output.push(format!(
                    "{key}{separator}{}<redacted>@{}",
                    &value[..scheme + 3],
                    &value[at + 1..]
                ));
                continue;
            }
        }
        output.push(line.to_string());
    }

    output.join("\n")
}

fn focused_env_excerpt(content: &str) -> String {
    redact_env_content(content)
        .lines()
        .filter(|line| {
            let Some((key, _, value)) = split_env_assignment(line) else {
                return false;
            };
            let upper_key = key.to_ascii_uppercase();
            let lower_value = value.to_ascii_lowercase();
            upper_key.contains("PORT")
                || lower_value.contains("localhost")
                || lower_value.contains("127.0.0.1")
                || lower_value.contains("0.0.0.0")
                || ((upper_key.ends_with("_URL") || upper_key.ends_with("_ENDPOINT"))
                    && value.starts_with('/'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_env_assignment(line: &str) -> Option<(&str, char, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let separator_index = match (trimmed.find('='), trimmed.find(':')) {
        (Some(equal), Some(colon)) => equal.min(colon),
        (Some(equal), None) => equal,
        (None, Some(colon)) => colon,
        (None, None) => return None,
    };
    let key = trimmed[..separator_index].trim();
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    let separator = trimmed.as_bytes()[separator_index] as char;
    Some((key, separator, trimmed[separator_index + 1..].trim()))
}

fn focused_source_excerpt(content: &str) -> String {
    let lines: Vec<_> = content.lines().collect();
    let mut selected = BTreeSet::new();
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        let port_evidence = lower.contains("process.env.port")
            || lower.contains("import.meta.env.port")
            || lower.contains("const port")
            || lower.contains("let port")
            || lower.contains("var port")
            || lower.contains("port:")
            || lower.contains("port =")
            || lower.contains("--port")
            || lower.contains("server.port")
            || lower.contains("${port}")
            || lower.contains("\"port\"")
            || lower.contains("'port'");
        let readiness_evidence = (lower.contains("logger.") || lower.contains("console.log"))
            && (lower.contains("listen") || lower.contains("ready") || lower.contains("started"));
        if port_evidence || lower.contains(".listen(") || readiness_evidence {
            let start = index.saturating_sub(2);
            let end = (index + 2).min(lines.len().saturating_sub(1));
            selected.extend(start..=end);
        }
    }
    if selected.is_empty() {
        return truncate_file_content(content, 3_000);
    }

    let mut out = String::new();
    let mut previous = None;
    for index in selected {
        if previous.is_some_and(|previous| index > previous + 1) {
            out.push_str("...\n");
        }
        out.push_str(&format!("{}: {}\n", index + 1, lines[index]));
        previous = Some(index);
    }
    out
}

fn focused_helm_excerpt(content: &str) -> String {
    let lines: Vec<_> = content.lines().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < lines.len() {
        if !lines[index].starts_with("  - name:") {
            index += 1;
            continue;
        }

        out.push_str(lines[index].trim_start());
        out.push('\n');
        index += 1;
        let mut inside_needs = false;
        while index < lines.len() && !lines[index].starts_with("  - name:") {
            let trimmed = lines[index].trim_start();
            let indentation = lines[index].len() - trimmed.len();
            if indentation <= 4 && !trimmed.is_empty() && !trimmed.starts_with("needs:") {
                inside_needs = false;
            }
            if trimmed.starts_with("needs:") {
                inside_needs = true;
            }
            if trimmed.starts_with("namespace:")
                || trimmed.starts_with("chart:")
                || trimmed.starts_with("needs:")
                || (inside_needs && indentation >= 6 && trimmed.starts_with("- "))
            {
                out.push_str("  ");
                out.push_str(trimmed);
                out.push('\n');
            }
            index += 1;
        }
    }

    if out.is_empty() {
        truncate_file_content(content, 3_000)
    } else {
        out
    }
}

fn yaml_scalar_or_sequence(value: &serde_yaml::Value) -> String {
    if let Some(value) = value.as_str() {
        value.to_string()
    } else if let Some(values) = value.as_sequence() {
        values
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    }
}

fn yaml_keys_or_sequence(value: &serde_yaml::Value) -> String {
    if let Some(values) = value.as_sequence() {
        values
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    } else if let Some(values) = value.as_mapping() {
        values
            .keys()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    } else {
        String::new()
    }
}

fn truncate_file_content(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars {
        content.to_string()
    } else {
        let boundary = (0..=max_chars)
            .rev()
            .find(|index| content.is_char_boundary(*index))
            .unwrap_or(0);
        format!(
            "{}... ({} bytes total)",
            &content[..boundary],
            content.len()
        )
    }
}

// ── Prompt Builders ───────────────────────────────────────────────────────────

pub fn build_system_prompt(ctx: &BootstrapContext) -> String {
    let runtime_desc = match ctx.user_answers.runtime_kind {
        ServiceRuntimeKind::DockerCompose => "Use `docker compose` commands for containers.",
        ServiceRuntimeKind::Kubernetes => {
            "Put local app processes in `services` and Kubernetes dependencies in `portforwards`."
        }
        ServiceRuntimeKind::Mixed => {
            "Put local processes and Docker Compose commands in `services`; put Kubernetes dependencies in `portforwards`."
        }
        ServiceRuntimeKind::Local => "Use local development processes such as package scripts, servers, and workers.",
    };

    let dev_cmds: String = ctx
        .user_answers
        .dev_commands
        .split([',', '\n'])
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
        r#"Create one valid Warpforge YAML configuration from repository evidence and the user's answers.

Runtime: {runtime_desc}
User-supplied commands:
{dev_cmds}
User notes: {notes}

Runtime facts:
- `service.port` is the app's real/default listening port from its code or config, not a requested Warpforge runtime-port number. A nonzero value enables managed allocation: Warpforge chooses a free port in the project's 100-port range, injects it as `PORT`, and resolves `${{service.port}}` references. Use it only when the process honors `PORT` directly or through its command.
- Repeated `service.port` defaults are allowed because each service receives its own allocated runtime port. Do not renumber services merely to make declared defaults unique.
- A declared service-port default does not reserve that exact runtime port and may equal a fixed port-forward localPort. Never omit `service.port` merely because the same number appears elsewhere; allocation avoids the collision.
- Warpforge interpolates `${{other-service.port}}` only inside a service's YAML `env`. It does not rewrite repository `.env*` files. Override localhost URLs there when one local service consumes another dynamically allocated service.
- `portforwards[].localPort` is fixed and must be unique among port-forwards. Warpforge runs and restarts `kubectl port-forward`; never put `kubectl` in a service command.
- `readyPattern` is a case-sensitive literal substring matched against stdout or stderr, not a regex. Use a stable fragment emitted only after initialization.
- `dependsOn` may reference service names or named port-forwards.
- Workers and consumers are long-running services. Omit `port` unless they listen; depend on their broker/database and use an initialization-log `readyPattern` when one exists.
- The schema has no variant condition. Include clearly named services for each requested variant and add short YAML comments; never invent conditional fields.
- Treat files explicitly named in user notes as primary evidence: inspect them with repository tools before deciding services, ports, or dependencies.

Write the result to `.warpforge.yaml` in the repository root, then output the exact file contents with no Markdown fence or explanation. Do not guess commands, ports, Kubernetes names, or dependencies; omit unsupported optional fields and preserve useful existing values when evidence is inconclusive.
"#
    )
}

pub fn build_user_prompt(ctx: &BootstrapContext) -> String {
    let existing_config = truncate_file_content(&ctx.existing_config_yaml, 12_000);
    let existing_status = match validate_config_yaml(&ctx.existing_config_yaml) {
        Ok((_, issues))
            if issues
                .iter()
                .all(|issue| issue.severity != IssueSeverity::Error) =>
        {
            "Existing config is parseable. Preserve only fields supported by repository evidence."
        }
        _ => "Existing config is invalid migration input. Use it only as hints; do not copy unsupported shapes or fields.",
    };
    let service_scope = match ctx.user_answers.runtime_kind {
        ServiceRuntimeKind::DockerCompose => {
            "Add relevant local apps and Docker Compose services. Do not add Kubernetes port-forwards unless the user explicitly requests them."
        }
        ServiceRuntimeKind::Kubernetes => {
            "Add relevant local app processes and Kubernetes port-forwards. Do not add Docker Compose services unless the user explicitly requests them."
        }
        ServiceRuntimeKind::Mixed => {
            "Add relevant local app processes, requested Docker Compose services, and supported Kubernetes port-forwards."
        }
        ServiceRuntimeKind::Local => {
            "Add relevant local app processes. Do not add Docker Compose services or Kubernetes port-forwards unless the user explicitly requests them."
        }
    };
    let mut prompt = format!(
        r#"Repository root: {project_path}

Repository summary:
{repo_summary}

{existing_status}
{existing_config}

Schema (exact field names and shapes):

```yaml
name: <project-name>
services:                         # MAP, never a list
  <service-name>:
    command: <shell command>      # required; runs from repository root
    port: <number>                # optional; normal/default port; process must honor injected PORT
    readyPattern: <literal text>  # optional; case-sensitive log substring
    dependsOn: [<name>, ...]      # optional; service or named port-forward
    env:
      KEY: value
portforwards:                     # LIST, never a map
  - name: <label>
    namespace: <k8s namespace>
    pod: <pod name or prefix>
    localPort: <fixed localhost port>
    remotePort: <pod port>
```

Discovery checklist:
1. Find dev/start/worker commands in every workspace package.json, Makefile, Procfile, Compose file, Cargo metadata, and framework config. Prefer the repository's package-manager/filter syntax.
2. Trace ports from PORT/*_PORT defaults, listen(...)/bind(...), CLI --port, Compose mappings, Vite server.port, and .env.example. A hard-coded listener that ignores PORT is not safely managed: omit port rather than inventing a value.
3. Find readiness text in the log statement after listen/startup, framework startup output, or known command output. Copy a distinctive literal fragment such as "Local:" or "Listening on"; do not use regex syntax. Omit it if no reliable line exists.
4. Inspect `.env*` localhost URLs. When they point to another dynamically allocated local service, override that variable in YAML `env` with `${{service-name.port}}`; use literal ports for fixed port-forwards. Do not assume Warpforge edits repository env files.
5. {service_scope} Include runnable apps supported by root dev scripts, runtime manifests, or user answers; a package-level `dev` script alone is not proof that a demo, theme, or tool belongs in the workspace. Give every referenced port-forward a unique name and fixed localPort.
6. For every managed service port, trace all localhost consumers and override their URLs in YAML `env` with `${{service-name.port}}`. Do not keep a provider on a fixed default merely because a consumer's repository env uses that number.
7. Build acyclic dependsOn chains. Workers normally depend on brokers/databases and have no port. Do not model a remote dependency both as a service and a port-forward.

Before writing, verify the file against the schema above and the repository evidence.

Create or update `.warpforge.yaml`, then return its complete contents only. Keep proven useful fields from the current config; remove invalid or unsupported fields. Before responding, parse-check the file, verify services is a map and portforwards is a list, verify every dependency exists, verify the service graph is acyclic, and verify fixed port-forward local ports are unique.
"#,
        project_path = ctx.project_path,
        repo_summary = ctx.repo_summary,
        existing_status = existing_status,
        existing_config = existing_config,
        service_scope = service_scope,
    );

    let compose_runtime = matches!(
        ctx.user_answers.runtime_kind,
        ServiceRuntimeKind::DockerCompose | ServiceRuntimeKind::Mixed
    );
    if compose_runtime && !ctx.user_answers.compose_path.is_empty() {
        append_file_context(
            &mut prompt,
            "Docker Compose file",
            ctx,
            &ctx.user_answers.compose_path,
            8_000,
        );
    }

    let kubernetes_runtime = matches!(
        ctx.user_answers.runtime_kind,
        ServiceRuntimeKind::Kubernetes | ServiceRuntimeKind::Mixed
    );
    if kubernetes_runtime {
        if !ctx.user_answers.k8s_helm_file.is_empty() {
            append_file_context(
                &mut prompt,
                "Helm chart/values file",
                ctx,
                &ctx.user_answers.k8s_helm_file,
                3_000,
            );
        }
        if !ctx.user_answers.k8s_release_names.is_empty() {
            prompt.push_str(&format!(
                "\nKubernetes release/service names: {}\n",
                ctx.user_answers.k8s_release_names
            ));
        }
        if !ctx.user_answers.k8s_namespace.is_empty() {
            prompt.push_str(&format!(
                "\nKubernetes namespace: {}\n",
                ctx.user_answers.k8s_namespace
            ));
        }
        if !ctx.user_answers.k8s_manifests_path.is_empty() {
            let manifests_dir = resolve_user_path(ctx, &ctx.user_answers.k8s_manifests_path);
            prompt.push_str(&format!(
                "\nKubernetes manifests directory: {}\n",
                manifests_dir.display()
            ));
            if let Ok(read) = manifests_dir.read_dir() {
                let mut manifests: Vec<_> = read
                    .flatten()
                    .filter(|entry| {
                        matches!(
                            entry.path().extension().and_then(|ext| ext.to_str()),
                            Some("yaml" | "yml")
                        )
                    })
                    .collect();
                manifests.sort_by_key(|entry| entry.file_name());
                for entry in manifests.into_iter().take(10) {
                    if let Ok(text) = std::fs::read_to_string(entry.path()) {
                        prompt.push_str(&format!(
                            "\n### {}\n```yaml\n{}\n```\n",
                            entry.file_name().to_string_lossy(),
                            truncate_file_content(&text, 1_200)
                        ));
                    }
                }
            }
        }
    }

    prompt
}

fn resolve_user_path(ctx: &BootstrapContext, value: &str) -> std::path::PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(&ctx.project_path).join(path)
    }
}

fn append_file_context(
    prompt: &mut String,
    label: &str,
    ctx: &BootstrapContext,
    value: &str,
    max_chars: usize,
) {
    let path = resolve_user_path(ctx, value);
    prompt.push_str(&format!("\n{label}: {}\n", path.display()));
    if let Ok(text) = std::fs::read_to_string(path) {
        let evidence = if label.starts_with("Helm ") {
            focused_helm_excerpt(&text)
        } else {
            text
        };
        prompt.push_str(&format!(
            "```yaml\n{}\n```\n",
            truncate_file_content(&evidence, max_chars)
        ));
    }
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

pub fn validate_config_yaml(
    yaml_str: &str,
) -> Result<(crate::config::WorkspaceConfig, Vec<ValidationIssue>), String> {
    let config: crate::config::WorkspaceConfig =
        serde_yaml::from_str(yaml_str).map_err(|e| format!("YAML parse error: {e}"))?;

    let mut issues = Vec::new();
    if config.name.trim().is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: "Project name is required and cannot be blank.".into(),
        });
    }
    if config.services.is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Warning,
            message: "No services are configured.".into(),
        });
    }

    let mut portforward_names = HashSet::new();
    for (index, portforward) in config.portforwards.iter().enumerate() {
        let label = portforward
            .name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("#{}", index + 1));

        match portforward.name.as_deref().map(str::trim) {
            Some("") | None => issues.push(ValidationIssue {
                severity: IssueSeverity::Warning,
                message: format!(
                    "Port-forward {label} has no name, so services cannot reference it in dependsOn."
                ),
            }),
            Some(name) if !portforward_names.insert(name.to_string()) => {
                issues.push(ValidationIssue {
                    severity: IssueSeverity::Error,
                    message: format!(
                        "Port-forward name '{name}' is duplicated; every dependency target must be unambiguous."
                    ),
                });
            }
            Some(_) => {}
        }

        if portforward.namespace.trim().is_empty() {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Port-forward '{label}' requires a namespace."),
            });
        }
        if portforward.pod.trim().is_empty() {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Port-forward '{label}' requires a pod name or prefix."),
            });
        }
        if portforward.local_port == 0 {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Port-forward '{label}' localPort must be between 1 and 65535."),
            });
        }
        if portforward.remote_port == 0 {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Port-forward '{label}' remotePort must be between 1 and 65535."),
            });
        }
    }

    for (name, service) in &config.services {
        if service.command.trim().is_empty() {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Service '{name}' requires a non-empty command."),
            });
        }
        if service
            .ready_pattern
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Warning,
                message: format!(
                    "Service '{name}' has a blank readyPattern; remove it or use a literal startup-log substring."
                ),
            });
        }
        for dependency in &service.depends_on {
            if !config.services.contains_key(dependency)
                && !portforward_names.contains(dependency.as_str())
            {
                issues.push(ValidationIssue {
                    severity: IssueSeverity::Error,
                    message: format!(
                        "Service '{name}' depends on unknown target '{dependency}' (expected a service or named port-forward)."
                    ),
                });
            }
        }
    }

    for cycle in dependency_cycles(&config) {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: format!("Circular service dependency: {}.", cycle.join(" -> ")),
        });
    }

    let mut fixed_ports: BTreeMap<u16, Vec<String>> = BTreeMap::new();
    for (index, portforward) in config.portforwards.iter().enumerate() {
        if portforward.local_port > 0 {
            let label = portforward
                .name
                .clone()
                .unwrap_or_else(|| format!("#{}", index + 1));
            fixed_ports
                .entry(portforward.local_port)
                .or_default()
                .push(format!("port-forward '{label}'"));
        }
    }
    for (port, owners) in &fixed_ports {
        if owners.len() > 1 {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!(
                    "Fixed local port {port} is used by {}; port-forward localPort values must be unique.",
                    owners.join(" and ")
                ),
            });
        }
    }

    let mut requested_service_ports: BTreeMap<u16, Vec<String>> = BTreeMap::new();
    for (name, service) in &config.services {
        if let Some(port) = service.port.filter(|port| *port > 0) {
            requested_service_ports
                .entry(port)
                .or_default()
                .push(format!("service '{name}'"));
        }
    }
    for (port, owners) in &requested_service_ports {
        if owners.len() > 1 {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Warning,
                message: format!(
                    "Configured service port {port} is repeated by {}. Warpforge allocates distinct runtime ports, but each command must honor the injected PORT value.",
                    owners.join(" and ")
                ),
            });
        }
        if let Some(portforwards) = fixed_ports.get(port) {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Warning,
                message: format!(
                    "Configured service port {port} also appears as {}; verify the service honors injected PORT. Port-forward localPort is fixed.",
                    portforwards.join(" and ")
                ),
            });
        }
    }

    Ok((config, issues))
}

fn dependency_cycles(config: &crate::config::WorkspaceConfig) -> Vec<Vec<String>> {
    fn visit(
        name: &str,
        config: &crate::config::WorkspaceConfig,
        states: &mut HashMap<String, u8>,
        stack: &mut Vec<String>,
        seen_cycles: &mut HashSet<String>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        states.insert(name.to_string(), 1);
        stack.push(name.to_string());

        if let Some(service) = config.services.get(name) {
            for dependency in &service.depends_on {
                if !config.services.contains_key(dependency) {
                    continue;
                }
                match states.get(dependency).copied().unwrap_or(0) {
                    0 => visit(dependency, config, states, stack, seen_cycles, cycles),
                    1 => {
                        if let Some(start) = stack.iter().position(|item| item == dependency) {
                            let mut cycle = stack[start..].to_vec();
                            cycle.push(dependency.clone());
                            let key = cycle.join(" -> ");
                            if seen_cycles.insert(key) {
                                cycles.push(cycle);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        stack.pop();
        states.insert(name.to_string(), 2);
    }

    let mut names: Vec<_> = config.services.keys().cloned().collect();
    names.sort();
    let mut states = HashMap::new();
    let mut stack = Vec::new();
    let mut seen_cycles = HashSet::new();
    let mut cycles = Vec::new();
    for name in names {
        if states.get(&name).copied().unwrap_or(0) == 0 {
            visit(
                &name,
                config,
                &mut states,
                &mut stack,
                &mut seen_cycles,
                &mut cycles,
            );
        }
    }
    cycles
}

pub fn extract_yaml_from_response(response: &str) -> String {
    let trimmed = response.trim();
    for marker in ["```yaml", "```yml"] {
        if let Some(start) = trimmed.find(marker) {
            let content = &trimmed[start + marker.len()..];
            if let Some(end) = content.find("```") {
                return content[..end].trim().to_string();
            }
        }
    }

    // Some agents ignore the requested language tag. Prefer an untagged block
    // that at least resembles the expected root schema.
    let mut remainder = trimmed;
    while let Some(start) = remainder.find("```") {
        let content = &remainder[start + 3..];
        let Some(end) = content.find("```") else {
            break;
        };
        let candidate = content[..end].trim();
        if candidate.lines().any(|line| line.starts_with("name:"))
            && candidate.lines().any(|line| line.starts_with("services:"))
        {
            return candidate.to_string();
        }
        remainder = &content[end + 3..];
    }

    trimmed.to_string()
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
    fn test_extract_yaml_from_fence_with_surrounding_text() {
        let input = "Here is the config:\n```yaml\nname: test\nservices: {}\n```\nDone.";
        let output = extract_yaml_from_response(input);
        assert_eq!(output, "name: test\nservices: {}");
    }

    #[test]
    fn test_runtime_scripts_exclude_build_only_packages() {
        assert!(runtime_script_name("dev"));
        assert!(runtime_script_name("start:dev"));
        assert!(runtime_script_name("port-forward:ehealth"));
        assert!(!runtime_script_name("build"));
        assert!(!runtime_script_name("typecheck:watch"));
    }

    #[test]
    fn test_env_redaction_preserves_port_evidence() {
        let input = "PORT=4000\nPASSWORD=hunter2\nKEYCLOAK_PASSWORD: visible-secret\nGOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nkey-material\\n-----END PRIVATE KEY-----'\nDATABASE_URL=postgres://user:pass@localhost:5432/db";
        let output = redact_env_content(input);
        assert!(output.contains("PORT=4000"));
        assert!(output.contains("PASSWORD=<redacted>"));
        assert!(output.contains("KEYCLOAK_PASSWORD:<redacted>"));
        assert!(output.contains("GOOGLE_PRIVATE_KEY:<redacted>"));
        assert!(output.contains("postgres://<redacted>@localhost:5432/db"));
        assert!(!output.contains("hunter2"));
        assert!(!output.contains("visible-secret"));
        assert!(!output.contains("key-material"));
        assert!(!output.contains("user:pass"));
    }

    #[test]
    fn test_env_redaction_removes_multiline_private_key() {
        let input = "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----\nPORT=4000";
        let output = redact_env_content(input);
        assert_eq!(output, "PRIVATE_KEY=<redacted>\nPORT=4000");
    }

    #[test]
    fn test_env_excerpt_keeps_only_runtime_network_evidence() {
        let input = "PORT=4000\nAPI_URL=http://localhost:4001\nRELATIVE_URL=/graphql\nREMOTE_URL=https://example.com\nPASSWORD=secret\nFEATURE_FLAG=true";
        let output = focused_env_excerpt(input);
        assert!(output.contains("PORT=4000"));
        assert!(output.contains("API_URL=http://localhost:4001"));
        assert!(output.contains("RELATIVE_URL=/graphql"));
        assert!(!output.contains("REMOTE_URL"));
        assert!(!output.contains("PASSWORD"));
        assert!(!output.contains("FEATURE_FLAG"));
    }

    #[test]
    fn test_source_excerpt_keeps_port_and_readiness_context() {
        let input = "import x from 'x';\nconst unrelated = true;\nconst port = process.env.PORT || 4000;\nawait app.listen(port);\nlogger.info(`Listening on ${port}`);\nconst tail = true;";
        let output = focused_source_excerpt(input);
        assert!(output.contains("process.env.PORT"));
        assert!(output.contains("app.listen"));
        assert!(output.contains("Listening on"));
    }

    #[test]
    fn test_source_excerpt_does_not_treat_import_as_port_evidence() {
        let input = "import { something } from 'somewhere';\nconst unrelated = true;";
        let output = focused_source_excerpt(input);
        assert_eq!(output, input);
    }

    #[test]
    fn test_helm_excerpt_compacts_release_evidence() {
        let input = r#"environments:
  develop: {}
releases:
  - name: api
    namespace: platform
    chart: charts/app
    needs:
      - kafka/config
      - postgres
    values:
      - irrelevant.yaml
  - name: web
    namespace: platform
    chart: charts/app
    needs:
      - api
"#;
        let output = focused_helm_excerpt(input);
        assert!(output.contains("- name: api"));
        assert!(output.contains("namespace: platform"));
        assert!(output.contains("- kafka/config"));
        assert!(output.contains("- name: web"));
        assert!(!output.contains("irrelevant.yaml"));
    }

    #[test]
    fn test_validate_config_empty_name() {
        let yaml = "name: \"\"\nservices: {}";
        let result = validate_config_yaml(yaml);
        assert!(result.is_ok());
        let (_, issues) = result.unwrap();
        assert!(issues.iter().any(|i| i.severity == IssueSeverity::Error));
    }

    #[test]
    fn test_validate_config_rejects_dependency_cycle() {
        let yaml = r#"
name: test
services:
  api:
    command: api
    dependsOn: [worker]
  worker:
    command: worker
    dependsOn: [api]
"#;
        let (_, issues) = validate_config_yaml(yaml).unwrap();
        assert!(issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error
                && issue.message.contains("Circular service dependency")
        }));
    }

    #[test]
    fn test_validate_config_rejects_duplicate_fixed_ports() {
        let yaml = r#"
name: test
services: {}
portforwards:
  - name: db
    namespace: dev
    pod: db
    localPort: 15432
    remotePort: 5432
  - name: replica
    namespace: dev
    pod: replica
    localPort: 15432
    remotePort: 5432
"#;
        let (_, issues) = validate_config_yaml(yaml).unwrap();
        assert!(issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error && issue.message.contains("Fixed local port")
        }));
    }

    #[test]
    fn test_validate_config_warns_for_repeated_service_defaults() {
        let yaml = r#"
name: test
services:
  web-a:
    command: web-a
    port: 3000
  web-b:
    command: web-b
    port: 3000
"#;
        let (_, issues) = validate_config_yaml(yaml).unwrap();
        assert!(issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Warning
                && issue.message.contains("Configured service port 3000")
        }));
        assert!(!issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error && issue.message.contains("port 3000")
        }));
    }
}
