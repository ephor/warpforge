use serde::{Deserialize, Serialize};
use warpforge_protocol::{OrchestratorConfigDto, OrchWorkerPoolDto, OrchReviewerPoolDto};

/// Top-level configuration for the multi-agent orchestrator.
///
/// The planner decides how many workers/reviewers to spawn based on the goal.
/// This config only defines the *pool* of available agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorConfig {
    /// Agent that decomposes goals into task graphs (e.g. "claude").
    pub planner_agent: String,

    /// Agents available as workers. Planner picks from this pool.
    pub worker_pool: Vec<WorkerPoolEntry>,

    /// Agents available as reviewers. Planner picks from this pool.
    pub reviewer_pool: Vec<ReviewerPoolEntry>,

    /// Whether to use worktrees for worker tasks.
    pub worktrees_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerPoolEntry {
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerPoolEntry {
    pub agent: String,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            planner_agent: "claude".into(),
            worker_pool: vec![
                WorkerPoolEntry { agent: "claude".into() },
                WorkerPoolEntry { agent: "codex".into() },
            ],
            reviewer_pool: vec![
                ReviewerPoolEntry { agent: "opencode".into() },
            ],
            worktrees_enabled: true,
        }
    }
}

impl From<OrchestratorConfigDto> for OrchestratorConfig {
    fn from(d: OrchestratorConfigDto) -> Self {
        Self {
            planner_agent: d.planner_agent,
            worker_pool: d.worker_pool.into_iter().map(Into::into).collect(),
            reviewer_pool: d.reviewer_pool.into_iter().map(Into::into).collect(),
            worktrees_enabled: d.worktrees_enabled,
        }
    }
}

impl From<OrchWorkerPoolDto> for WorkerPoolEntry {
    fn from(d: OrchWorkerPoolDto) -> Self {
        Self { agent: d.agent }
    }
}

impl From<OrchReviewerPoolDto> for ReviewerPoolEntry {
    fn from(d: OrchReviewerPoolDto) -> Self {
        Self { agent: d.agent }
    }
}

impl From<OrchestratorConfig> for OrchestratorConfigDto {
    fn from(c: OrchestratorConfig) -> Self {
        Self {
            planner_agent: c.planner_agent,
            worker_pool: c.worker_pool.into_iter().map(Into::into).collect(),
            reviewer_pool: c.reviewer_pool.into_iter().map(Into::into).collect(),
            worktrees_enabled: c.worktrees_enabled,
        }
    }
}

impl From<WorkerPoolEntry> for OrchWorkerPoolDto {
    fn from(w: WorkerPoolEntry) -> Self {
        Self { agent: w.agent }
    }
}

impl From<ReviewerPoolEntry> for OrchReviewerPoolDto {
    fn from(r: ReviewerPoolEntry) -> Self {
        Self { agent: r.agent }
    }
}
