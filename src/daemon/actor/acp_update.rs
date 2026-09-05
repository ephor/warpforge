use warpforge_protocol as wire;

use crate::daemon::acp::AcpUpdate;
use crate::daemon::actor::transcript::StageText;
use crate::daemon::actor::{Daemon, Event};
use crate::daemon::task::TaskStatus;
use crate::daemon::wire as wireconv;

impl Daemon {
    pub(crate) async fn handle_acp_update(&mut self, task_id: String, update: AcpUpdate) {
        match update {
            AcpUpdate::SessionStarted { session_id } => {
                // A hard stop removes the handle before awaiting process exit.
                // Ignore an initialize reply that was already queued behind
                // that stop; otherwise it would resurrect the cancelled child
                // task as Running after task.cancel was acknowledged.
                if !self.sessions.contains_key(&task_id) {
                    return;
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.attach_session(session_id);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::AgentText(text) => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::AgentText { text })
            }
            AcpUpdate::AgentThought(text) => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::AgentThought { text })
            }
            AcpUpdate::ToolCall {
                id,
                title,
                status,
                kind,
                content,
            } => {
                let key = (task_id.clone(), id.clone());
                let started_at = *self.tool_call_starts.entry(key).or_insert_with(|| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                });
                self.emit_acp_session(
                    &task_id,
                    wire::SessionUpdate::ToolCall {
                        tool_call_id: id,
                        title,
                        status: wireconv::tool_status(&status),
                        started_at: Some(started_at),
                        tool_kind: kind,
                        content,
                    },
                )
            }
            AcpUpdate::Plan { entries } => {
                self.emit_acp_session(&task_id, wire::SessionUpdate::Plan { entries })
            }
            AcpUpdate::AvailableCommands { commands } => self.emit_acp_session(
                &task_id,
                wire::SessionUpdate::AvailableCommands { commands },
            ),
            AcpUpdate::ConfigOptions { options } => {
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    // A stale mismatch that the live session has since
                    // resolved (e.g. the agent applied the model late) must
                    // not linger.
                    let model_now_matches = task.model.as_ref().is_some_and(|intent| {
                        options
                            .iter()
                            .find(|o| crate::daemon::acp::is_model_selector(o))
                            .is_some_and(|o| &o.current_value == intent)
                    });
                    if model_now_matches {
                        task.blocked_reason = None;
                        task.blocked_kind = None;
                    }
                    task.config_options = options;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::Usage { used, size, cost } => self.emit_session_unless_last_duplicate(
                &task_id,
                wire::SessionUpdate::Usage { used, size, cost },
            ),
            AcpUpdate::PromptCapabilities {
                image,
                embedded_context,
            } => self.emit_session(
                &task_id,
                wire::SessionUpdate::PromptCapabilities {
                    image,
                    embedded_context,
                },
            ),
            AcpUpdate::FileEdit {
                path,
                tool_call_id,
                additions,
                deletions,
                hunks,
            } => {
                let update = wire::SessionUpdate::FileEdit {
                    path,
                    tool_call_id: Some(tool_call_id),
                    additions,
                    deletions,
                    hunks,
                };
                if self.should_skip_resume_replay(&task_id, &update) {
                    return;
                }
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.files_changed += 1;
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.emit_session(&task_id, update);
            }
            AcpUpdate::PermissionRequest {
                request_id,
                title,
                options,
                tool_call_id,
            } => {
                self.pending_permissions.record(&task_id, &request_id);
                self.emit_acp_session(
                    &task_id,
                    wire::SessionUpdate::PermissionRequest {
                        request_id,
                        title,
                        options,
                        tool_call_id,
                    },
                )
            }
            AcpUpdate::TurnEnded { stop_reason } => {
                // The CLI that just stopped working may have refreshed its
                // token; if it did so in the shared home, the vault that owns
                // that login is now stale. Ask before any of the early returns
                // below — a replayed or workflow turn rotates tokens too.
                self.capture_credentials();
                // A clean turn end completes the node; a "disconnected" stop is
                // the agent process dying, which we treat as a failure.
                let success = stop_reason != "disconnected";
                let workflow_child = self.workflow_child_of(&task_id).is_some();
                let update = wire::SessionUpdate::TurnEnded { stop_reason };
                if self.should_skip_resume_replay(&task_id, &update) {
                    return;
                }
                self.emit_session(&task_id, update);
                // Turn over: the ball is in the human's court either way, so the
                // status is just `Waiting`. This used to branch on
                // `files_changed` to pick `NeedsReview` vs `Idle` — one
                // lifecycle state spelled two ways, keyed off a field the task
                // already carries. Consumers that care whether there is a diff
                // read `files_changed` directly.
                //
                // Workflow children have different semantics: their output is
                // consumed by the pipeline, so the workflow handler below owns
                // their terminal/waiting status.
                if !workflow_child {
                    if let Some(task) = self.tasks.get_mut(&task_id) {
                        if task.status == TaskStatus::Running {
                            task.set_status(TaskStatus::Waiting);
                            let updated = task.clone();
                            self.persist(&updated);
                            self.emit(Event::TaskUpdated(updated));
                        }
                    }
                }
                if workflow_child {
                    // A workflow stage finished — advance the pipeline. Parse
                    // only the latest turn's text from the in-memory turn buffer
                    // (bounded by a turn): answered questions and superseded
                    // verdicts from earlier turns must not count. The legacy
                    // orchestrator inbox path does not apply here.
                    let text = self.collect_stage_text(&task_id);
                    self.workflow_stage_finished(&task_id, success, text).await;
                }
                // If we are an orchestrator whose sub-agents finished mid-turn,
                // process them now that the turn is over.
                if self.pending_wake.remove(&task_id) {
                    self.wake_parent(&task_id);
                }
                // The finished task's full text output is assembled off the loop
                // (write-behind flush + store read) and delivered back as
                // Command::TaskOutputReady, which notifies the orchestrator and
                // the parent inbox. Only ask for it when somebody consumes it:
                // both consumers are no-ops for an ordinary task, and reading
                // its whole transcript per turn would trade the memory this
                // change saves for disk it never needed to touch.
                if self.turn_output_has_consumer(&task_id, workflow_child) {
                    self.request_task_output(&task_id, success, workflow_child);
                }
            }
            AcpUpdate::ModelMismatch { message } => {
                // Non-fatal: the session keeps running, so no handle removal
                // and no status change — but the user must be able to see
                // later that the task is not on the model they asked for.
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.blocked_kind = Some(wire::TaskBlockedKind::ModelMismatch);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
            }
            AcpUpdate::Error {
                run_id,
                message,
                kind,
            } => {
                if self
                    .sessions
                    .get(&task_id)
                    .is_some_and(|handle| handle.run_id() != run_id)
                {
                    return;
                }
                let reason = message.clone();
                // Remove dead ACP handle so subsequent prompts trigger resume.
                self.sessions.remove(&task_id);
                self.pending_permissions.cleanup_task(&task_id);
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.blocked_reason = Some(message);
                    task.blocked_kind = kind;
                    // A lost session id refers to nothing, so keeping it would
                    // retry session/load and fail identically on every later
                    // prompt. Dropping it lets the next one start fresh; the
                    // conversation Warpforge stored is untouched either way.
                    if matches!(kind, Some(wire::TaskBlockedKind::SessionLost)) {
                        task.session_id = None;
                    }
                    task.set_status(TaskStatus::Blocked);
                    let updated = task.clone();
                    self.persist(&updated);
                    self.emit(Event::TaskUpdated(updated));
                }
                self.notify_orch_finished(&task_id, false, reason.clone());
                if self.workflow_child_of(&task_id).is_some() {
                    self.workflow_stage_finished(
                        &task_id,
                        false,
                        StageText {
                            closing: reason.clone(),
                            full: reason,
                        },
                    )
                    .await;
                } else {
                    self.deliver_child_result(&task_id, false, reason);
                }
            }
        }
    }
}
