//! Language-server catalog: detect the installed state of every editor language
//! warpforge supports and resolve safe install/update commands. Detection and
//! package-manager classification mirror `agents.rs` — a server is a global
//! binary (npm/brew) the editor starts via the daemon's stdio proxy (`lsp.rs`).
//!
//! `lsp.detect` is read-only (see `method_is_mutation` in server.rs), so this
//! module only probes; installs run through `agents::run_manage_command`.

use std::time::Duration;

use tokio::time::Instant;
use warpforge_protocol as wire;

use super::agents::{self, PackageManager};

/// A supported editor language and how its language server is installed.
pub struct KnownLspServer {
    /// Editor language id (matches `server_command` in `lsp.rs`).
    pub id: &'static str,
    /// User-facing label.
    pub language: &'static str,
    /// Primary binary checked on PATH and spawned.
    pub binary: &'static str,
    /// Second binary that still counts as installed (TS7's `tsc`).
    pub alt_binary: Option<&'static str>,
    /// npm package providing the binary (None for brew/system-only servers).
    pub npm_package: Option<&'static str>,
    /// Homebrew formula, when brew is the canonical install (None otherwise).
    pub homebrew_formula: Option<&'static str>,
    /// Human-readable install hint shown when the server is missing.
    pub install_hint: &'static str,
}

pub static KNOWN_LSP_SERVERS: &[KnownLspServer] = &[
    KnownLspServer {
        id: "typescript",
        language: "TypeScript / JavaScript",
        binary: "typescript-language-server",
        alt_binary: Some("tsc"),
        npm_package: Some("typescript-language-server"),
        homebrew_formula: Some("typescript-language-server"),
        install_hint: "npm install -g typescript-language-server",
    },
    KnownLspServer {
        id: "rust",
        language: "Rust",
        binary: "rust-analyzer",
        alt_binary: None,
        npm_package: None,
        homebrew_formula: Some("rust-analyzer"),
        install_hint: "brew install rust-analyzer",
    },
    KnownLspServer {
        id: "go",
        language: "Go",
        binary: "gopls",
        alt_binary: None,
        npm_package: None,
        homebrew_formula: Some("gopls"),
        install_hint: "brew install gopls",
    },
    KnownLspServer {
        id: "python",
        language: "Python",
        binary: "pyright-langserver",
        alt_binary: None,
        npm_package: Some("pyright"),
        homebrew_formula: Some("pyright"),
        install_hint: "npm install -g pyright",
    },
    KnownLspServer {
        id: "json",
        language: "JSON",
        binary: "vscode-json-language-server",
        alt_binary: None,
        npm_package: Some("vscode-langservers-extracted"),
        homebrew_formula: None,
        install_hint: "npm install -g vscode-langservers-extracted",
    },
    KnownLspServer {
        id: "css",
        language: "CSS",
        binary: "vscode-css-language-server",
        alt_binary: None,
        npm_package: Some("vscode-langservers-extracted"),
        homebrew_formula: None,
        install_hint: "npm install -g vscode-langservers-extracted",
    },
    KnownLspServer {
        id: "html",
        language: "HTML",
        binary: "vscode-html-language-server",
        alt_binary: None,
        npm_package: Some("vscode-langservers-extracted"),
        homebrew_formula: None,
        install_hint: "npm install -g vscode-langservers-extracted",
    },
    KnownLspServer {
        id: "yaml",
        language: "YAML",
        binary: "yaml-language-server",
        alt_binary: None,
        npm_package: Some("yaml-language-server"),
        homebrew_formula: Some("yaml-language-server"),
        install_hint: "npm install -g yaml-language-server",
    },
];

pub fn known_lsp_server(id: &str) -> Option<&'static KnownLspServer> {
    KNOWN_LSP_SERVERS.iter().find(|s| s.id == id)
}

/// Install command for a missing server (from the catalog — never user input).
fn install_command(server: &KnownLspServer) -> Option<String> {
    if let Some(pkg) = server.npm_package {
        Some(format!("npm install -g {pkg}@latest"))
    } else {
        server.homebrew_formula.map(|f| format!("brew install {f}"))
    }
}

