use warpforge_protocol as wire;

use crate::daemon::actor::transcript::agent_text_from_updates;
use crate::daemon::actor::transcript::is_acp_replay_update;
use crate::daemon::actor::transcript::replayable_history;
use crate::daemon::actor::transcript::stage_text_from_updates;
use crate::daemon::actor::transcript::StageText;
use crate::daemon::actor::{ChildResult, Command, Daemon, Event};
use crate::daemon::task::TaskStatus;

impl Daemon {
    pub(crate) fn mark_task_running(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            if task.status != TaskStatus::Done {
                task.blocked_reason = None;
                task.blocked_kind = None;
                task.set_status(TaskStatus::Running);
                // Reactivate lifecycle: clear settle/snooze when task starts running
                task.settled_override = None;
                task.settled_at = None;
                task.snoozed_until = None;
                task.snoozed_at = None;
                let updated = task.clone();
                self.persist(&updated);
                self.emit(Event::TaskUpdated(updated));
            }
        }
    }

    /// Emit unless this is byte-for-byte the update that went out last for the
    /// task — a reconnect retry re-sending a prompt, or a repeated usage frame.
    ///
    /// The comparison is against what this daemon last emitted, held in memory.
    /// It used to `SELECT` the last persisted row, which write-behind
    /// persistence makes wrong as well as slow: the row it needs is usually
    /// still in the queue, so every duplicate would slip through.
    pub(crate) fn emit_session_unless_last_duplicate(
        &mut self,
        task_id: &str,
        update: wire::SessionUpdate,
    ) {
        if self.last_session_update.get(task_id) == Some(&update) {
            return;
        }
        self.emit_session(task_id, update);
    }

    /// Ask a worker to read this task's persisted history off the loop and send
    /// the replay guard back as [`Command::ResumeReplayReady`]. The session does
    /// not start until then (see the SessionPrompt resume path).
    pub(crate) fn request_resume_replay_guard(&self, task_id: &str) {
        let persist = self.persist.clone();
        let store = self.store.clone();
        let cmd_tx = self.cmd_tx.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            persist.flush().await;
            let lookup = task_id.clone();
            let replay = crate::daemon::runtime::store_read(store, move |store| {
                store
                    .load_session_updates(&lookup)
                    .map(|updates| replayable_history(&updates))
                    .unwrap_or_default()
            })
            .await
            .unwrap_or_default();
            let _ = cmd_tx
                .send(Command::ResumeReplayReady { task_id, replay })
                .await;
        });
    }

    /// Whether anything reads a finished turn's full text output.
    ///
    /// `notify_orch_finished` is a no-op unless the task is an orchestrator
    /// node, and `deliver_child_result` returns early without a parent — and it
    /// is skipped entirely for a workflow stage, which reads its own turn
    /// buffer instead. For everything else the assembled output is discarded,
    /// so it should never be assembled.
    pub(crate) fn turn_output_has_consumer(&self, task_id: &str, workflow_child: bool) -> bool {
        let Some(task) = self.tasks.get(task_id) else {
            return false;
        };
        let orchestrator_node =
            self.orch_tx.is_some() && task.tags.iter().any(|tag| tag == "orchestrator");
        let feeds_parent = !workflow_child && task.parent_task_id.is_some();
        orchestrator_node || feeds_parent
    }

    /// Ask a worker to assemble a finished task's full text output off the loop
    /// and send it back as [`Command::TaskOutputReady`], so the orchestrator /
    /// parent-inbox delivery never blocks the actor on a disk read.
    pub(crate) fn request_task_output(&self, task_id: &str, success: bool, workflow_child: bool) {
        let persist = self.persist.clone();
        let store = self.store.clone();
        let cmd_tx = self.cmd_tx.clone();
        let task_id = task_id.to_string();
        // Without a database the actor's turn buffer is the only history there
        // is; hand it back rather than an empty result.
        let fallback = agent_text_from_updates(
            self.turn_updates
                .get(&task_id)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        tokio::spawn(async move {
            persist.flush().await;
            let lookup = task_id.clone();
            let output = crate::daemon::runtime::store_read(store, move |store| {
                store
                    .load_session_updates(&lookup)
                    .map(|updates| agent_text_from_updates(&updates))
                    .unwrap_or_default()
            })
            .await
            // Without a database the actor's turn buffer is the only history.
            .unwrap_or(fallback);
            let _ = cmd_tx
                .send(Command::TaskOutputReady {
                    task_id,
                    success,
                    workflow_child,
                    output,
                })
                .await;
        });
    }

    pub(crate) fn should_skip_resume_replay(
        &mut self,
        task_id: &str,
        update: &wire::SessionUpdate,
    ) -> bool {
        if !is_acp_replay_update(update) {
            return false;
        }

        let Some(guard) = self.resume_replay.get_mut(task_id) else {
            return false;
        };

        if guard.consume(update) {
            if guard.is_empty() {
                self.resume_replay.remove(task_id);
            }
            return true;
        }

        // First mismatch means the agent has moved past replay into live output
        // (or its replay shape differs from ours). Stop filtering immediately.
        self.resume_replay.remove(task_id);
        false
    }

    /// Like [`agent_text_from_updates`], but only the text streamed since the
    /// last user message — i.e. the output of the task's latest turn. The
    /// workflow engine parses this: a `need_user_input` block answered two turns
    /// ago must not be mistaken for a fresh question.
    pub(crate) fn collect_last_turn_text(&self, task_id: &str) -> String {
        self.collect_stage_text(task_id).full
    }

    /// A finished stage's output, in the two shapes the pipeline needs.
    ///
    /// `closing` is the agent's final message — the text streamed after its
    /// last tool call or file edit. That is what the stage prompts ask for
    /// ("your final message should summarize what you did") and what a human
    /// reads as the result, so it is what reviewers and fixers are handed.
    /// `full` is every chunk of the turn, kept as a parsing fallback for an
    /// agent that emits its protocol block before a trailing tool call.
    ///
    /// Reads the in-memory current-turn buffer (bounded by a turn, reset on
    /// each user message), not the whole session transcript.
    pub(crate) fn collect_stage_text(&self, task_id: &str) -> StageText {
        let updates = self
            .turn_updates
            .get(task_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        stage_text_from_updates(updates)
    }

    /// Tell the orchestrator a dispatched task finished. No-op unless the task
    /// carries the "orchestrator" tag and an orchestrator is wired.
    pub(crate) fn notify_orch_finished(&self, task_id: &str, success: bool, result: String) {
        let Some(orch_tx) = self.orch_tx.clone() else {
            return;
        };
        let is_orch = self
            .tasks
            .get(task_id)
            .is_some_and(|t| t.tags.iter().any(|tag| tag == "orchestrator"));
        if !is_orch {
            return;
        }
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            let _ = orch_tx
                .send(crate::orchestration::OrchCommand::TaskFinished {
                    task_id,
                    result,
                    success,
                })
                .await;
        });
    }

    /// If `child_id` was spawned by an orchestrator, queue its result in the
    /// parent's inbox and (if the parent is idle) wake it.
    pub(crate) fn deliver_child_result(&mut self, child_id: &str, success: bool, output: String) {
        let Some(child) = self.tasks.get(child_id) else {
            return;
        };
        let Some(parent_id) = child.parent_task_id.clone() else {
            return;
        };
        let result = ChildResult {
            child_id: child_id.to_string(),
            agent: child.agent.clone(),
            prompt: child.prompt.clone(),
            output,
            success,
        };
        self.orchestrator_inbox
            .entry(parent_id.clone())
            .or_default()
            .push(result);
        // Wake now if the orchestrator is idle; otherwise defer to its turn end.
        let running = self
            .tasks
            .get(&parent_id)
            .is_some_and(|t| t.status == TaskStatus::Running);
        if running {
            self.pending_wake.insert(parent_id);
        } else {
            self.wake_parent(&parent_id);
        }
    }

    /// Inject a system nudge into an orchestrator's session so it drains its
    /// inbox. No-op if the inbox is empty.
    pub(crate) fn wake_parent(&mut self, parent_id: &str) {
        let pending = self
            .orchestrator_inbox
            .get(parent_id)
            .map_or(0, |v| v.len());
        if pending == 0 {
            return;
        }
        let Some(handle) = self.sessions.get(parent_id).cloned() else {
            // Orchestrator session isn't live right now (e.g. it ended while a
            // sub-agent was still running). Keep the results queued and retry
            // the nudge when the parent next runs (its next turn end).
            self.pending_wake.insert(parent_id.to_string());
            return;
        };
        self.mark_task_running(parent_id);
        let _ = handle.prompt(crate::daemon::prompt::PreparedPrompt {
            content: vec![crate::daemon::prompt::PromptContent::Text(format!(
                "[System] {pending} sub-agent result(s) ready in your inbox. \
                 Call the read_inbox tool to collect them, then decide what to do next."
            ))],
            summaries: vec![],
            has_images: false,
        });
    }

    pub(crate) fn emit_session(&mut self, task_id: &str, update: wire::SessionUpdate) {
        self.persist.session_update(task_id, &update);
        // A new user message begins a fresh turn: drop the previous turn's
        // buffer so stage-text reads stay bounded by a turn, not the session.
        if matches!(update, wire::SessionUpdate::UserMessage { .. }) {
            self.turn_updates.remove(task_id);
        }
        self.turn_updates
            .entry(task_id.to_string())
            .or_default()
            .push(update.clone());
        self.last_session_update
            .insert(task_id.to_string(), update.clone());
        self.emit(Event::SessionUpdate {
            task_id: task_id.to_string(),
            update,
        });
    }

    pub(crate) fn has_pending_permission(&self, task_id: &str) -> bool {
        self.pending_permissions.has_pending(task_id)
    }
}
