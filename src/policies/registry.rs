//! Policy registry: holds all active policies and evaluates them in order.
//!
//! Priority: first DENY wins → first ASK wins → otherwise ALLOW.

use super::{Policy, PolicyAction, PolicyContext, PolicyResult};

pub struct PolicyRegistry {
    policies: Vec<Box<dyn Policy>>,
}

impl PolicyRegistry {
    pub fn new() -> Self {
        Self {
            policies: Vec::new(),
        }
    }

    /// Add a policy to the chain.
    pub fn push(&mut self, policy: Box<dyn Policy>) {
        self.policies.push(policy);
    }

    /// Evaluate all policies against the context.
    ///
    /// Returns the first DENY, then the first ASK, then ALLOW.
    pub async fn evaluate_all(&self, ctx: &PolicyContext) -> PolicyResult {
        for policy in &self.policies {
            let result = policy.evaluate(ctx).await;
            match &result.action {
                PolicyAction::Deny { .. } | PolicyAction::Ask { .. } => return result,
                PolicyAction::Allow => continue,
            }
        }
        PolicyResult::allow()
    }

    /// Reset per-turn state on all policies.
    pub fn reset_turn(&mut self) {
        for policy in &mut self.policies {
            policy.reset_turn();
        }
    }

    pub fn is_empty(&self) -> bool {
        self.policies.is_empty()
    }

    pub fn len(&self) -> usize {
        self.policies.len()
    }
}

impl Default for PolicyRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policies::Phase;
    use std::path::PathBuf;

    struct DenyWrites;

    #[async_trait::async_trait]
    impl Policy for DenyWrites {
        fn name(&self) -> &str {
            "deny_writes"
        }
        async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult {
            if ctx.tool_name.as_deref() == Some("fs/write_text_file") {
                PolicyResult::deny("writes not allowed")
            } else {
                PolicyResult::allow()
            }
        }
    }

    struct AskOnSpawn;

    #[async_trait::async_trait]
    impl Policy for AskOnSpawn {
        fn name(&self) -> &str {
            "ask_spawn"
        }
        async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult {
            if ctx.phase == Phase::Spawn {
                PolicyResult::ask("confirm spawn")
            } else {
                PolicyResult::allow()
            }
        }
    }

    fn ctx(phase: Phase, tool: Option<&str>) -> PolicyContext {
        PolicyContext {
            phase,
            tool_name: tool.map(String::from),
            tool_input: None,
            agent: "claude".into(),
            task_id: "t_1".into(),
            project: "demo".into(),
            cwd: PathBuf::from("."),
            labels: std::collections::HashMap::new(),
        }
    }

    #[tokio::test]
    async fn deny_writes_short_circuits() {
        let mut reg = PolicyRegistry::new();
        reg.push(Box::new(DenyWrites));
        reg.push(Box::new(AskOnSpawn));

        let r = reg
            .evaluate_all(&ctx(Phase::ToolCall, Some("fs/write_text_file")))
            .await;
        assert!(matches!(r.action, PolicyAction::Deny { .. }));
    }

    #[tokio::test]
    async fn ask_spawn_when_no_earlier_deny() {
        let mut reg = PolicyRegistry::new();
        reg.push(Box::new(DenyWrites));
        reg.push(Box::new(AskOnSpawn));

        let r = reg.evaluate_all(&ctx(Phase::Spawn, None)).await;
        assert!(matches!(r.action, PolicyAction::Ask { .. }));
    }

    #[tokio::test]
    async fn all_allow_when_nothing_triggers() {
        let mut reg = PolicyRegistry::new();
        reg.push(Box::new(DenyWrites));
        reg.push(Box::new(AskOnSpawn));

        let r = reg
            .evaluate_all(&ctx(Phase::ToolCall, Some("fs/read_text_file")))
            .await;
        assert_eq!(r.action, PolicyAction::Allow);
    }
}
