//! Side-channel ACP probe: spawn an agent process, run `initialize` →
//! `session/new`, read the `configOptions` (model/mode selectors) the agent
//! advertises up front, then immediately `session/cancel` and kill the child.
//!
//! The result is cached per-agent in SQLite so the New Task view can show a
//! model picker before any prompt is sent, without paying the probe cost on
//! every task creation. The probe never sends a prompt, so it costs nothing on
//! the agent side (no usage, no token spend) — only the cold-start of spawning
//! the CLI once per agent on enable / daemon startup.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
// `AsyncReadExt` is not used — tokio BufReader gives us a lines() method via
// `AsyncBufReadExt`, which we already import above. Keeping this file lean.
use tokio::process::Command;
use warpforge_protocol as wire;

use super::acp::parse_config_options;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Spawn the agent's ACP command, do the initialize + session/new handshake
/// (no prompt), read `result.configOptions`, then cancel and kill.
///
/// `cwd` should be a real path the agent can chdir into; for a probe there's
/// no project context, so callers pass a tempdir or the daemon's cwd.
pub async fn probe_models(acp_command: &str, cwd: &Path) -> Result<Vec<wire::ConfigOption>> {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", acp_command])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawning agent probe `{acp_command}`"))?;
    let pgid = child.id();
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let _stderr = child.stderr.take();
    let mut reader = BufReader::new(stdout).lines();

    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        let init_req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } }
            }
        });
        write_line(&mut stdin, &init_req).await?;
        let init_resp = read_response(&mut reader, 1).await?;
        if init_resp.get("error").is_some() {
            return Err(anyhow!("agent rejected initialize"));
        }

        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {
                "cwd": cwd.to_string_lossy(),
                "mcpServers": []
            }
        });
        write_line(&mut stdin, &new_req).await?;
        let new_resp = read_response(&mut reader, 2).await?;
        if new_resp.get("error").is_some() {
            return Err(anyhow!("agent rejected session/new"));
        }

        let opts = new_resp
            .get("result")
            .and_then(|r| r.get("configOptions"))
            .map(|v| parse_config_options(Some(v)))
            .unwrap_or_default();

        // Best-effort cancel; ignore failure — we kill the process below.
        let cancel = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {}
        });
        let _ = write_line(&mut stdin, &cancel).await;
        Ok(opts)
    })
    .await;

    // Always kill the child regardless of outcome.
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pgid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;

    result.map_err(|_| anyhow!("ACP probe timed out after {}s", PROBE_TIMEOUT.as_secs()))?
}

/// Write one ndjson frame plus a trailing newline.
async fn write_line(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Result<()> {
    let s = serde_json::to_string(value)?;
    stdin.write_all(s.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

/// Read frames until we find the JSON-RPC response with the expected id.
/// Intermediate notifications (method present, no id) are ignored.
async fn read_response(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: u64,
) -> Result<Value> {
    loop {
        match reader.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // Skip notifications (no id, has method).
                if value.get("method").is_some() && value.get("id").is_none() {
                    continue;
                }
                if value
                    .get("id")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id == expected_id)
                {
                    return Ok(value);
                }
            }
            Ok(None) => {
                return Err(anyhow!(
                    "agent closed stdout before replying to id {expected_id}"
                ))
            }
            Err(e) => return Err(anyhow!("reading agent probe stdout: {e}")),
        }
    }
}
