//! MCP tools for managing scheduled automations from inside an agent session.
//! Thin wrappers over the same `automation.*` RPCs the desktop uses.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use warpforge_protocol as wire;

use super::DaemonClient;

pub fn tool_defs() -> Value {
    json!([
        {
            "name": "automation_create",
            "description": "Schedule a recurring prompt. Runs the prompt with the chosen agent (+ optional model) on a project at a cron schedule. Trigger is a preset (hourly/daily/weekdays/weekly/custom) plus a 5-field cron string; timezone is an IANA name (empty = daemon host). Optional precheck shell command: non-zero exit skips the run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Project name to run in." },
                    "name": { "type": "string" },
                    "prompt": { "type": "string" },
                    "agent": { "type": "string", "description": "claude, codex, opencode, ..." },
                    "model": { "type": "string", "description": "Optional per-automation model id." },
                    "preset": { "type": "string", "enum": ["hourly", "daily", "weekdays", "weekly", "custom"] },
                    "cron": { "type": "string", "description": "5-field cron (min hour dom month dow). Required when preset is custom; ignored otherwise." },
                    "timezone": { "type": "string", "description": "IANA zone, e.g. America/New_York. Empty = host zone." },
                    "precheck": { "type": "string", "description": "Shell command run before each scheduled run; non-zero exit skips it." },
                    "missed_run_grace_minutes": { "type": "integer", "description": "Runs an occurrence missed while the daemon was down only if it is younger than this. Default 720." },
                    "reuse_session": { "type": "boolean", "description": "Send each run into the previous run's task instead of creating a new one." },
                    "worktree": { "type": "boolean", "description": "Run each run in an isolated git worktree." }
                },
                "required": ["project", "name", "prompt", "agent"]
            }
        },
        {
            "name": "automation_list",
            "description": "List automations, optionally for one project. Includes next run time, last run status and enabled state.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" }
                }
            }
        },
        {
            "name": "automation_get",
            "description": "Read one automation by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "automation_update",
            "description": "Patch an automation: any subset of name, prompt, agent, model, trigger (preset/cron/timezone), precheck, enabled, missedRunGraceMinutes, reuseSession. Absent fields stay unchanged.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "prompt": { "type": "string" },
                    "agent": { "type": "string" },
                    "model": { "type": ["string", "null"] },
                    "preset": { "type": "string", "enum": ["hourly", "daily", "weekdays", "weekly", "custom"] },
                    "cron": { "type": "string" },
                    "timezone": { "type": "string" },
                    "precheck": { "type": ["string", "null"] },
                    "enabled": { "type": "boolean" },
                    "missedRunGraceMinutes": { "type": "integer" },
                    "reuseSession": { "type": "boolean" },
                    "worktree": { "type": "boolean" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "automation_delete",
            "description": "Delete an automation and its run history permanently.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "automation_run_now",
            "description": "Run an automation immediately, without waiting for its schedule. Skips the precheck; refuses if a run is already in flight; does not move the next scheduled occurrence.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "automation_runs",
            "description": "Run history for an automation, newest first: status, when scheduled, the daemon task each run used, and an output excerpt.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "limit": { "type": "integer" }
                },
                "required": ["id"]
            }
        }
    ])
}

fn resolve_trigger(preset: Option<&str>, cron: Option<&str>) -> Result<wire::AutomationTrigger> {
    let preset = match preset {
        Some(p) => serde_json::from_value::<wire::AutomationPreset>(Value::String(p.into()))
            .map_err(|_| {
                anyhow!("unknown preset '{p}' — expected hourly, daily, weekdays, weekly or custom")
            })?,
        // A cron with no preset is a custom schedule, not a silent daily 09:00.
        None if cron.is_some() => wire::AutomationPreset::Custom,
        None => wire::AutomationPreset::Daily,
    };
    let cron = match preset {
        wire::AutomationPreset::Custom => cron
            .ok_or_else(|| anyhow!("preset 'custom' needs a 'cron' expression"))?
            .to_string(),
        other => crate::daemon::automations::preset_cron(other).to_string(),
    };
    Ok(wire::AutomationTrigger { preset, cron })
}

