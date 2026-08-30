use std::collections::HashMap;

use anyhow::Result;

use warpforge_protocol as wire;

use crate::daemon::actor::{Daemon, Event};
use crate::daemon::runtime::Write as PersistWrite;
use crate::daemon::task::{Task, TaskStatus};
use crate::daemon::workflow::{RunState, StageKind, WorkflowRun};
use crate::daemon::worktree::WorktreeManager;

// ─── Workflow pipeline engine (actor glue) ───────────────────────────────────
//
// The deterministic `plan? → implement → review ⇄ fix` pipeline. Pure logic
// (state container, prompt building, verdict parsing, review merging) lives in
// `daemon/workflow.rs`; these methods are the side-effectful glue: they spawn
// stage child tasks, react to their turn ends, and narrate progress into the
// parent task's transcript.
//
// Borrow discipline: methods that mutate a run *and* call `&mut self` helpers
// temporarily remove the run from `workflow_runs` and re-insert it (the
// take/put pattern). Every exit path must re-insert.

impl Daemon {
    pub(crate) fn workflow_is_active(&self, task_id: &str) -> bool {
        self.workflow_runs
            .get(task_id)
            .is_some_and(WorkflowRun::is_active)
    }

    /// The parent task id of an *active* pipeline this child belongs to.
    /// Searches the runs (not the tasks map) so it also works for tasks that
    /// were just removed.
    pub(crate) fn workflow_child_of(&self, child_id: &str) -> Option<String> {
        self.workflow_runs
            .values()
            .find(|run| {
                run.is_active()
                    && (run.active_children.contains_key(child_id)
                        || run.review_pending.contains_key(child_id))
            })
            .map(|run| run.parent_id.clone())
    }

    /// Deliver a follow-up into an existing stage session. Returns false when
    /// the session is gone — checking `is_alive()` matters because
    /// `AcpHandle::prompt` succeeds even for a dead child (its channel belongs
    /// to the driver task, which outlives the process), and a prompt sent into
    /// a corpse simply vanishes.
    pub(crate) fn workflow_followup(&mut self, child_id: &str, text: String) -> bool {
        let delivered = self
            .sessions
            .get(child_id)
            .filter(|handle| handle.is_alive())
            .map(|handle| {
                handle
                    .prompt(crate::daemon::prompt::PreparedPrompt {
                        content: vec![crate::daemon::prompt::PromptContent::Text(text.clone())],
                        summaries: vec![],
                        has_images: false,
                    })
                    .is_ok()
            })
            .unwrap_or(false);
        if delivered {
            self.emit_session(
                child_id,
                wire::SessionUpdate::UserMessage {
                    text,
                    attachments: vec![],
                },
            );
        }
        delivered
    }

