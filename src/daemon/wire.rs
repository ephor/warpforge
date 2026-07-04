//! Translation between the daemon's rich in-process types and the serializable
//! wire protocol (`warpforge-protocol`). Kept separate so the actor never has
//! to think about JSON, and so the wire shape can evolve independently of the
//! internal representation.

use warpforge_protocol as wire;

use crate::portforward::PfStatus;
use crate::service::ServiceStatus;

use super::actor::Event;
use super::task::{Task, TaskStatus};

pub fn service_status(s: &ServiceStatus) -> wire::ServiceStatus {
    match s {
        ServiceStatus::Starting => wire::ServiceStatus::Starting,
        ServiceStatus::Running => wire::ServiceStatus::Running,
        ServiceStatus::Stopped => wire::ServiceStatus::Stopped,
        ServiceStatus::Failed => wire::ServiceStatus::Failed,
    }
}

pub fn pf_status(s: &PfStatus) -> wire::PortForwardStatus {
    match s {
        PfStatus::Starting => wire::PortForwardStatus::Starting,
        PfStatus::Active => wire::PortForwardStatus::Active,
        PfStatus::Restarting => wire::PortForwardStatus::Restarting,
        PfStatus::Failed => wire::PortForwardStatus::Failed,
        PfStatus::Stopped => wire::PortForwardStatus::Stopped,
    }
}

/// Serialize a vt100 parser's current screen into the wire form: per-row
/// run-length styled spans, so clients render without a terminal emulator.
pub fn terminal_screen(parser: &vt100::Parser) -> wire::TerminalScreen {
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let (cur_row, cur_col) = screen.cursor_position();

    let mut rows_content = Vec::with_capacity(rows as usize);
    for r in 0..rows {
        let mut spans: Vec<wire::StyledSpan> = Vec::new();
        let mut run: Option<wire::StyledSpan> = None;
        for c in 0..cols {
            let (text, fg, bg, bold, inverse) = match screen.cell(r, c) {
                Some(cell) => {
                    let t = cell.contents();
                    let t = if t.is_empty() { " ".to_string() } else { t };
                    (t, color_str(cell.fgcolor()), color_str(cell.bgcolor()), cell.bold(), cell.inverse())
                }
                None => (" ".to_string(), None, None, false, false),
            };
            match run.as_mut() {
                Some(s) if s.fg == fg && s.bg == bg && s.bold == bold && s.inverse == inverse => {
                    s.text.push_str(&text);
                }
                _ => {
                    if let Some(s) = run.take() {
                        spans.push(s);
                    }
                    run = Some(wire::StyledSpan { text, fg, bg, bold, inverse });
                }
            }
        }
        if let Some(s) = run.take() {
            spans.push(s);
        }
        rows_content.push(spans);
    }

    wire::TerminalScreen { cols, rows, cursor: (cur_row, cur_col), rows_content }
}

/// Encode a vt100 colour compactly: `None` = default, `#rrggbb` = truecolor,
/// `i<n>` = 256-colour palette index. Clients decode the inverse.
fn color_str(c: vt100::Color) -> Option<String> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(format!("i{i}")),
        vt100::Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

pub fn tool_status(s: &str) -> wire::ToolCallStatus {
    match s {
        "pending" => wire::ToolCallStatus::Pending,
        "completed" => wire::ToolCallStatus::Completed,
        "failed" => wire::ToolCallStatus::Failed,
        _ => wire::ToolCallStatus::InProgress,
    }
}

pub fn task_status(s: &TaskStatus) -> wire::TaskStatus {
    match s {
        TaskStatus::Queued => wire::TaskStatus::Queued,
        TaskStatus::Running => wire::TaskStatus::Running,
        TaskStatus::NeedsReview => wire::TaskStatus::NeedsReview,
        TaskStatus::Done => wire::TaskStatus::Done,
        TaskStatus::Blocked => wire::TaskStatus::Blocked,
        TaskStatus::Interrupted => wire::TaskStatus::Interrupted,
    }
}

pub fn task_info(t: &Task) -> wire::TaskInfo {
    wire::TaskInfo {
        id: t.id.clone(),
        project: t.project.clone(),
        prompt: t.prompt.clone(),
        agent: t.agent.clone(),
        status: task_status(&t.status),
        tags: t.tags.clone(),
        created_at: t.created_at,
        updated_at: t.updated_at,
        files_changed: t.files_changed,
        blocked_reason: t.blocked_reason.clone(),
    }
}

/// Translate an internal event to a wire event, if it has one.
///
/// PTY-agent events are intentionally omitted for now: the desktop client works
/// through ACP task sessions, not the legacy terminal agents. Stage 3 adds
/// serialized `TerminalScreen` events for the TUI-over-socket case.
pub fn to_wire(ev: &Event) -> Option<wire::Event> {
    match ev {
        Event::ServiceStatus { project, service, status, allocated_port } => {
            Some(wire::Event::ServiceStatus {
                project: project.clone(),
                service: service.clone(),
                status: service_status(status),
                allocated_port: *allocated_port,
            })
        }
        Event::ServiceLog { project, service, line } => Some(wire::Event::ServiceLog {
            project: project.clone(),
            service: service.clone(),
            seq: 0,
            line: line.clone(),
        }),
        Event::PortForwardStatus { project, name, status } => {
            Some(wire::Event::PortForwardStatus {
                project: project.clone(),
                name: name.clone(),
                status: pf_status(status),
            })
        }
        Event::PortForwardLog { project, name, line } => Some(wire::Event::PortForwardLog {
            project: project.clone(),
            name: name.clone(),
            seq: 0,
            line: line.clone(),
        }),
        Event::TaskCreated(t) => Some(wire::Event::TaskCreated(task_info(t))),
        Event::TaskUpdated(t) => Some(wire::Event::TaskUpdated(task_info(t))),
        Event::SessionUpdate { task_id, update } => Some(wire::Event::SessionUpdate {
            task_id: task_id.clone(),
            update: update.clone(),
        }),
        Event::TerminalScreen { terminal_id, screen } => Some(wire::Event::TerminalScreen {
            terminal_id: terminal_id.clone(),
            screen: screen.clone(),
        }),
        Event::AgentExited { id } => Some(wire::Event::TerminalExited {
            terminal_id: id.clone(),
            code: 0,
        }),
        Event::AgentsSetupNeeded { detected } => {
            Some(wire::Event::AgentsSetupNeeded { detected: detected.clone() })
        }
        Event::AgentsUpdated { agents } => {
            Some(wire::Event::AgentsUpdated { agents: agents.clone() })
        }
        // Internal-only: the wire conveys terminals via screen/exited events.
        Event::AgentSpawned { .. } | Event::AgentStatus { .. } => None,
    }
}
