//! Wire entry point for `automation.*` RPCs: builds a [`Command`] per method
//! and serializes the actor's reply. Kept out of `server.rs` because the
//! daemon-side dispatcher there is already far past its line budget.

use serde_json::json;
use tokio::sync::oneshot;

use warpforge_protocol as wire;

use crate::daemon::actor::{Command, DaemonHandle};

fn rpc_error(message: impl Into<String>) -> wire::RpcError {
    wire::RpcError {
        code: wire::ErrorCode::InvalidRequest,
        message: message.into(),
    }
}

pub async fn dispatch(
    handle: &DaemonHandle,
    method: wire::Method,
) -> Result<serde_json::Value, wire::RpcError> {
    match method {
        wire::Method::AutomationList { project } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::AutomationList { project, reply: tx })
                .await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|automations| json!({ "automations": automations }))
                .map_err(rpc_error)
        }
        wire::Method::AutomationShow { id } => {
            let (tx, rx) = oneshot::channel();
            handle.send(Command::AutomationShow { id, reply: tx }).await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|automation| json!(automation))
                .map_err(rpc_error)
        }
        wire::Method::AutomationCreate {
            project,
            name,
            prompt,
            agent,
            model,
            config_overrides,
            trigger,
            timezone,
            precheck,
            enabled,
            missed_run_grace_minutes,
            reuse_session,
            worktree,
        } => {
            let automation = wire::Automation {
                id: uuid::Uuid::new_v4().to_string(),
                project,
                name,
                prompt,
                agent,
                model,
                config_overrides,
                trigger,
                timezone,
                precheck,
                enabled,
                missed_run_grace_minutes,
                reuse_session,
                worktree,
                created_at: 0,
                updated_at: 0,
                next_run_at: None,
                last_run_at: None,
                last_status: None,
                last_task_id: None,
            };
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::AutomationCreate {
                    automation: Box::new(automation),
                    reply: tx,
                })
                .await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|automation| json!(automation))
                .map_err(rpc_error)
        }
        wire::Method::AutomationUpdate { id, patch } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::AutomationUpdate {
                    id,
                    patch: Box::new(patch),
                    reply: tx,
                })
                .await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|automation| json!(automation))
                .map_err(rpc_error)
        }
        wire::Method::AutomationDelete { id } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::AutomationDelete { id, reply: tx })
                .await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|()| json!({ "ok": true }))
                .map_err(rpc_error)
        }
        wire::Method::AutomationRunNow { id } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::AutomationRunNow { id, reply: tx })
                .await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|run| json!(run))
                .map_err(rpc_error)
        }
        wire::Method::AutomationRuns { id, limit } => {
            let (tx, rx) = oneshot::channel();
            handle
                .send(Command::AutomationRuns {
                    id,
                    limit,
                    reply: tx,
                })
                .await;
            rx.await
                .unwrap_or_else(|_| Err("daemon dropped the reply".into()))
                .map(|runs| json!({ "runs": runs }))
                .map_err(rpc_error)
        }
        _ => Err(rpc_error("not an automation method")),
    }
}