    /// Append one durable, independently rendered workflow entry to the
    /// parent's Conversation. Structured events deliberately do not use
    /// AgentText: transport coalescing is correct for streamed agent chunks,
    /// but would glue unrelated workflow transitions into one Markdown blob.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn workflow_event(
        &mut self,
        parent_id: &str,
        event: wire::WorkflowEventKind,
        title: impl Into<String>,
        detail: Option<String>,
        stage: Option<StageKind>,
        agents: Vec<wire::WorkflowEventAgent>,
        tone: wire::WorkflowEventTone,
    ) {
        self.emit_session(
            parent_id,
            wire::SessionUpdate::WorkflowEvent {
                event,
                title: title.into(),
                detail,
                stage: stage.map(StageKind::wire),
                agents,
                tone,
            },
        );
    }

    /// Convenience wrapper for transitions that do not reference a particular
    /// agent. Split the first paragraph into the card title and keep the rest
    /// as Markdown detail.
    pub(crate) fn workflow_timeline(&mut self, parent_id: &str, text: impl Into<String>) {
        let text = text.into();
        let text = text.trim();
        let (heading, detail) = text
            .split_once("\n\n")
            .map(|(heading, detail)| (heading, Some(detail.trim().to_string())))
            .unwrap_or((text, None));
        let title = heading.trim_start_matches('#').trim().replace("**", "");
        let lower = text.to_ascii_lowercase();
        let tone = if lower.contains("failed") || lower.contains("stopped") {
            wire::WorkflowEventTone::Error
        } else if lower.contains("changes requested")
            || lower.contains("limit reached")
            || lower.contains("needs your input")
        {
            wire::WorkflowEventTone::Warning
        } else if lower.contains("approved") || lower.contains("finished") {
            wire::WorkflowEventTone::Success
        } else {
            wire::WorkflowEventTone::Info
        };
        let event = if lower.starts_with("workflow")
            && (lower.contains("finished") || lower.contains("failed") || lower.contains("stopped"))
        {
            wire::WorkflowEventKind::WorkflowFinished
        } else {
            wire::WorkflowEventKind::Status
        };
        self.workflow_event(parent_id, event, title, detail, None, Vec::new(), tone);
    }

    /// Sync the parent task's `workflow_run` + `orchestration_graph`
    /// projections from the run, persist, and broadcast; also persist the run.
    pub(crate) fn workflow_sync(&mut self, run: &WorkflowRun) {
        if let Some(task) = self.tasks.get_mut(&run.parent_id) {
            // The coarse task status describes whether work is executing, while
            // workflow_run.waiting carries the precise barrier reason.
            let active_status = match run.state {
                RunState::Running { .. } => Some(TaskStatus::Running),
                RunState::AwaitingReply { .. }
                | RunState::AwaitingLimitDecision
                | RunState::Paused { .. } => Some(TaskStatus::Waiting),
                RunState::Done | RunState::Failed => None,
            };
            if let Some(status) = active_status {
                if task.status != status {
                    task.set_status(status);
                }
            }
            task.workflow_run = Some(run.wire_info());
            task.orchestration_graph = Some(run.graph_info());
            task.updated_at = crate::daemon::task::now_secs();
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
        if let Ok(json) = serde_json::to_string(run) {
            self.persist.workflow_run(&run.parent_id, json);
        }
    }

    /// Workflow stage tasks are execution records, not independent changes to
    /// review. Keep their lifecycle aligned with the stage state and emit the
    /// update immediately so Board/Subtasks never retain a stale generic
    /// turn-end status.
    pub(crate) fn workflow_set_child_status(&mut self, child_id: &str, status: TaskStatus) {
        if let Some(task) = self.tasks.get_mut(child_id) {
            if task.status == status {
                return;
            }
            task.set_status(status);
            let updated = task.clone();
            self.persist(&updated);
            self.emit(Event::TaskUpdated(updated));
        }
    }

    /// `CreateWorkflowTask`: validate the workflow, create the parent task
    /// (without an agent session), and start the first stage.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn workflow_create(
        &mut self,
        project: String,
        prompt: String,
        agent: String,
        tags: Vec<String>,
        use_worktree: bool,
        workflow_id: String,
        attachments: Vec<wire::PromptAttachment>,
        default_model: Option<String>,
        include_runtime_context: bool,
        config_overrides: HashMap<String, String>,
        parent_task_id: Option<String>,
    ) -> Result<String, String> {
        let path = self
            .project_path(&project)
            .ok_or_else(|| format!("unknown project '{project}'"))?;
        if self.store.is_none() {
            // Stage results are read back out of the persisted transcript, so
            // without a store every stage would look like it produced nothing.
            return Err(
                "workflows need the local database, which failed to open — check \
                 ~/.warpforge and restart the daemon"
                    .to_string(),
            );
        }
        let loaded =
            crate::workflow_config::load_workflow(std::path::Path::new(&path), &workflow_id)
                .ok_or_else(|| format!("unknown workflow `{workflow_id}`"))?;
        let warnings = loaded.warnings.clone();
        let spec = loaded
            .spec
            .map_err(|e| format!("workflow `{workflow_id}` is invalid: {e}"))?;

        let mut tags = tags;
        tags.push(format!("workflow:{workflow_id}"));
        let mut task = Task::new(&project, &prompt, &agent, tags);
        task.parent_task_id = parent_task_id;
        // An explicit lead model from the dialog is the task's model intent.
        task.model = default_model.clone();
        if use_worktree {
            let wt_mgr = self
                .worktrees
                .entry(project.clone())
                .or_insert_with(|| WorktreeManager::new(std::path::PathBuf::from(&path)));
            match wt_mgr.create(&task.id, None).await {
                Ok(wt) => task.worktree = Some(wt.path.to_string_lossy().to_string()),
                Err(e) => eprintln!("[daemon] worktree creation failed: {e}"),
            }
        }
        // The parent is "running" for the whole life of the pipeline.
        task.set_status(TaskStatus::Running);
        let resolved_model = default_model.or_else(|| {
            self.configured_agents
                .iter()
                .find(|a| a.id == agent)
                .and_then(|a| a.last_model.clone())
        });
        let parent_id = task.id.clone();
        self.tasks.insert(parent_id.clone(), task.clone());
        self.persist(&task);
        self.emit(Event::TaskCreated(task));

        let run = WorkflowRun::new(
            parent_id.clone(),
            project,
            spec,
            agent,
            resolved_model,
            attachments,
            include_runtime_context,
            config_overrides,
        );
        self.workflow_event(
            &parent_id,
            wire::WorkflowEventKind::WorkflowStarted,
            format!("Workflow started: {}", run.spec.name),
            Some({
                let mut detail = format!(
                    "**Stages:** {}  \n**Review limit:** {} round(s)",
                    run.spec.stage_summary().join(" → "),
                    run.effective_max_rounds(),
                );
                // Warnings are otherwise only visible as a picker tooltip, so a
                // clamped limit or an ignored key would silently shape the run.
                if !warnings.is_empty() {
                    detail.push_str("\n\n**Workflow file warnings:**\n");
                    for warning in &warnings {
                        detail.push_str(&format!("- {warning}\n"));
                    }
                }
                detail
            }),
            None,
            Vec::new(),
            wire::WorkflowEventTone::Info,
        );
        let first = run.first_stage();
        self.workflow_runs.insert(parent_id.clone(), run);
        self.workflow_spawn_stage(&parent_id, first).await;
        Ok(parent_id)
    }

    /// Restore persisted runs after a daemon restart. Barrier states survive
    /// as-is; a run caught mid-stage converts to `Paused` at its last barrier
    /// (resume re-runs the interrupted stage from scratch).
    pub(crate) fn restore_workflow_runs(&mut self) {
        let rows = self
            .with_store(|store| store.load_workflow_runs().ok())
            .flatten()
            .unwrap_or_default();
        for (task_id, json) in rows {
            let Ok(mut run) = serde_json::from_str::<WorkflowRun>(&json) else {
                // Leaving the row in place would re-fail on every start while
                // the parent sits with no pipeline state and therefore no
                // pause/resume/stop controls. Say so, once, and move on.
                eprintln!("[daemon] dropping unreadable workflow run for task {task_id}");
                self.persist
                    .write(PersistWrite::DeleteWorkflowRun(task_id.clone()));
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason =
                        Some("workflow state could not be restored after an upgrade".to_string());
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                }
                continue;
            };
            if !self.tasks.contains_key(&task_id) {
                continue;
            }
            if run.is_active() {
                if let RunState::Running { stage } = run.state {
                    // Sessions died with the previous daemon: park at the
                    // barrier before the interrupted stage.
                    let children: Vec<String> = run.active_children.keys().cloned().collect();
                    for child in &children {
                        run.set_record_status(child, wire::OrchNodeStatus::Failed);
                    }
                    run.active_children.clear();
                    run.review_pending.clear();
                    run.review_collected.clear();
                    // Re-running a review re-increments `round` on spawn, so
                    // give the interrupted round back — otherwise a restart
                    // during round 2 of 2 resumes as "round 3/2" and lands
                    // straight on the limit decision.
                    if stage == StageKind::Review {
                        run.round = run.round.saturating_sub(1);
                    }
                    run.state = RunState::Paused { next: stage };
                    // The working copy may hold half-applied edits from the
                    // killed attempt; the re-run has to know that.
                    run.pending_guidance = Some(
                        "A previous attempt of this stage was interrupted by a daemon restart. \
                         The working copy may already contain its partial changes — inspect the \
                         current diff before assuming you are starting from scratch."
                            .to_string(),
                    );
                    self.workflow_timeline(
                        &task_id,
                        format!(
                            "Daemon restarted while stage **{}** was running. The pipeline is \
                             paused — resume to re-run that stage.",
                            stage.label()
                        ),
                    );
                }
                // The store normalizes Running → Interrupted on load; a live
                // pipeline parent is restored according to whether a stage is
                // executing or the runner is parked at a barrier.
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = None;
                    task.blocked_kind = None;
                    let status = match run.state {
                        RunState::Running { .. } => TaskStatus::Running,
                        RunState::AwaitingReply { .. }
                        | RunState::AwaitingLimitDecision
                        | RunState::Paused { .. } => TaskStatus::Waiting,
                        RunState::Done | RunState::Failed => task.status.clone(),
                    };
                    task.set_status(status);
                }
            }
            if let Some(task) = self.tasks.get_mut(&task_id) {
                task.workflow_run = Some(run.wire_info());
                task.orchestration_graph = Some(run.graph_info());
                let updated = task.clone();
                self.persist(&updated);
            }
            if let Ok(json) = serde_json::to_string(&run) {
                self.persist.workflow_run(&task_id, json);
            }
            self.workflow_runs.insert(task_id, run);
        }
    }
}
