//! Agent registry: detect installed ACP-capable CLIs, report install/update
//! state, and persist the user's enabled set to SQLite. Agents are globally
//! installed binaries (npm/brew) that speak ACP over stdio; the daemon spawns
//! them directly (no `npx` — a first-run npx download used to truncate and
//! wedge the session, see HANDOFF.md).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use warpforge_protocol as wire;

/// A known ACP-capable agent the daemon can detect and manage.
pub struct KnownAgent {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Binary name checked on PATH and spawned.
    pub binary: &'static str,
    /// Default ACP server command (passed to `sh -c`).
    pub default_acp_command: &'static str,
    /// npm package that provides the binary (None for brew-only agents).
    pub npm_package: Option<&'static str>,
    /// Homebrew formula, when brew is the canonical install (None otherwise).
    pub homebrew_formula: Option<&'static str>,
    /// Human-readable install hint shown when the agent is missing.
    pub install_hint: &'static str,
}

pub static KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent {
        id: "claude",
        display_name: "Claude Code",
        binary: "claude-agent-acp",
        default_acp_command: "claude-agent-acp --acp",
        npm_package: Some("@agentclientprotocol/claude-agent-acp"),
        homebrew_formula: None,
        install_hint: "npm install -g @agentclientprotocol/claude-agent-acp",
    },
    KnownAgent {
        id: "codex",
        display_name: "Codex",
        binary: "codex-acp",
        default_acp_command: "codex-acp",
        npm_package: Some("@agentclientprotocol/codex-acp"),
        homebrew_formula: None,
        install_hint: "npm install -g @agentclientprotocol/codex-acp",
    },
    KnownAgent {
        id: "opencode",
        display_name: "OpenCode",
        binary: "opencode",
        default_acp_command: "opencode acp",
        npm_package: Some("opencode-ai"),
        homebrew_formula: None,
        install_hint: "npm install -g opencode-ai",
    },
    KnownAgent {
        id: "qwen",
        display_name: "Qwen Code",
        binary: "qwen",
        default_acp_command: "qwen --acp",
        npm_package: Some("@qwen-code/qwen-code"),
        homebrew_formula: None,
        install_hint: "npm install -g @qwen-code/qwen-code",
    },
    KnownAgent {
        id: "goose",
        display_name: "Goose",
        binary: "goose",
        default_acp_command: "goose acp",
        npm_package: None,
        homebrew_formula: Some("block-goose-cli"),
        install_hint: "brew install block-goose-cli",
    },
];

pub fn known_agent(id: &str) -> Option<&'static KnownAgent> {
    KNOWN_AGENTS.iter().find(|a| a.id == id)
}

/// The shell command that installs (when missing) or updates (when present) an
/// agent, given how its binary is installed. Returns the command string to run
/// via `sh -c`, or None when there is no safe automated path.
pub fn install_command(agent: &KnownAgent) -> Option<String> {
    if let Some(pkg) = agent.npm_package {
        Some(format!("npm install -g {pkg}@latest"))
    } else {
        agent.homebrew_formula.map(|f| format!("brew install {f}"))
    }
}

fn update_command(agent: &KnownAgent, resolved_path: Option<&str>) -> Option<String> {
    if let Some(formula) = agent.homebrew_formula {
        // brew-managed agents always update via brew.
        if agent.npm_package.is_none() {
            return Some(format!("brew upgrade {formula}"));
        }
    }
    let pkg = agent.npm_package?;
    let manager = resolved_path.map(package_manager_for_path);
    match manager {
        Some(PackageManager::Bun) => Some(format!("bun add -g {pkg}@latest")),
        Some(PackageManager::Pnpm) => Some(format!("pnpm add -g {pkg}@latest")),
        Some(PackageManager::Homebrew) => {
            agent.homebrew_formula.map(|f| format!("brew upgrade {f}"))
        }
        // npm global, or a bare binary name with no path info → assume npm.
        Some(PackageManager::Npm) | None => Some(format!("npm install -g {pkg}@latest")),
        Some(PackageManager::Unknown) => None,
    }
}

