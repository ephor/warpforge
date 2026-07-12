use serde::{Deserialize, Serialize};

/// Top-level configuration for the multi-agent orchestrator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorConfig {
    /// Agent that decomposes goals into task graphs (e.g. "claude").
    pub planner_agent: String,

    /// Available worker agents with their specialties.
    pub workers: Vec<WorkerConfig>,

    /// Cross-vendor reviewers for quality checks.
    pub reviewers: Vec<ReviewerConfig>,

    /// Whether worktrees are enabled (requires git repo).
    pub worktrees_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    /// Agent identifier (must match a known ACP agent name).
    pub agent: String,

    /// What this worker is good at ("implement", "test", "refactor").
    pub purpose: String,

    /// Whether to isolate this worker in a git worktree.
    pub worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerConfig {
    /// Agent identifier (should differ from worker for cross-vendor reviews).
    pub agent: String,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            planner_agent: "claude".into(),
            workers: vec![
                WorkerConfig {
                    agent: "claude".into(),
                    purpose: "implement".into(),
                    worktree: true,
                },
                WorkerConfig {
                    agent: "codex".into(),
                    purpose: "implement".into(),
                    worktree: true,
                },
            ],
            reviewers: vec![ReviewerConfig {
                agent: "opencode".into(),
            }],
            worktrees_enabled: true,
        }
    }
}
