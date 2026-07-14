//! Worktree guard policy: confines file writes to the task's worktree directory.
//!
//! Mirrors Omnigent's `policies/builtins/orchestration.py` worktree_guard.
//!
//! When a task runs in a worktree, writes outside the worktree are blocked.
//! This prevents an agent from accidentally modifying the main working tree.

use async_trait::async_trait;

use crate::policies::{Phase, Policy, PolicyContext, PolicyResult};

pub struct WorktreeGuardPolicy {
    /// The allowed write root. If set, writes outside this path are denied.
    pub allowed_root: Option<std::path::PathBuf>,
}

impl WorktreeGuardPolicy {
    pub fn new(allowed_root: std::path::PathBuf) -> Self {
        Self {
            allowed_root: Some(allowed_root),
        }
    }

    pub fn disabled() -> Self {
        Self { allowed_root: None }
    }
}

#[async_trait]
impl Policy for WorktreeGuardPolicy {
    fn name(&self) -> &str {
        "worktree_guard"
    }

    async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult {
        let root = match &self.allowed_root {
            Some(r) => r,
            None => return PolicyResult::allow(), // guard disabled
        };

        // Only applies to write tool calls.
        if ctx.phase != Phase::ToolCall {
            return PolicyResult::allow();
        }

        let tool = match ctx.tool_name.as_deref() {
            Some(t) => t,
            None => return PolicyResult::allow(),
        };

        // Only gate write operations.
        if !is_write_tool(tool) {
            return PolicyResult::allow();
        }

        // Extract the file path from tool input.
        let path = match ctx.tool_input.as_ref().and_then(|i| {
            i.get("path")
                .or_else(|| i.get("file"))
                .or_else(|| i.get("filePath"))
        }) {
            Some(p) => p.as_str().unwrap_or(""),
            None => return PolicyResult::allow(),
        };

        if path.is_empty() {
            return PolicyResult::allow();
        }

        // Resolve relative paths against cwd, then check containment.
        let target = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            ctx.cwd.join(path)
        };

        // Canonicalize if possible, otherwise normalize.
        let target = target.canonicalize().unwrap_or(target);

        if target.starts_with(root) {
            PolicyResult::allow()
        } else {
            PolicyResult::deny(format!(
                "write outside worktree blocked: {} not in {}",
                target.display(),
                root.display()
            ))
        }
    }
}

/// Check if an ACP tool is a write operation.
fn is_write_tool(tool: &str) -> bool {
    matches!(
        tool,
        "fs/write_text_file" | "fs/create_file" | "fs/write_file" | "edit" | "write"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write_ctx(tool: &str, path: &str) -> PolicyContext {
        PolicyContext {
            phase: Phase::ToolCall,
            tool_name: Some(tool.into()),
            tool_input: Some(serde_json::json!({"path": path})),
            agent: "claude".into(),
            task_id: "t_1".into(),
            project: "demo".into(),
            cwd: PathBuf::from("/workspace"),
            labels: std::collections::HashMap::new(),
        }
    }

    #[tokio::test]
    async fn allow_write_inside_worktree() {
        let p = WorktreeGuardPolicy::new(PathBuf::from("/workspace/.worktrees/t_1"));
        let r = p
            .evaluate(&write_ctx(
                "fs/write_text_file",
                ".worktrees/t_1/src/main.rs",
            ))
            .await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }

    #[tokio::test]
    async fn deny_write_outside_worktree() {
        let p = WorktreeGuardPolicy::new(PathBuf::from("/workspace/.worktrees/t_1"));
        let r = p
            .evaluate(&write_ctx("fs/write_text_file", "src/main.rs"))
            .await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn allow_read_outside() {
        let p = WorktreeGuardPolicy::new(PathBuf::from("/workspace/.worktrees/t_1"));
        let r = p
            .evaluate(&write_ctx("fs/read_text_file", "../other/file.rs"))
            .await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }

    #[tokio::test]
    async fn disabled_guard_allows_all() {
        let p = WorktreeGuardPolicy::disabled();
        let r = p
            .evaluate(&write_ctx("fs/write_text_file", "/etc/passwd"))
            .await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }
}
