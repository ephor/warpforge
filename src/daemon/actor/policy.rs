use std::collections::HashMap;

use crate::daemon::acp::PolicyCheck;
use crate::daemon::actor::Daemon;
use crate::policies::{Phase, PolicyContext};

impl Daemon {
    pub(crate) fn policy_context(
        &self,
        task_id: &str,
        phase: Phase,
        tool_name: Option<String>,
        tool_input: Option<serde_json::Value>,
    ) -> Option<PolicyContext> {
        let task = self.tasks.get(task_id)?;
        let project_path = self.project_path(&task.project)?;
        let cwd = if let Some(ref wt) = task.worktree {
            std::path::PathBuf::from(wt)
        } else {
            std::path::PathBuf::from(&project_path)
        };
        Some(PolicyContext {
            phase,
            tool_name,
            tool_input,
            agent: task.agent.clone(),
            task_id: task_id.to_string(),
            project: task.project.clone(),
            cwd,
            labels: HashMap::new(),
        })
    }

    /// Evaluate all policies for an action on a task.
    pub(crate) async fn evaluate_policies(
        &self,
        task_id: &str,
        phase: Phase,
        tool_name: Option<String>,
        tool_input: Option<serde_json::Value>,
    ) -> crate::policies::PolicyResult {
        let ctx = match self.policy_context(task_id, phase, tool_name, tool_input) {
            Some(ctx) => ctx,
            None => return crate::policies::PolicyResult::allow(),
        };
        self.policies.evaluate_all(&ctx).await
    }

    /// Handle a policy check request from an ACP reader task.
    pub(crate) async fn handle_policy_check(&mut self, check: PolicyCheck) {
        let result = self.policies.evaluate_all(&check.ctx).await;
        let _ = check.reply.send(result);
    }
}
