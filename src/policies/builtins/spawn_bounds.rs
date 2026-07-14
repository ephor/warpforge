//! Spawn bounds policy: limits how many sub-agents or dispatches a single
//! turn can create.
//!
//! Mirrors Omnigent's `policies/builtins/orchestration.py` spawn_bounds.

use async_trait::async_trait;

use crate::policies::{Phase, Policy, PolicyContext, PolicyResult};

pub struct SpawnBoundsPolicy {
    /// Maximum spawns allowed per turn.
    pub max_per_turn: usize,
    /// Current turn's spawn count. Reset on `reset_turn()`.
    current_count: usize,
}

impl SpawnBoundsPolicy {
    pub fn new(max_per_turn: usize) -> Self {
        Self {
            max_per_turn,
            current_count: 0,
        }
    }
}

#[async_trait]
impl Policy for SpawnBoundsPolicy {
    fn name(&self) -> &str {
        "spawn_bounds"
    }

    async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult {
        if ctx.phase != Phase::Spawn {
            return PolicyResult::allow();
        }

        if self.current_count >= self.max_per_turn {
            return PolicyResult::deny(format!(
                "spawn limit reached: {} / {} per turn",
                self.current_count, self.max_per_turn
            ));
        }

        PolicyResult::allow()
    }

    fn reset_turn(&mut self) {
        self.current_count = 0;
    }
}

impl SpawnBoundsPolicy {
    /// Call after a successful spawn to increment the counter.
    pub fn record_spawn(&mut self) {
        self.current_count += 1;
    }

    pub fn current_count(&self) -> usize {
        self.current_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn spawn_ctx() -> PolicyContext {
        PolicyContext {
            phase: Phase::Spawn,
            tool_name: None,
            tool_input: None,
            agent: "claude".into(),
            task_id: "t_1".into(),
            project: "demo".into(),
            cwd: PathBuf::from("."),
            labels: std::collections::HashMap::new(),
        }
    }

    #[tokio::test]
    async fn allow_first_few_spawns() {
        let mut p = SpawnBoundsPolicy::new(3);
        for _ in 0..3 {
            let r = p.evaluate(&spawn_ctx()).await;
            assert_eq!(r.action, crate::policies::PolicyAction::Allow);
            p.record_spawn();
        }
    }

    #[tokio::test]
    async fn deny_after_limit() {
        let mut p = SpawnBoundsPolicy::new(2);
        p.record_spawn();
        p.record_spawn();
        let r = p.evaluate(&spawn_ctx()).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn reset_turn_clears_counter() {
        let mut p = SpawnBoundsPolicy::new(2);
        p.record_spawn();
        p.record_spawn();
        p.reset_turn();
        let r = p.evaluate(&spawn_ctx()).await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }

    #[tokio::test]
    async fn skip_non_spawn_phase() {
        let mut p = SpawnBoundsPolicy::new(1);
        p.record_spawn(); // at limit
        let mut c = spawn_ctx();
        c.phase = Phase::ToolCall;
        let r = p.evaluate(&c).await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }
}
