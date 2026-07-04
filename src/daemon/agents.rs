//! Agent registry: detect installed ACP-capable CLIs and persist the user's
//! enabled set to SQLite. Only agents that speak ACP over stdio are listed.
//! Codex and OpenCode ship ACP adapters (`codex-acp`, `opencode acp`) so they
//! qualify; Pi (rpc) and Hermes (per-turn CLI) have no ACP bridge and are absent.

use std::collections::HashMap;

use warpforge_protocol as wire;

/// A known ACP-capable agent the daemon can auto-detect.
pub struct KnownAgent {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Binary name checked on PATH.
    pub binary: &'static str,
    /// Default ACP server command (what the daemon passes to sh -c).
    pub default_acp_command: &'static str,
    /// npm install hint (None if installed via brew / curl).
    pub install_hint: &'static str,
}

pub static KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent {
        id: "claude",
        display_name: "Claude Code",
        binary: "claude",
        default_acp_command: "npx @agentclientprotocol/claude-agent-acp@latest --acp",
        install_hint: "npm install -g @anthropic-ai/claude-code",
    },
    KnownAgent {
        id: "codex",
        display_name: "Codex",
        binary: "codex",
        // Codex has no native ACP; the codex-acp adapter bridges it over stdio.
        default_acp_command: "npx @agentclientprotocol/codex-acp@latest",
        install_hint: "npm install -g @openai/codex",
    },
    KnownAgent {
        id: "opencode",
        display_name: "OpenCode",
        binary: "opencode",
        default_acp_command: "opencode acp",
        install_hint: "npm install -g opencode-ai",
    },
    KnownAgent {
        id: "qwen",
        display_name: "Qwen Code",
        binary: "qwen",
        default_acp_command: "qwen --acp",
        install_hint: "npm install -g @qwen-code/qwen-code",
    },
    KnownAgent {
        id: "goose",
        display_name: "Goose",
        binary: "goose",
        default_acp_command: "goose acp",
        install_hint: "brew install block-goose-cli",
    },
];

/// Check PATH for each known agent binary. Returns id → path (or None).
pub fn detect_installed() -> HashMap<&'static str, bool> {
    KNOWN_AGENTS
        .iter()
        .map(|a| (a.id, which(a.binary)))
        .collect()
}

fn which(binary: &str) -> bool {
    std::process::Command::new("which")
        .arg(binary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Build the list of detected agents for the setup popup.
pub fn detected_agents() -> Vec<wire::DetectedAgent> {
    let installed = detect_installed();
    KNOWN_AGENTS
        .iter()
        .map(|a| wire::DetectedAgent {
            id: a.id.to_string(),
            display_name: a.display_name.to_string(),
            installed: *installed.get(a.id).unwrap_or(&false),
            default_acp_command: a.default_acp_command.to_string(),
            install_hint: a.install_hint.to_string(),
        })
        .collect()
}