enum PackageManager {
    Npm,
    Bun,
    Pnpm,
    Homebrew,
    Unknown,
}

/// Classify a global-install manager from the resolved binary path (mirrors
/// t3code's path heuristics).
fn package_manager_for_path(path: &str) -> PackageManager {
    let p = path.replace('\\', "/").to_lowercase();
    // Check npm/bun/pnpm node paths before homebrew: an npm-global binary
    // installed under a brew-managed Node lives at /opt/homebrew/bin/… (a
    // symlink into …/lib/node_modules/…) and must resolve to npm, not brew.
    if p.contains("/.bun/bin/") {
        PackageManager::Bun
    } else if p.contains("/pnpm/")
        || p.contains("/.local/share/pnpm/")
        || p.contains("/library/pnpm/")
    {
        PackageManager::Pnpm
    } else if p.contains("/node_modules/") || p.contains("/lib/node/") || p.contains("/npm/") {
        PackageManager::Npm
    } else if p.contains("/cellar/") || p.contains("/caskroom/") {
        PackageManager::Homebrew
    } else {
        PackageManager::Unknown
    }
}

/// Resolve a binary on PATH → its real (symlink-resolved) path, or None if
/// absent. Resolving the symlink matters for install-manager classification:
/// an npm-global bin often lives at a brew prefix as a link into node_modules.
async fn which(binary: &str) -> Option<String> {
    let output = tokio::process::Command::new("which")
        .arg(binary)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    // Canonicalize so a symlinked wrapper resolves to its real install path.
    let real = tokio::fs::canonicalize(&path)
        .await
        .ok()
        .and_then(|p| p.to_str().map(String::from));
    Some(real.unwrap_or(path))
}

/// Latest published version of an npm package, cached ~1h with a short timeout
/// so a slow/absent registry never blocks detection. Shells out to `npm view`
/// (npm is already required to install agents) — no HTTP client dependency.
async fn latest_npm_version(pkg: &str) -> Option<String> {
    const TTL: Duration = Duration::from_secs(60 * 60);
    // pkg → (fetched_at, latest_version_or_none)
    type VersionCache = HashMap<String, (Instant, Option<String>)>;
    static CACHE: Mutex<Option<VersionCache>> = Mutex::new(None);
    {
        let guard = CACHE.lock().unwrap();
        if let Some(map) = guard.as_ref() {
            if let Some((at, version)) = map.get(pkg) {
                if at.elapsed() < TTL {
                    return version.clone();
                }
            }
        }
    }
    let version = tokio::time::timeout(
        Duration::from_secs(4),
        tokio::process::Command::new("npm")
            .args(["view", pkg, "version"])
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .filter(|v| !v.is_empty());
    let mut guard = CACHE.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(pkg.to_string(), (Instant::now(), version.clone()));
    version
}

/// Installed version of an agent: its global npm package version, or the
/// binary's `--version` output as a fallback.
async fn installed_version(agent: &KnownAgent) -> Option<String> {
    if let Some(pkg) = agent.npm_package {
        if let Some(v) = npm_global_version(pkg).await {
            return Some(v);
        }
    }
    // Fallback: `<binary> --version`, take the first version-looking token.
    let output = tokio::process::Command::new(agent.binary)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    first_version_token(&text)
}

async fn npm_global_version(pkg: &str) -> Option<String> {
    let output = tokio::process::Command::new("npm")
        .args(["ls", "-g", pkg, "--json", "--depth=0"])
        .output()
        .await
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    json.get("dependencies")?
        .get(pkg)?
        .get("version")?
        .as_str()
        .map(String::from)
}

fn first_version_token(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|tok| {
            let t = tok.trim_start_matches('v');
            t.split('.').count() >= 2 && t.chars().next().is_some_and(|c| c.is_ascii_digit())
        })
        .map(|tok| tok.trim_start_matches('v').to_string())
}

