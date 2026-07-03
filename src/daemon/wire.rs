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
        Event::AgentSpawned { .. } | Event::AgentStatus { .. } | Event::AgentExited { .. } => None,
    }
}
