//! Blast radius policy: blocks dangerous shell commands and flags risky ones
//! for user confirmation.
//!
//! Mirrors Omnigent's `policies/builtins/orchestration.py` blast_radius.

use async_trait::async_trait;

use crate::policies::{Phase, Policy, PolicyContext, PolicyResult};

pub struct BlastRadiusPolicy {
    /// Shell patterns that are always denied (e.g. "rm -rf", "force push").
    pub deny_patterns: Vec<String>,
    /// Shell patterns that require user confirmation (e.g. "git push", "npm publish").
    pub ask_patterns: Vec<String>,
    /// Whether to gate git push operations specifically.
    pub gate_pushes: bool,
}

impl Default for BlastRadiusPolicy {
    fn default() -> Self {
        Self {
            deny_patterns: vec![
                "rm -rf /".into(),
                "rm -rf ~".into(),
                "rm -rf *".into(),
                "git push --force".into(),
                "git push -f".into(),
                "git push --force-with-lease".into(),
                ":(){ :|:& };:".into(),
            ],
            ask_patterns: vec![
                "git push".into(),
                "git push origin".into(),
                "git merge".into(),
                "git rebase".into(),
                "npm publish".into(),
                "cargo publish".into(),
                "pip publish".into(),
                "docker push".into(),
                "kubectl delete".into(),
                "kubectl apply".into(),
            ],
            gate_pushes: true,
        }
    }
}

#[async_trait]
impl Policy for BlastRadiusPolicy {
    fn name(&self) -> &str {
        "blast_radius"
    }

    async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult {
        // Only applies to tool calls that execute shell commands.
        if ctx.phase != Phase::ToolCall {
            return PolicyResult::allow();
        }

        let tool = match ctx.tool_name.as_deref() {
            Some(t) => t,
            None => return PolicyResult::allow(),
        };

        // We care about shell/exec tool calls. For ACP, this is typically
        // the "execute" or "shell" tool — but we also check tool_input
        // for command content.
        let command = extract_command(ctx);

        if let Some(cmd) = &command {
            // Check deny patterns first.
            for pattern in &self.deny_patterns {
                if cmd.contains(pattern.as_str()) {
                    return PolicyResult::deny(format!(
                        "command blocked by blast_radius: contains '{pattern}'"
                    ));
                }
            }

            // Check ask patterns.
            if self.gate_pushes {
                for pattern in &self.ask_patterns {
                    if cmd.contains(pattern.as_str()) {
                        return PolicyResult::ask(format!(
                            "command requires confirmation: '{cmd}'"
                        ));
                    }
                }
            }
        }

        // Also gate specific ACP file-edit tools if they touch sensitive paths.
        if tool == "fs/write_text_file" {
            if let Some(path) = ctx
                .tool_input
                .as_ref()
                .and_then(|i| i.get("path"))
                .and_then(|p| p.as_str())
            {
                if is_sensitive_path(path) {
                    return PolicyResult::ask(format!("writing to sensitive path: {path}"));
                }
            }
        }

        PolicyResult::allow()
    }
}

/// Try to extract a shell command from the policy context.
fn extract_command(ctx: &PolicyContext) -> Option<String> {
    // Check tool_input for a "command" field.
    if let Some(cmd) = ctx
        .tool_input
        .as_ref()
        .and_then(|i| i.get("command"))
        .and_then(|c| c.as_str())
    {
        return Some(cmd.to_string());
    }
    // Check for "content" that looks like a shell script (for execute tools).
    if let Some(content) = ctx
        .tool_input
        .as_ref()
        .and_then(|i| i.get("content"))
        .and_then(|c| c.as_str())
    {
        // Only treat as command if it's short and looks like a single command.
        if content.len() < 200 && !content.contains('\n') {
            return Some(content.to_string());
        }
    }
    None
}

/// Paths that are risky to write to.
fn is_sensitive_path(path: &str) -> bool {
    let sensitive = [
        ".ssh/",
        ".gnupg/",
        ".env",
        ".env.local",
        ".env.production",
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
    ];
    sensitive.iter().any(|s| path.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ctx(cmd: &str) -> PolicyContext {
        PolicyContext {
            phase: Phase::ToolCall,
            tool_name: Some("execute".into()),
            tool_input: Some(serde_json::json!({"command": cmd})),
            agent: "claude".into(),
            task_id: "t_1".into(),
            project: "demo".into(),
            cwd: PathBuf::from("."),
            labels: std::collections::HashMap::new(),
        }
    }

    #[tokio::test]
    async fn deny_force_push() {
        let p = BlastRadiusPolicy::default();
        let r = p.evaluate(&ctx("git push --force origin main")).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn deny_rm_rf() {
        let p = BlastRadiusPolicy::default();
        let r = p.evaluate(&ctx("rm -rf /tmp/junk")).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn ask_on_push() {
        let p = BlastRadiusPolicy::default();
        let r = p.evaluate(&ctx("git push origin main")).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Ask { .. }
        ));
    }

    #[tokio::test]
    async fn ask_on_npm_publish() {
        let p = BlastRadiusPolicy::default();
        let r = p.evaluate(&ctx("npm publish")).await;
        assert!(matches!(
            r.action,
            crate::policies::PolicyAction::Ask { .. }
        ));
    }

    #[tokio::test]
    async fn allow_safe_command() {
        let p = BlastRadiusPolicy::default();
        let r = p.evaluate(&ctx("ls -la")).await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }

    #[tokio::test]
    async fn allow_non_tool_phase() {
        let p = BlastRadiusPolicy::default();
        let mut c = ctx("rm -rf /");
        c.phase = Phase::Spawn;
        let r = p.evaluate(&c).await;
        assert_eq!(r.action, crate::policies::PolicyAction::Allow);
    }
}