/// Update command for an installed server, derived from the resolved install
/// path so npm vs brew is respected. None when there is no safe update.
fn update_command(server: &KnownLspServer, resolved_path: Option<&str>) -> Option<String> {
    if let Some(formula) = server.homebrew_formula {
        if server.npm_package.is_none() {
            return Some(format!("brew upgrade {formula}"));
        }
    }
    let pkg = server.npm_package?;
    let manager = resolved_path.map(agents::package_manager_for_path);
    match manager {
        Some(PackageManager::Bun) => Some(format!("bun add -g {pkg}@latest")),
        Some(PackageManager::Pnpm) => Some(format!("pnpm add -g {pkg}@latest")),
        Some(PackageManager::Homebrew) => {
            server.homebrew_formula.map(|f| format!("brew upgrade {f}"))
        }
        Some(PackageManager::Npm) | None => Some(format!("npm install -g {pkg}@latest")),
        Some(PackageManager::Unknown) => None,
    }
}

/// Installed version of a server: its global npm package version, or the
/// binary's `--version` output as a fallback (covers TS7's `tsc`).
async fn installed_version(server: &KnownLspServer) -> Option<String> {
    if let Some(pkg) = server.npm_package {
        if let Some(v) = agents::npm_global_version(pkg).await {
            return Some(v);
        }
    }
    if let Some(v) = binary_version(server.binary).await {
        return Some(v);
    }
    match server.alt_binary {
        Some(bin) => binary_version(bin).await,
        None => None,
    }
}

async fn binary_version(bin: &str) -> Option<String> {
    let output = tokio::process::Command::new(bin)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    agents::first_version_token(&String::from_utf8_lossy(&output.stdout))
}

/// Latest published npm version, cached ~1h with a short timeout so a slow or
/// absent registry never blocks detection. Mirrors `agents::latest_npm_version`.
async fn latest_npm_version(pkg: &str) -> Option<String> {
    const TTL: Duration = Duration::from_secs(60 * 60);
    use std::collections::HashMap;
    use std::sync::Mutex;
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

/// First reachable binary for a server (primary, then alternative).
async fn resolve_binary(server: &KnownLspServer) -> Option<String> {
    match agents::which(server.binary).await {
        Some(path) => Some(path),
        None => match server.alt_binary {
            Some(bin) => agents::which(bin).await,
            None => None,
        },
    }
}

async fn detect_one(
    server: &'static KnownLspServer,
    check_latest: bool,
) -> wire::DetectedLanguageServer {
    let path = resolve_binary(server).await;
    let installed = path.is_some();

    if !installed {
        return wire::DetectedLanguageServer {
            id: server.id.to_string(),
            language: server.language.to_string(),
            installed: false,
            version: None,
            latest_version: None,
            status: "missing".to_string(),
            install_command: install_command(server),
            update_command: None,
            can_manage: install_command(server).is_some(),
            install_hint: server.install_hint.to_string(),
        };
    }

    let version = installed_version(server).await;
    let latest = if check_latest {
        match server.npm_package {
            Some(pkg) => latest_npm_version(pkg).await,
            None => None,
        }
    } else {
        None
    };
    let status = match (&version, &latest) {
        (Some(v), Some(l)) if agents::compare_versions(v, l).is_lt() => "behind",
        (Some(_), Some(_)) => "current",
        _ => "unknown",
    }
    .to_string();

    wire::DetectedLanguageServer {
        id: server.id.to_string(),
        language: server.language.to_string(),
        installed: true,
        version,
        latest_version: latest,
        status,
        install_command: None,
        update_command: update_command(server, path.as_deref()),
        can_manage: update_command(server, path.as_deref()).is_some(),
        install_hint: server.install_hint.to_string(),
    }
}

/// Detect every supported language server concurrently, including registry
/// freshness. Called from the server handler (out of the actor loop).
pub async fn detect_language_servers() -> Vec<wire::DetectedLanguageServer> {
    let futures = KNOWN_LSP_SERVERS.iter().map(|s| detect_one(s, true));
    futures::future::join_all(futures).await
}

/// Resolve the install (when missing) or update (when present) command for a
/// language server by id. None when unknown or unmanageable.
pub async fn manage_command(id: &str) -> Option<String> {
    let server = known_lsp_server(id)?;
    match resolve_binary(server).await {
        Some(path) => update_command(server, Some(&path)),
        None => install_command(server),
    }
}
