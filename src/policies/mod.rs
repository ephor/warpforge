//! Policy engine: gates agent actions (file writes, spawns, shell commands)
//! through a chain of policies that return ALLOW / ASK / DENY.
//!
//! Inspired by Omnigent's `policies/` module but implemented as Rust trait
//! objects — same pattern, idiomatic Rust.
//!
//! # Flow
//!
//! 1. An agent action (e.g. `fs/write_text_file`) arrives via ACP.
//! 2. The daemon builds a [`PolicyContext`] from the action + task metadata.
//! 3. [`PolicyRegistry::evaluate_all`] runs every registered policy in order.
//! 4. First DENY wins → action blocked. First ASK wins → surface to UI.
//! 5. If all ALLOW → action proceeds.

use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;

pub mod builtins;
pub mod registry;

// ─── Core types ─────────────────────────────────────────────────────────────

/// What phase of the agent lifecycle triggered this evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// Agent is about to execute a tool (file write, shell, etc.).
    ToolCall,
    /// Agent is about to be spawned.
    Spawn,
    /// Agent is sending a prompt (for prompt-level policies).
    Prompt,
}

/// The verdict a policy returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyAction {
    Allow,
    /// Surface to the user for a decision. Carries a reason and optional
    /// outcome options (e.g. ["allow", "deny"]).
    Ask {
        reason: String,
        options: Vec<String>,
    },
    Deny {
        reason: String,
    },
}

/// Full result of a policy evaluation, including any label updates.
#[derive(Debug, Clone)]
pub struct PolicyResult {
    pub action: PolicyAction,
    pub reason: Option<String>,
    /// Labels to set on the session (e.g. cost tracking state).
    pub set_labels: HashMap<String, String>,
}

impl PolicyResult {
    pub fn allow() -> Self {
        Self {
            action: PolicyAction::Allow,
            reason: None,
            set_labels: HashMap::new(),
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            action: PolicyAction::Deny {
                reason: reason.into(),
            },
            reason: None,
            set_labels: HashMap::new(),
        }
    }

    pub fn ask(reason: impl Into<String>) -> Self {
        Self {
            action: PolicyAction::Ask {
                reason: reason.into(),
                options: vec!["allow".into(), "deny".into()],
            },
            reason: None,
            set_labels: HashMap::new(),
        }
    }
}

/// Context passed to every policy for evaluation.
#[derive(Debug, Clone)]
pub struct PolicyContext {
    pub phase: Phase,
    /// The tool name, if this is a ToolCall phase (e.g. "fs/write_text_file").
    pub tool_name: Option<String>,
    /// Tool-specific input parameters.
    pub tool_input: Option<serde_json::Value>,
    /// The agent id (e.g. "claude", "codex").
    pub agent: String,
    /// The task this action belongs to.
    pub task_id: String,
    /// The project this task belongs to.
    pub project: String,
    /// The working directory for this task.
    pub cwd: PathBuf,
    /// Session-level labels (accumulated from prior policy results).
    pub labels: HashMap<String, String>,
}

// ─── Policy trait ───────────────────────────────────────────────────────────

/// A single policy that evaluates agent actions.
#[async_trait]
pub trait Policy: Send + Sync {
    /// Human-readable name for logging / debugging.
    fn name(&self) -> &str;

    /// Evaluate the action. Policies are called in registration order;
    /// first DENY or ASK short-circuits the chain.
    async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult;

    /// Reset per-turn state (called when a new agent turn begins).
    fn reset_turn(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AllowAll;

    #[async_trait]
    impl Policy for AllowAll {
        fn name(&self) -> &str {
            "allow_all"
        }
        async fn evaluate(&self, _ctx: &PolicyContext) -> PolicyResult {
            PolicyResult::allow()
        }
    }

    #[tokio::test]
    async fn allow_result_is_allow() {
        let r = PolicyResult::allow();
        assert_eq!(r.action, PolicyAction::Allow);
    }

    #[tokio::test]
    async fn deny_result_has_reason() {
        let r = PolicyResult::deny("nope");
        match r.action {
            PolicyAction::Deny { reason } => assert_eq!(reason, "nope"),
            _ => panic!("expected deny"),
        }
    }

    #[tokio::test]
    async fn allow_all_policy_passes() {
        let policy = AllowAll;
        let ctx = PolicyContext {
            phase: Phase::ToolCall,
            tool_name: Some("fs/write_text_file".into()),
            tool_input: None,
            agent: "claude".into(),
            task_id: "t_test".into(),
            project: "demo".into(),
            cwd: PathBuf::from("."),
            labels: HashMap::new(),
        };
        let result = policy.evaluate(&ctx).await;
        assert_eq!(result.action, PolicyAction::Allow);
    }
}