/// -1 / 0 / 1 comparison of dotted numeric versions, ignoring any pre-release
/// suffix. Enough to answer "is current behind latest?".
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(v: &str) -> Vec<u64> {
        v.split(['-', '+'])
            .next()
            .unwrap_or(v)
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

async fn detect_one(agent: &'static KnownAgent, check_latest: bool) -> wire::DetectedAgent {
    let path = which(agent.binary).await;
    let installed = path.is_some();

    if !installed {
        let install = install_command(agent);
        return wire::DetectedAgent {
            id: agent.id.to_string(),
            display_name: agent.display_name.to_string(),
            installed: false,
            default_acp_command: agent.default_acp_command.to_string(),
            install_hint: agent.install_hint.to_string(),
            version: None,
            latest_version: None,
            status: "missing".to_string(),
            can_manage: install.is_some(),
            install_command: install,
            update_command: None,
        };
    }

    let version = installed_version(agent).await;
    let latest = if check_latest {
        match agent.npm_package {
            Some(pkg) => latest_npm_version(pkg).await,
            None => None,
        }
    } else {
        None
    };
    let update = update_command(agent, path.as_deref());

    let status = match (&version, &latest) {
        (Some(v), Some(l)) => {
            if compare_versions(v, l) == std::cmp::Ordering::Less {
                "behind"
            } else {
                "current"
            }
        }
        _ => "unknown",
    }
    .to_string();

    wire::DetectedAgent {
        id: agent.id.to_string(),
        display_name: agent.display_name.to_string(),
        installed: true,
        default_acp_command: agent.default_acp_command.to_string(),
        install_hint: agent.install_hint.to_string(),
        version,
        latest_version: latest,
        status,
        can_manage: update.is_some(),
        update_command: update,
        install_command: None,
    }
}

/// Detect every known agent concurrently, including registry freshness checks.
/// Runs outside the actor so the network calls don't block command handling.
pub async fn detect_agents() -> Vec<wire::DetectedAgent> {
    let futures = KNOWN_AGENTS.iter().map(|a| detect_one(a, true));
    futures::future::join_all(futures).await
}

/// Fast local-only detection (no registry lookups) for the first-run setup
/// prompt, where we only need to know what is installed.
pub async fn detect_agents_local() -> Vec<wire::DetectedAgent> {
    let futures = KNOWN_AGENTS.iter().map(|a| detect_one(a, false));
    futures::future::join_all(futures).await
}

/// Migrate a stored agent command off the retired `npx …@latest` launch path
/// to the current global-binary command. Returns the rewritten command when a
/// migration applies, else None (leave the stored command untouched).
pub fn migrate_npx_command(id: &str, current: &str) -> Option<String> {
    if !current.contains("npx") {
        return None;
    }
    let agent = known_agent(id)?;
    (agent.default_acp_command != current).then(|| agent.default_acp_command.to_string())
}

/// Resolve the shell command to install (when missing) or update (when present)
/// an agent by id. None when the agent is unknown or unmanageable.
pub async fn manage_command(id: &str) -> Option<String> {
    let agent = known_agent(id)?;
    match which(agent.binary).await {
        Some(path) => update_command(agent, Some(&path)),
        None => install_command(agent),
    }
}

/// Run an install/update command via `sh -c`, capturing combined output.
/// Returns (success, output). Output is truncated to a sane size.
pub async fn run_manage_command(command: &str) -> (bool, String) {
    let result = tokio::process::Command::new("sh")
        .args(["-c", command])
        .output()
        .await;
    match result {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            if text.len() > 8192 {
                let tail = text.len() - 8192;
                text = format!("…{}", &text[tail..]);
            }
            (output.status.success(), text)
        }
        Err(e) => (false, format!("failed to run '{command}': {e}")),
    }
}
