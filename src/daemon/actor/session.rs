use std::path::PathBuf;

use anyhow::Result;

use warpforge_protocol as wire;

use crate::daemon::acp::spawn_acp_session;
use crate::daemon::actor::prompt::mcp_servers;
use crate::daemon::actor::prompt::MEMORY_SYSTEM;
use crate::daemon::actor::prompt::ORCHESTRATOR_SYSTEM;
use crate::daemon::actor::prompt::RUNTIME_MCP_SYSTEM;
use crate::daemon::actor::PendingSessionStart;
use crate::daemon::actor::{Daemon, Event};
use crate::daemon::task::TaskStatus;
use crate::daemon::worktree::WorktreeManager;

pub(crate) struct WorktreeRequest {
    pub(crate) project: String,
    pub(crate) base_repo: PathBuf,
    pub(crate) task_id: String,
    /// What a conversation branch inherits from.
    pub(crate) source: Option<BranchSource>,
}

/// Where a branched conversation picks up from.
pub(crate) struct BranchSource {
    /// The source task's own branch, when it has a worktree. `None` means the
    /// source works in the project checkout, so the branch starts from HEAD.
    pub(crate) base_branch: Option<String>,
    /// The working tree whose uncommitted changes carry over.
    pub(crate) path: PathBuf,
}

impl WorktreeRequest {
    pub(crate) async fn run(self) -> Result<(String, crate::daemon::worktree::Worktree), String> {
        let created = match self.source {
            Some(ref source) => {
                crate::daemon::worktree::create_branched_detached(
                    &self.base_repo,
                    &self.task_id,
                    source.base_branch.as_deref(),
                    &source.path,
                )
                .await
            }
            None => {
                crate::daemon::worktree::create_detached(&self.base_repo, &self.task_id, None).await
            }
        };
        created
            .map(|wt| (self.project, wt))
            // `{:#}` keeps the context chain: the top line alone says only
            // "failed to copy working state", never which git step failed.
            .map_err(|e| format!("{e:#}"))
    }
}

impl Daemon {
    pub(crate) fn start_pending_session(&mut self, task_id: &str, start: PendingSessionStart) {
        self.start_session(
            task_id,
            &start.project,
            &start.agent,
            &start.prompt,
            start.include_runtime_context,
            None,
            start.attachments,
            start.default_model,
            start.config_overrides,
        );
    }

    /// Resolve everything a worktree checkout needs from actor state, so the
    /// git work itself can run without borrowing the actor.
    pub(crate) fn worktree_request(
        &mut self,
        task_id: &str,
        project: &str,
        branched_from: Option<&str>,
    ) -> Option<WorktreeRequest> {
        let path = self.project_path(project)?;
        // Resolve the source's working directory before borrowing the manager.
        // A source task without a worktree runs in the project checkout, and
        // that is still the tree its branch must inherit from.
        let source_path = branched_from.and_then(|src| self.task_repo_path(src));
        let mgr = self
            .worktrees
            .entry(project.to_string())
            .or_insert_with(|| WorktreeManager::new(std::path::PathBuf::from(&path)));
        let base_branch = branched_from.and_then(|src| mgr.source_state(src).map(|(b, _)| b));
        let source = source_path.map(|path| BranchSource {
            base_branch,
            path: PathBuf::from(path),
        });
        Some(WorktreeRequest {
            project: project.to_string(),
            base_repo: mgr.base_repo().to_path_buf(),
            task_id: task_id.to_string(),
            source,
        })
    }