pub async fn handle_tool_call(
    name: &str,
    args: &Value,
    client: &mut DaemonClient,
) -> Result<Option<String>> {
    match name {
        "automation_create" => {
            let trigger = resolve_trigger(
                args.get("preset").and_then(Value::as_str),
                args.get("cron").and_then(Value::as_str),
            )?;
            let result = client
                .request(
                    "automation.create",
                    json!({
                        "project": args.get("project").and_then(Value::as_str).unwrap_or(""),
                        "name": args.get("name").and_then(Value::as_str).unwrap_or("Untitled"),
                        "prompt": args.get("prompt").and_then(Value::as_str).unwrap_or(""),
                        "agent": args.get("agent").and_then(Value::as_str).unwrap_or("claude"),
                        "model": args.get("model").and_then(Value::as_str),
                        "trigger": trigger,
                        "timezone": args.get("timezone").and_then(Value::as_str).unwrap_or(""),
                        "precheck": args.get("precheck").and_then(Value::as_str),
                        "missedRunGraceMinutes": args.get("missed_run_grace_minutes").and_then(Value::as_u64).unwrap_or(720) as u32,
                        "reuseSession": args.get("reuse_session").and_then(Value::as_bool).unwrap_or(false),
                        "worktree": args.get("worktree").and_then(Value::as_bool).unwrap_or(false),
                    }),
                )
                .await?;
            Ok(Some(format!(
                "Automation created: {}",
                json_text_summary(&result)
            )))
        }
        "automation_list" => {
            let result = client
                .request(
                    "automation.list",
                    json!({ "project": args.get("project").and_then(Value::as_str) }),
                )
                .await?;
            Ok(Some(json_text(&result)))
        }
        "automation_get" => {
            let id = require_id(args)?;
            let result = client
                .request("automation.show", json!({ "id": id }))
                .await?;
            Ok(Some(json_text(&result)))
        }
        "automation_update" => {
            let id = require_id(args)?;
            let mut patch = json!({});
            for (key, wire_key) in [
                ("name", "name"),
                ("prompt", "prompt"),
                ("agent", "agent"),
                ("model", "model"),
                ("timezone", "timezone"),
                ("precheck", "precheck"),
                ("enabled", "enabled"),
                ("missedRunGraceMinutes", "missedRunGraceMinutes"),
                ("reuseSession", "reuseSession"),
                ("worktree", "worktree"),
            ] {
                if let Some(value) = args.get(key) {
                    patch[wire_key] = value.clone();
                }
            }
            if args.get("preset").is_some() || args.get("cron").is_some() {
                patch["trigger"] = serde_json::to_value(resolve_trigger(
                    args.get("preset").and_then(Value::as_str),
                    args.get("cron").and_then(Value::as_str),
                )?)?;
            }
            let result = client
                .request("automation.update", json!({ "id": id, "patch": patch }))
                .await?;
            Ok(Some(json_text(&result)))
        }
        "automation_delete" => {
            let id = require_id(args)?;
            client
                .request("automation.delete", json!({ "id": id }))
                .await?;
            Ok(Some("Automation deleted.".into()))
        }
        "automation_run_now" => {
            let id = require_id(args)?;
            let result = client
                .request("automation.runNow", json!({ "id": id }))
                .await?;
            Ok(Some(format!(
                "Run dispatched: {}",
                json_text_summary(&result)
            )))
        }
        "automation_runs" => {
            let id = require_id(args)?;
            let result = client
                .request(
                    "automation.runs",
                    json!({ "id": id, "limit": args.get("limit").and_then(Value::as_u64).map(|l| l as u32) }),
                )
                .await?;
            Ok(Some(json_text(&result)))
        }
        _ => Ok(None),
    }
}

fn require_id(args: &Value) -> Result<String> {
    args.get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("'id' is required"))
}

fn json_text(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn json_text_summary(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}
