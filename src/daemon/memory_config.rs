//! Memory configuration: the `memory:` section of `~/.warpforge/config.yaml`.
//! Loaded once at daemon start; the dreaming subsection is parsed and stored
//! but never executed in v1.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

fn default_embedding() -> String {
    "none".into()
}

fn default_dream_agent() -> String {
    "opencode".into()
}

fn default_dream_trigger() -> String {
    "manual".into()
}

fn default_dream_cron() -> String {
    "0 3 * * *".into()
}

fn default_dream_idle() -> String {
    "30m".into()
}

/// The `memory:` block. Missing keys resolve to the v1 defaults (everything
/// enabled, FTS-only, `embedding: "none"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub global: bool,
    #[serde(default = "default_true")]
    pub project: bool,
    #[serde(default = "default_embedding")]
    pub embedding: String,
    #[serde(default)]
    pub dreaming: DreamingConfig,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            global: true,
            project: true,
            embedding: "none".into(),
            dreaming: DreamingConfig::default(),
        }
    }
}

impl MemoryConfig {
    pub fn load() -> Self {
        let path = config_path();
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_yaml::from_str::<RawConfig>(&raw) {
                Ok(raw) => raw.memory,
                Err(_) => Self::default(),
            },
            Err(_) => Self::default(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    #[serde(default)]
    memory: MemoryConfig,
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
        .join("config.yaml")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamingConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    #[serde(default = "default_dream_agent")]
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_dream_trigger")]
    pub trigger: String,
    #[serde(default = "default_dream_cron")]
    pub cron: String,
    #[serde(default = "default_dream_idle")]
    pub idle_after: String,
}

impl Default for DreamingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            agent: "opencode".into(),
            model: None,
            trigger: "manual".into(),
            cron: "0 3 * * *".into(),
            idle_after: "30m".into(),
        }
    }
}
