use crate::daemon::actor::transcript::*;
/// Transcript memory: the daemon holds no full session transcript in memory,
/// only bounded projections. These tests pin the behavior of the projections
/// that replaced it.
use crate::daemon::actor::*;
use tokio::sync::oneshot;

/// A plain task's finished turn feeds nothing: the orchestrator hook is a
/// no-op without the tag, and there is no parent inbox. Assembling its
/// output would read the whole transcript back per turn — trading the
/// memory this projection saves for disk it never needed.
#[tokio::test]
async fn a_plain_task_does_not_assemble_turn_output() {
    let handle = Daemon::spawn(Vec::new(), None);
    let id = handle
        .create_task(
            "demo",
            "prompt",
            "agent",
            Vec::new(),
            false,
            false,
            None,
            Vec::new(),
            None,
            Default::default(),
            None,
        )
        .await;

    let (tx, rx) = oneshot::channel();
    handle
        .send(Command::TurnOutputConsumerProbe {
            task_id: id.clone(),
            workflow_child: false,
            reply: tx,
        })
        .await;
    assert!(!rx.await.unwrap(), "nothing consumes a plain task's output");

    // A sub-agent's parent does consume it.
    let child = handle
        .create_task(
            "demo",
            "child",
            "agent",
            Vec::new(),
            false,
            false,
            Some(id.clone()),
            Vec::new(),
            None,
            Default::default(),
            None,
        )
        .await;
    let (tx, rx) = oneshot::channel();
    handle
        .send(Command::TurnOutputConsumerProbe {
            task_id: child,
            workflow_child: false,
            reply: tx,
        })
        .await;
    assert!(rx.await.unwrap(), "a sub-agent's result feeds its parent");

    handle.shutdown().await;
}

/// A long, realistic history: alternating tool calls and streamed text
/// chunks, as a long agent turn produces.
fn long_history(turns: usize, chunks_per_turn: usize) -> Vec<wire::SessionUpdate> {
    let mut history = Vec::new();
    for turn in 0..turns {
        history.push(wire::SessionUpdate::UserMessage {
            text: format!("prompt {turn}"),
            attachments: vec![],
        });
        for chunk in 0..chunks_per_turn {
            history.push(wire::SessionUpdate::ToolCall {
                tool_call_id: format!("turn-{turn}-call-{chunk}"),
                title: "tool".into(),
                status: wire::ToolCallStatus::Completed,
                started_at: Some(1000 + (turn * chunks_per_turn + chunk) as u64),
                tool_kind: "read".into(),
                content: None,
            });
            history.push(wire::SessionUpdate::AgentText {
                text: format!("turn-{turn} chunk {chunk} "),
            });
        }
    }
    history
}

/// A resumed session replays its whole persisted history, update for
/// update, before producing live output. The guard must drop every replayed
/// update — a long history must not surface as duplicated output — and then
/// let live output through.
#[test]
fn resume_replay_guard_drops_long_replayed_history_whole() {
    let history = long_history(10, 20); // 410 updates, 400 of them replayable
    let mut guard = ResumeReplayGuard::from_updates(&history).expect("replayable history");

    // The guard only covers the replayable subset; user prompts are not
    // part of the agent's replay.
    let replayable = replayable_history(&history);
    let mut dropped = 0;
    for update in &replayable {
        if guard.consume(update) {
            dropped += 1;
        }
    }
    assert_eq!(
        dropped,
        replayable.len(),
        "every replayed update must be dropped — none may reach the UI twice"
    );
    assert!(guard.is_empty(), "guard exhausted after the replay");

    // Live output after the replay is never dropped.
    let live = wire::SessionUpdate::AgentText {
        text: "fresh output".into(),
    };
    assert!(!guard.consume(&live));
}

/// The guard reports non-matches so the caller (should_skip_resume_replay)
/// can disable it on the first divergence — otherwise a live update that
/// happens to equal a later entry of the old history would be eaten.
#[test]
fn resume_replay_guard_reports_divergence() {
    let history = long_history(1, 3);
    // history[0] is the user prompt (not replayable); the first replayed
    // update is history[1].
    let mut guard = ResumeReplayGuard::from_updates(&history).unwrap();
    assert!(guard.consume(&history[1]));
    assert!(
        !guard.consume(&wire::SessionUpdate::AgentText {
            text: "diverged".into()
        }),
        "a divergent update must be reported so the guard can be disabled"
    );
}

/// Stage text must reflect only the latest turn: after several turns, the
/// closing message and the full-turn text must not leak earlier turns' text.
#[test]
fn stage_text_is_scoped_to_the_latest_turn() {
    let history = vec![
        wire::SessionUpdate::UserMessage {
            text: "first".into(),
            attachments: vec![],
        },
        wire::SessionUpdate::AgentText {
            text: "old turn text ".into(),
        },
        wire::SessionUpdate::UserMessage {
            text: "second".into(),
            attachments: vec![],
        },
        wire::SessionUpdate::AgentText {
            text: "work ".into(),
        },
        wire::SessionUpdate::ToolCall {
            tool_call_id: "c1".into(),
            title: "tool".into(),
            status: wire::ToolCallStatus::Completed,
            started_at: Some(2000),
            tool_kind: "read".into(),
            content: None,
        },
        wire::SessionUpdate::AgentText {
            text: "final message".into(),
        },
    ];
    let text = stage_text_from_updates(&history);
    assert_eq!(
        text.full, "work final message",
        "earlier turns must not leak into full"
    );
    assert_eq!(
        text.closing, "final message",
        "tool call restarts the closing message"
    );
}

/// The orchestrator's node result is the task's whole text output,
/// including text from every turn.
#[test]
fn agent_text_spans_every_turn() {
    let history = long_history(3, 2);
    let text = agent_text_from_updates(&history);
    assert_eq!(text, "turn-0 chunk 0 turn-0 chunk 1 turn-1 chunk 0 turn-1 chunk 1 turn-2 chunk 0 turn-2 chunk 1 ");
}

/// The replayable subset skips the "Reconnecting…" placeholder the daemon
/// emits before a resume, so it is never replayed back as agent output.
#[test]
fn replayable_history_excludes_reconnect_placeholder() {
    let history = vec![
        wire::SessionUpdate::AgentText {
            text: "Reconnecting to the saved agent session…".into(),
        },
        wire::SessionUpdate::AgentText {
            text: "real text".into(),
        },
        wire::SessionUpdate::UserMessage {
            text: "prompt".into(),
            attachments: vec![],
        },
    ];
    let replayable = replayable_history(&history);
    assert_eq!(replayable.len(), 1);
    assert_eq!(replayable[0], history[1]);
}
