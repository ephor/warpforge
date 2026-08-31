//! Folding a raw session history into the bounded shape the desktop snapshot
//! wants. The raw rows stay in SQLite untouched — see
//! [`super::Store::load_all_session_updates_raw`] for why that distinction is
//! load-bearing.

use warpforge_protocol as wire;

/// Keep projected desktop state bounded like t3code's thread projector. Raw
/// rows stay durable in SQLite for agent resume/replay.
pub(crate) const MAX_SESSION_SNAPSHOT_UPDATES: usize = 2_000;
const SNAPSHOT_TRIM_HEADROOM: usize = 256;

fn append_snapshot_update(output: &mut Vec<wire::SessionUpdate>, update: wire::SessionUpdate) {
    match update {
        wire::SessionUpdate::AgentText { text } => {
            if let Some(wire::SessionUpdate::AgentText { text: previous }) = output.last_mut() {
                previous.push_str(&text);
            } else {
                output.push(wire::SessionUpdate::AgentText { text });
            }
        }
        wire::SessionUpdate::AgentThought { text } => {
            if let Some(wire::SessionUpdate::AgentThought { text: previous }) = output.last_mut() {
                previous.push_str(&text);
            } else {
                output.push(wire::SessionUpdate::AgentThought { text });
            }
        }
        wire::SessionUpdate::ToolCall {
            tool_call_id,
            title,
            status,
            started_at,
            tool_kind,
            content,
        } => {
            let existing = output.iter_mut().rev().find(|candidate| {
                matches!(
                    candidate,
                    wire::SessionUpdate::ToolCall {
                        tool_call_id: candidate_id,
                        ..
                    } if candidate_id == &tool_call_id
                )
            });
            if let Some(wire::SessionUpdate::ToolCall {
                title: previous_title,
                status: previous_status,
                started_at: previous_started_at,
                tool_kind: previous_kind,
                content: previous_content,
                ..
            }) = existing
            {
                if !title.is_empty() && title != tool_call_id {
                    *previous_title = title;
                }
                *previous_status = status;
                if previous_started_at.is_none() {
                    *previous_started_at = started_at;
                }
                if !tool_kind.is_empty() {
                    *previous_kind = tool_kind;
                }
                if content.is_some() {
                    *previous_content = content;
                }
            } else {
                output.push(wire::SessionUpdate::ToolCall {
                    tool_call_id,
                    title,
                    status,
                    started_at,
                    tool_kind,
                    content,
                });
            }
        }
        wire::SessionUpdate::FileEdit {
            path,
            tool_call_id: Some(tool_call_id),
            additions,
            deletions,
            hunks,
        } => {
            let existing = output.iter_mut().rev().find(|candidate| {
                matches!(
                    candidate,
                    wire::SessionUpdate::FileEdit {
                        tool_call_id: Some(candidate_id),
                        ..
                    } if candidate_id == &tool_call_id
                )
            });
            if let Some(wire::SessionUpdate::FileEdit {
                path: previous_path,
                additions: previous_additions,
                deletions: previous_deletions,
                hunks: previous_hunks,
                ..
            }) = existing
            {
                if !path.is_empty() {
                    *previous_path = path;
                }
                if additions.is_some() {
                    *previous_additions = additions;
                }
                if deletions.is_some() {
                    *previous_deletions = deletions;
                }
                if !hunks.is_empty() {
                    *previous_hunks = hunks;
                }
            } else {
                output.push(wire::SessionUpdate::FileEdit {
                    path,
                    tool_call_id: Some(tool_call_id),
                    additions,
                    deletions,
                    hunks,
                });
            }
        }
        update => output.push(update),
    }
}

/// Fold a raw history into the shape the desktop snapshot wants: streamed text
/// concatenated, repeated tool frames collapsed, oldest entries dropped past
/// the cap.
pub fn fold_for_snapshot(updates: &[wire::SessionUpdate]) -> Vec<wire::SessionUpdate> {
    let mut output: Vec<wire::SessionUpdate> = Vec::new();
    for update in updates {
        append_snapshot_update(&mut output, update.clone());
        if output.len() > MAX_SESSION_SNAPSHOT_UPDATES + SNAPSHOT_TRIM_HEADROOM {
            let overflow = output.len() - MAX_SESSION_SNAPSHOT_UPDATES;
            output.drain(..overflow);
        }
    }
    if output.len() > MAX_SESSION_SNAPSHOT_UPDATES {
        let overflow = output.len() - MAX_SESSION_SNAPSHOT_UPDATES;
        output.drain(..overflow);
    }
    output
}
