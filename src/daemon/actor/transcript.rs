use std::collections::VecDeque;

use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon, Event};

pub(crate) fn is_acp_replay_update(update: &wire::SessionUpdate) -> bool {
    match update {
        wire::SessionUpdate::UserMessage { .. }
        | wire::SessionUpdate::PermissionResolved { .. }
        | wire::SessionUpdate::PromptCapabilities { .. }
        | wire::SessionUpdate::WorkflowEvent { .. } => false,
        wire::SessionUpdate::AgentText { text } => {
            text != "Reconnecting to the saved agent session…"
                && !text.starts_with("⚠ No live agent session")
        }
        wire::SessionUpdate::AgentThought { .. }
        | wire::SessionUpdate::ToolCall { .. }
        | wire::SessionUpdate::FileEdit { .. }
        | wire::SessionUpdate::PermissionRequest { .. }
        | wire::SessionUpdate::Plan { .. }
        | wire::SessionUpdate::AvailableCommands { .. }
        | wire::SessionUpdate::TurnEnded { .. } => true,
        wire::SessionUpdate::Usage { .. } => false,
    }
}

/// The replayable subset of a task's persisted history, in order — the seed
/// for the resume replay guard. Built from the store on demand, because the
/// actor holds no full transcript in memory.
pub(crate) fn replayable_history(updates: &[wire::SessionUpdate]) -> VecDeque<wire::SessionUpdate> {
    updates
        .iter()
        .filter(|update| is_acp_replay_update(update))
        .cloned()
        .collect()
}

/// Fold a turn's updates into the two shapes the pipeline needs: the agent's
/// closing message and the whole turn. A new user message starts a fresh turn.
/// The input is the current-turn buffer, which is bounded by a turn, not by the
/// session's length.
pub(crate) fn stage_text_from_updates(updates: &[wire::SessionUpdate]) -> StageText {
    let mut full: Vec<String> = Vec::new();
    let mut closing: Vec<String> = Vec::new();
    for update in updates {
        match update {
            // A new user message starts a fresh turn.
            wire::SessionUpdate::UserMessage { .. } => {
                full.clear();
                closing.clear();
            }
            wire::SessionUpdate::AgentText { text } => {
                full.push(text.clone());
                closing.push(text.clone());
            }
            // Any work the agent does ends whatever it was narrating, so the
            // closing message restarts after it.
            wire::SessionUpdate::ToolCall { .. }
            | wire::SessionUpdate::FileEdit { .. }
            | wire::SessionUpdate::AgentThought { .. }
            | wire::SessionUpdate::Plan { .. } => closing.clear(),
            _ => {}
        }
    }
    StageText {
        closing: closing.join(""),
        full: full.join(""),
    }
}

