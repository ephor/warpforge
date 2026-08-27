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
    /// Extra npm packages to co-install/co-update alongside `npm_package`
    /// (e.g. an ACP bridge's target harness). Empty for most agents.
    pub extra_npm_packages: &'static [&'static str],
    /// Homebrew formula, when brew is the canonical install (None otherwise).
    pub homebrew_formula: Option<&'static str>,
    /// A self-managed install (e.g. opencode's own `~/.opencode/bin`) that ships
    /// its own upgrade command. Set when the binary is neither npm- nor
    /// brew-managed and cannot be upgraded via the package manager.
    pub custom_upgrade_command: Option<&'static str>,
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
        extra_npm_packages: &[],
        homebrew_formula: None,
        custom_upgrade_command: None,
        install_hint: "npm install -g @agentclientprotocol/claude-agent-acp",
    },
    KnownAgent {
        id: "codex",
        display_name: "Codex",
        binary: "codex-acp",
        default_acp_command: "codex-acp",
        npm_package: Some("@agentclientprotocol/codex-acp"),
        extra_npm_packages: &[],
        homebrew_formula: None,
        custom_upgrade_command: None,
        install_hint: "npm install -g @agentclientprotocol/codex-acp",
    },
    KnownAgent {
        id: "opencode",
        display_name: "OpenCode",
        binary: "opencode",
        default_acp_command: "opencode acp",
        npm_package: Some("opencode-ai"),
        extra_npm_packages: &[],
        homebrew_formula: None,
        custom_upgrade_command: Some("opencode upgrade"),
        install_hint: "npm install -g opencode-ai",
    },
    KnownAgent {
        id: "qwen",
        display_name: "Qwen Code",
        binary: "qwen",
        default_acp_command: "qwen --acp",
        npm_package: Some("@qwen-code/qwen-code"),
        extra_npm_packages: &[],
        homebrew_formula: None,
        custom_upgrade_command: None,
        install_hint: "npm install -g @qwen-code/qwen-code",
    },
    KnownAgent {
        id: "goose",
        display_name: "Goose",
        binary: "goose",
        default_acp_command: "goose acp",
        npm_package: None,
        extra_npm_packages: &[],
        homebrew_formula: Some("block-goose-cli"),
        custom_upgrade_command: None,
        install_hint: "brew install block-goose-cli",
    },
    KnownAgent {
        id: "junie",
        display_name: "Junie",
        binary: "junie",
        default_acp_command: "junie --acp true",
        npm_package: Some("@jetbrains/junie-cli"),
        custom_upgrade_command: None,
        extra_npm_packages: &[],
        homebrew_formula: None,
        install_hint: "npm install -g @jetbrains/junie-cli",
    },
    KnownAgent {
        id: "cursor",
        display_name: "Cursor",
        binary: "cursor-agent-acp",
        default_acp_command: "cursor-agent-acp",
        npm_package: Some("@blowmage/cursor-agent-acp"),
        custom_upgrade_command: None,
        extra_npm_packages: &[],
        homebrew_formula: None,
        install_hint: "npm install -g @blowmage/cursor-agent-acp",
    },
    KnownAgent {
        id: "pi",
        display_name: "Pi",
        binary: "pi-acp",
        default_acp_command: "pi-acp",
        npm_package: Some("pi-acp"),
        custom_upgrade_command: None,
        extra_npm_packages: &["@earendil-works/pi-coding-agent"],
        homebrew_formula: None,
        install_hint:
            "npm install -g @earendil-works/pi-coding-agent pi-acp (pi needs Node >=22.19)",
    },
];

pub fn known_agent(id: &str) -> Option<&'static KnownAgent> {
    KNOWN_AGENTS.iter().find(|a| a.id == id)
}

