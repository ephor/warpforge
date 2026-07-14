//! Cost budget policy: enforces spending limits on agent usage.
//!
//! Mirrors Omnigent's `policies/builtins/cost.py` — hard cap + soft thresholds.
//!
//! Cost tracking uses session labels (`cost_usd`) as a simple accumulator.
//! The policy reads the current total and blocks when it exceeds the cap.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;

use crate::policies::{Phase, Policy, PolicyContext, PolicyResult};

/// MicroUSD = micro-dollars (1 USD = 1_000_000). avoids floats.
const MICRO_USD: u64 = 1_000_000;

pub struct CostBudgetPolicy {
    /// Hard cap in USD. Action is DENIED once exceeded.
    pub max_cost_usd: f64,
    /// Soft threshold in USD. Action is ASK'd once exceeded.
    pub ask_threshold_usd: f64,
    /// Shared counter (microUSD). Policies and the daemon both increment this.
    pub current_cost: Arc<AtomicU64>,
}

impl CostBudgetPolicy {
    pub fn new(max_cost_usd: f64, ask_threshold_usd: f64) -> Self {
        Self {
            max_cost_usd,
            ask_threshold_usd,
            current_cost: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Record usage in microUSD.
    pub fn record(&self, micro_usd: u64) {
        self.current_cost.fetch_add(micro_usd, Ordering::Relaxed);
    }

    fn current_usd(&self) -> f64 {
        self.current_cost.load(Ordering::Relaxed) as f64 / MICRO_USD as f64
    }
}

#[async_trait]
impl Policy for CostBudgetPolicy {
    fn name(&self) -> &str {
        "cost_budget"
    }

    async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult {
        // Only gate tool calls (not every prompt turn).
        if ctx.phase != Phase::ToolCall {
            return PolicyResult::allow();
        }

        let current = self.current_usd();

        if current >= self.max_cost_usd {
            return PolicyResult::deny(format!(
                "cost budget exceeded: ${:.2} / ${:.2} max",
                current, self.max_cost_usd
            ));
        }

        if current >= self.ask_threshold_usd {
            return PolicyResult::ask(format!(
                "cost approaching limit: ${:.2} / ${:.2}",
                current, self.max_cost_usd
            ));
        }

        PolicyResult::allow()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ctx() -> PolicyContext {
        PolicyContext {
            phase: Phase::ToolCall,
            tool_name: Some("fs/write_text_file".into()),
            tool_input: None,
            agent: "claude".into(),
            task_id: "t_1".into(),
            project: "demo".into(),
            cwd: PathBuf::from("."),
            labels: std::collections::HashMap::new(),
        }
    }

    #[tokio::test]
    async fn allow_under_threshold() {
        let p = CostBudgetPolicy::new(10.0, 8.0);
        let r = p.evaluate(&ctx()).await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }

    #[tokio::test]
    async fn ask_at_soft_threshold() {
        let p = CostBudgetPolicy::new(10.0, 8.0);
        p.record(8_000_000); // $8.00
        let r = p.evaluate(&ctx()).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Ask { .. }
        ));
    }

    #[tokio::test]
    async fn deny_at_hard_cap() {
        let p = CostBudgetPolicy::new(10.0, 8.0);
        p.record(10_000_000); // $10.00
        let r = p.evaluate(&ctx()).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn skip_non_tool_phase() {
        let p = CostBudgetPolicy::new(10.0, 8.0);
        p.record(10_000_000);
        let mut c = ctx();
        c.phase = Phase::Spawn;
        let r = p.evaluate(&c).await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }
}