    #[allow(clippy::too_many_arguments)]
    /// If the task has a worktree, the agent runs in the worktree directory
    /// instead of the project root — so its edits are isolated.
    /// Start a session whose worktree checkout has finished.
    pub(crate) fn start_session(
        &mut self,
        task_id: &str,
        project: &str,
        agent: &str,
        prompt: &str,
        include_runtime_context: bool,
        resume: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        config_overrides: std::collections::HashMap<String, String>,
    ) {
        // Resolve cwd: worktree path if set, otherwise project root.
        let cwd = if let Some(task) = self.tasks.get(task_id) {
            if let Some(ref wt_path) = task.worktree {
                wt_path.clone()
            } else {
                self.project_path(project)
                    .unwrap_or_else(|| ".".to_string())
            }
        } else {
            self.project_path(project)
                .unwrap_or_else(|| ".".to_string())
        };
        let command = self.resolve_agent_command(project, agent);
        let env = self.resolve_agent_env(agent, self.spawn_account(task_id));
        // Bind the task to the account it is starting on, so a later resume goes
        // back to the same home even after the active account changed. Recorded
        // before the session exists, because that is the only moment the answer
        // is unambiguous.
        if let Some(account) = crate::daemon::accounts::select_for_spawn(
            &self.accounts,
            self.agent_id_of(agent),
            self.spawn_account(task_id),
        )
        .map(|account| account.id.clone())
        {
            if let Some(task) = self.tasks.get_mut(task_id) {
                if task.account_id.as_deref() != Some(account.as_str()) {
                    task.account_id = Some(account);
                    let updated = task.clone();
                    self.persist(&updated);
                }
            }
        }
        // Every session gets the warpforge MCP bridge (read service logs,
        // restart a service, …). An orchestrator-chat session additionally gets
        // the orchestrator system preamble and, via WF_MODE=orchestrator, the
        // spawn_agent / read_inbox tools. A plain task gets the core tools only.
        let is_orchestrator = self
            .tasks
            .get(task_id)
            .is_some_and(|t| t.tags.iter().any(|x| x == "orchestrator-chat"));
        let mcp_servers = mcp_servers(task_id, project, is_orchestrator);
        let memory_prefix = if self.memory.enabled() {
            format!("{MEMORY_SYSTEM}\n\n")
        } else {
            String::new()
        };
        let base_prompt = if is_orchestrator {
            let agents = self.available_agent_ids();
            let roster = if agents.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\nAgents you can pass to spawn_agent: {}.",
                    agents.join(", ")
                )
            };
            let workflows = self.available_workflow_ids(project);
            let workflow_roster = if workflows.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\nWorkflows you can pass to spawn_workflow: {}.",
                    workflows.join(", ")
                )
            };
            format!("{memory_prefix}{ORCHESTRATOR_SYSTEM}{roster}{workflow_roster}\n\n{RUNTIME_MCP_SYSTEM}\n\n{prompt}")
        } else {
            format!("{memory_prefix}{RUNTIME_MCP_SYSTEM}\n\n{prompt}")
        };
        let full_prompt = match include_runtime_context
            .then(|| self.runtime_context(project))
            .flatten()
        {
            Some(ctx) => format!("{ctx}\n\n{base_prompt}"),
            None => base_prompt,
        };
        let prepared_prompt = match crate::daemon::prompt::prepare_prompt(
            std::path::Path::new(&cwd),
            full_prompt,
            &attachments,
        ) {
            Ok(prompt) => prompt,
            Err(error) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(error);
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                return;
            }
        };
        if !prompt.is_empty() || !prepared_prompt.summaries.is_empty() {
            self.emit_session_unless_last_duplicate(
                task_id,
                wire::SessionUpdate::UserMessage {
                    text: prompt.to_string(),
                    attachments: prepared_prompt.summaries.clone(),
                },
            );
        }
        match spawn_acp_session(
            task_id.to_string(),
            command,
            cwd,
            prepared_prompt,
            resume,
            mcp_servers,
            self.acp_tx.clone(),
            Some(self.policy_tx.clone()),
            default_model,
            config_overrides,
            env,
        ) {
            Ok(handle) => {
                self.sessions.insert(task_id.to_string(), handle);
            }
            Err(e) => {
                if let Some(task) = self.tasks.get_mut(task_id) {
                    task.blocked_reason = Some(format!("failed to start agent: {e}"));
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
        }
    }

    pub(crate) fn emit_acp_session(&mut self, task_id: &str, update: wire::SessionUpdate) {
        if self.should_skip_resume_replay(task_id, &update) {
            return;
        }
        self.emit_session(task_id, update);
    }
}