/// Reconcile the persisted agent config against the known registry so the UI
/// always presents every known agent in canonical (registry) order — even when
/// the stored config is stale or partial (e.g. agents installed but never
/// saved). Persisted fields (enabled, models, lastModel, acpCommand) are kept
/// when present; agents not in the registry anymore are dropped.
pub fn reconcile_agents_config(stored: &[wire::AgentConfig]) -> Vec<wire::AgentConfig> {
    let by_id: HashMap<&str, &wire::AgentConfig> =
        stored.iter().map(|a| (a.id.as_str(), a)).collect();
    KNOWN_AGENTS
        .iter()
        .map(|k| match by_id.get(k.id) {
            Some(cfg) => (*cfg).clone(),
            None => wire::AgentConfig {
                id: k.id.to_string(),
                display_name: k.display_name.to_string(),
                acp_command: k.default_acp_command.to_string(),
                enabled: false,
                models: vec![],
                last_model: None,
            },
        })
        .collect()
}

/// Append any co-install packages to an install/update command.
fn with_extras(agent: &KnownAgent, base: String) -> String {
    agent
        .extra_npm_packages
        .iter()
        .fold(base, |acc, extra| format!("{acc} {extra}@latest"))
}

/// The shell command that installs (when missing) or updates (when present) an
/// agent, given how its binary is installed. Returns the command string to run
/// via `sh -c`, or None when there is no safe automated path.
pub fn install_command(agent: &KnownAgent) -> Option<String> {
    if let Some(pkg) = agent.npm_package {
        Some(with_extras(agent, format!("npm install -g {pkg}@latest")))
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
        Some(PackageManager::Bun) => Some(with_extras(agent, format!("bun add -g {pkg}@latest"))),
        Some(PackageManager::Pnpm) => Some(with_extras(agent, format!("pnpm add -g {pkg}@latest"))),
        Some(PackageManager::Homebrew) => {
            agent.homebrew_formula.map(|f| format!("brew upgrade {f}"))
        }
        // npm global, or a bare binary name with no path info → assume npm.
        Some(PackageManager::Npm) | None => {
            Some(with_extras(agent, format!("npm install -g {pkg}@latest")))
        }
        // Unrecognised install dir: use the agent's own upgrade command (e.g.
        // opencode's self-installed `~/.opencode/bin`), if it has one.
        Some(PackageManager::Unknown) => agent.custom_upgrade_command.map(|cmd| cmd.to_string()),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PackageManager {
    Npm,
    Bun,
    Pnpm,
    Homebrew,
    Unknown,
}

/// Classify a global-install manager from the resolved binary path (mirrors
/// t3code's path heuristics).
pub(crate) fn package_manager_for_path(path: &str) -> PackageManager {
    let p = path.replace('\\', "/").to_lowercase();
    // A brew formula always lives under Cellar/Caskroom and is unambiguous —
    // check it before the node paths below, because a brew-packaged Node app
    // (e.g. gemini-cli) also contains a `node_modules` internally and would
    // otherwise be misclassified as npm.
    if p.contains("/cellar/") || p.contains("/caskroom/") {
        return PackageManager::Homebrew;
    }
    // Check npm/bun/pnpm node paths: an npm-global binary installed under a
    // brew-managed Node lives at /opt/homebrew/bin/… (a symlink into
    // …/lib/node_modules/…) and must resolve to npm, not brew. These paths do
    // not contain /cellar, so they only run after the brew check above.
    if p.contains("/.bun/bin/") {
        PackageManager::Bun
    } else if p.contains("/pnpm/")
        || p.contains("/.local/share/pnpm/")
        || p.contains("/library/pnpm/")
    {
        PackageManager::Pnpm
    } else if p.contains("/node_modules/") || p.contains("/lib/node/") || p.contains("/npm/") {
        PackageManager::Npm
    } else {
        PackageManager::Unknown
    }
}

/// Resolve a binary on PATH → its real (symlink-resolved) path, or None if
/// absent. Resolving the symlink matters for install-manager classification:
/// an npm-global bin often lives at a brew prefix as a link into node_modules.
pub(crate) async fn which(binary: &str) -> Option<String> {
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
pub(crate) async fn latest_npm_version(pkg: &str) -> Option<String> {
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

/// Installed version of an agent: the npm/bun/pnpm global package version when
/// the binary is package-manager-managed, or the binary's `--version` output
/// otherwise. The npm lookup is only trusted for npm-managed install paths so a
/// stale/duplicate npm copy can't shadow the version of the binary on PATH.
async fn installed_version(agent: &KnownAgent, resolved_path: Option<&str>) -> Option<String> {
    let manager = resolved_path.map(package_manager_for_path);
    if matches!(
        manager,
        Some(PackageManager::Npm | PackageManager::Bun | PackageManager::Pnpm)
    ) {
        if let Some(pkg) = agent.npm_package {
            if let Some(v) = npm_global_version(pkg).await {
                return Some(v);
            }
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

pub(crate) async fn npm_global_version(pkg: &str) -> Option<String> {
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

pub(crate) fn first_version_token(text: &str) -> Option<String> {
    // Scan for first substring matching semver-like \d+\.\d+\.\d+ (with optional
    // trailing .digits and -/+ prerelease). Handles polluted output where
    // elixir-ls --version emits LSP framing: `v0.31.1","type":3}}Content-Length:`.
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        // allow optional leading 'v'
        let start = if bytes[i] == b'v' || bytes[i] == b'V' {
            if i + 1 < n && bytes[i + 1].is_ascii_digit() {
                i + 1
            } else {
                i += 1;
                continue;
            }
        } else if bytes[i].is_ascii_digit() {
            i
        } else {
            i += 1;
            continue;
        };
        // parse \d+(\.\d+){2,}
        let mut j = start;
        let mut dots = 0;
        while j < n {
            if bytes[j].is_ascii_digit() {
                j += 1;
            } else if bytes[j] == b'.' && j + 1 < n && bytes[j + 1].is_ascii_digit() {
                dots += 1;
                j += 1; // consume '.'
            } else {
                break;
            }
        }
        if dots >= 2 {
            // include optional prerelease/build suffix like -rc1 / +build
            while j < n && (bytes[j] == b'-' || bytes[j] == b'+') {
                let k = j + 1;
                let mut end = k;
                while end < n
                    && (bytes[end].is_ascii_alphanumeric()
                        || bytes[end] == b'.'
                        || bytes[end] == b'-')
                {
                    end += 1;
                }
                if end == k {
                    break;
                }
                j = end;
            }
            return Some(text[start..j].to_string());
        }
        i = j.max(i + 1);
    }
    None
}

/// -1 / 0 / 1 comparison of dotted numeric versions, ignoring any pre-release
/// suffix. Enough to answer "is current behind latest?".
pub(crate) fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
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

    let version = installed_version(agent, path.as_deref()).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_manager_prefers_brew_over_inner_node_modules() {
        // A brew formula that packages a Node app (e.g. gemini-cli) lives under
        // Cellar but also contains node_modules internally. It must classify as
        // Homebrew, not Npm, or the daemon would wrongly `npm install -g` it.
        let gemini = "/opt/homebrew/Cellar/gemini-cli/0.36.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js";
        assert_eq!(package_manager_for_path(gemini), PackageManager::Homebrew);
    }

    #[test]
    fn package_manager_classifies_npm_under_brew_node() {
        // npm-global install under a brew-managed Node has no /cellar segment.
        let npm = "/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/cli.js";
        assert_eq!(package_manager_for_path(npm), PackageManager::Npm);
    }

    #[test]
    fn package_manager_classifies_bun_and_plain_cellar() {
        assert_eq!(
            package_manager_for_path("/home/u/.bun/bin/opencode"),
            PackageManager::Bun
        );
        assert_eq!(
            package_manager_for_path("/opt/homebrew/Cellar/goose/1.16.0/bin/goose"),
            PackageManager::Homebrew
        );
    }
}