/// Concatenate every `AgentText` update in a task's history — a task's full
/// text output, used as the orchestrator node's result. Computed off the actor
/// loop from the store (the actor holds no full transcript).
pub(crate) fn agent_text_from_updates(updates: &[wire::SessionUpdate]) -> String {
    updates
        .iter()
        .filter_map(|update| match update {
            wire::SessionUpdate::AgentText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

pub(crate) struct PendingSessionStart {
    pub(crate) project: String,
    pub(crate) agent: String,
    pub(crate) prompt: String,
    pub(crate) include_runtime_context: bool,
    pub(crate) attachments: Vec<wire::PromptAttachment>,
    pub(crate) default_model: Option<String>,
    pub(crate) config_overrides: std::collections::HashMap<String, String>,
}

/// A session that cannot start until its resume replay guard has been loaded
/// from the store. Carries everything `start_session` needs to resume.
pub(crate) struct PendingResume {
    pub(crate) project: String,
    pub(crate) agent: String,
    pub(crate) text: String,
    pub(crate) session_id: String,
    pub(crate) attachments: Vec<wire::PromptAttachment>,
    /// The task's model intent, re-applied to the loaded session. `None`
    /// keeps the resumed session's own model state, as before.
    pub(crate) default_model: Option<String>,
}

/// De-duplicates the ACP updates an agent replays on `session/load` against the
/// daemon's persisted history. While the replay matches history in order it is
/// dropped; the first mismatch is new live output and disables the guard.
pub(crate) struct ResumeReplayGuard {
    pub(crate) history: VecDeque<wire::SessionUpdate>,
}

impl ResumeReplayGuard {
    /// The replayable subset of `updates`, in order. `None` when there is
    /// nothing to de-duplicate (a session with no persisted history).
    pub(crate) fn from_updates(updates: &[wire::SessionUpdate]) -> Option<Self> {
        let history = replayable_history(updates);
        (!history.is_empty()).then_some(Self { history })
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.history.is_empty()
    }

    /// True when `update` is the next replayed update and should be dropped.
    /// False when it is live output (and the caller must disable the guard).
    pub(crate) fn consume(&mut self, update: &wire::SessionUpdate) -> bool {
        if self.history.front() == Some(update) {
            self.history.pop_front();
            true
        } else {
            false
        }
    }
}

/// A finished stage's text, split into the agent's closing message and the
/// whole turn. See [`Daemon::collect_stage_text`].
#[derive(Debug, Default, Clone)]
pub(crate) struct StageText {
    pub(crate) closing: String,
    pub(crate) full: String,
}

impl Daemon {
    /// Remove finished tasks' session transcripts older than the retention
    /// window, then fold the WAL back. All on a worker; the actor only sends
    /// the event. A `retention_days` of 0 (or a missing store) means "never".
    pub(crate) fn prune_transcripts(&self, retention_days: u32) {
        let persist = self.persist.clone();
        let store = self.store.clone();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            persist.flush().await;
            let cutoff =
                crate::daemon::task::now_secs() as i64 - (retention_days as i64) * 24 * 60 * 60;
            let deleted = crate::daemon::runtime::store_read(store, move |store| {
                let deleted = store.prune_finished_session_updates(cutoff)?;
                if deleted > 0 {
                    store.checkpoint_wal()?;
                }
                Ok::<usize, anyhow::Error>(deleted)
            })
            .await
            .map(|result| result.unwrap_or(0))
            .unwrap_or(0);
            if deleted > 0 {
                let _ = event_tx.send(Event::HistoryPruned {
                    updates: deleted as u64,
                });
            }
        });
    }

    /// The full retention sweep, off the loop:
    ///
    /// 1. Delete closed tasks' transcripts past `retention_days`.
    /// 2. Settle ignored diff-less waiting tasks past `settle_ignored_after_days`
    ///    (through the same `SettleTask` path as the button, so it is
    ///    reversible and permission-safe).
    /// 3. Delete untouched closed tasks past `delete_closed_after_days` via the
    ///    real `DeleteTask` path (worktree, backlog refs, workflow runs); a
    ///    closed task that still holds unmerged changes is kept instead.
    ///
    /// Settling runs before expiry so a task settled by stage 2 gets a fresh
    /// `updated_at` and cannot be expired by the same sweep.
    pub(crate) fn history_sweep(&self) {
        let config = crate::daemon::history_config::HistoryConfig::load();
        if config.retention_days > 0 {
            self.prune_transcripts(config.retention_days);
        }
        let persist = self.persist.clone();
        let store = self.store.clone();
        let cmd_tx = self.cmd_tx.clone();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            let now = crate::daemon::task::now_secs() as i64;
            let mut settled = 0u64;
            let mut expired = 0u64;
            let mut kept = 0u64;

            if config.settle_ignored_after_days > 0 {
                persist.flush().await;
                let cutoff = now - (config.settle_ignored_after_days as i64) * 24 * 60 * 60;
                let store_for_read = store.clone();
                let ids = crate::daemon::runtime::store_read(store_for_read, move |store| {
                    store.find_ignored_waiting_tasks(cutoff).unwrap_or_default()
                })
                .await
                .unwrap_or_default();
                for task_id in ids {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    if cmd_tx
                        .send(Command::SettleTask {
                            task_id: task_id.clone(),
                            reply: tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if rx.await.map(|r| r.is_ok()).unwrap_or(false) {
                        settled += 1;
                    }
                }
            }

            if config.delete_closed_after_days > 0 {
                persist.flush().await;
                let cutoff = now - (config.delete_closed_after_days as i64) * 24 * 60 * 60;
                let store_for_read = store.clone();
                let rows = crate::daemon::runtime::store_read(store_for_read, move |store| {
                    store.find_expired_closed_tasks(cutoff).unwrap_or_default()
                })
                .await
                .unwrap_or_default();
                for (task_id, files_changed) in rows {
                    if files_changed > 0 {
                        kept += 1;
                        continue;
                    }
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    if cmd_tx
                        .send(Command::DeleteTask {
                            id: task_id.clone(),
                            reply: tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if rx.await.map(|r| r.is_ok()).unwrap_or(false) {
                        expired += 1;
                    }
                }
            }

            if settled + expired + kept > 0 {
                let _ = event_tx.send(Event::HistorySwept {
                    settled,
                    expired,
                    kept,
                });
            }
        });
    }
}
