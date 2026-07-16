//! Discover existing agent sessions on disk so a user can resume a prior
//! conversation (claude or codex) as a warpforge task.
//!
//! Both agents keep their own session stores keyed (indirectly) by the working
//! directory:
//!   - Claude: `~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`, one file
//!     per session; the file stem is the ACP session id.
//!   - Codex:  `~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`, whose first
//!     line is a `session_meta` frame carrying `payload.cwd` and `payload.id`.
//!     Titles live in `~/.codex/session_index.jsonl` (id → thread_name).
//!
//! Everything here is blocking file IO — call it from `spawn_blocking`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use warpforge_protocol as wire;

/// List resumable sessions for a project's working directory, newest first.
/// Only scans stores for agents that are configured and enabled (so a resume
/// can actually resolve to an ACP command).
pub fn external_sessions(
    project_path: &str,
    agents: &[wire::AgentConfig],
) -> Vec<wire::ExternalSession> {
    let enabled: Vec<&str> = agents
        .iter()
        .filter(|a| a.enabled)
        .map(|a| a.id.as_str())
        .collect();

    let mut out = Vec::new();
    if enabled.contains(&"claude") {
        out.extend(claude_sessions(project_path));
    }
    if enabled.contains(&"codex") {
        out.extend(codex_sessions(project_path));
    }
    out.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    out
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

// ── Claude ────────────────────────────────────────────────────────────────

/// Claude escapes the absolute cwd into a directory name by replacing `/` and
/// `.` with `-` (so `/Users/x/proj` → `-Users-x-proj`).
fn claude_dir_name(project_path: &str) -> String {
    project_path
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn claude_sessions(project_path: &str) -> Vec<wire::ExternalSession> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let dir = home
        .join(".claude")
        .join("projects")
        .join(claude_dir_name(project_path));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let (title, count) = claude_summary(&path);
        out.push(wire::ExternalSession {
            agent: "claude".into(),
            session_id: session_id.to_string(),
            title,
            updated_at: mtime_secs(&path),
            message_count: count,
        });
    }
    out
}

/// Read a claude session file for a title (a `summary`, else the first user
/// message) and a rough message count.
fn claude_summary(path: &Path) -> (String, u32) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (String::new(), 0);
    };
    let mut summary: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut count: u32 = 0;

    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("summary") => {
                if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
                    summary = Some(s.to_string());
                }
            }
            Some("user") => {
                count += 1;
                if first_user.is_none() {
                    if let Some(t) = message_text(v.get("message")) {
                        first_user = Some(t);
                    }
                }
            }
            Some("assistant") => count += 1,
            _ => {}
        }
    }
    let title = summary
        .or(first_user)
        .map(|t| truncate(&t, 100))
        .unwrap_or_default();
    (title, count)
}

/// Pull display text out of a claude `message` object whose `content` is either
/// a string or an array of `{type:"text", text}` blocks.
fn message_text(message: Option<&Value>) -> Option<String> {
    let content = message?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        let joined: String = arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    None
}

// ── Codex ─────────────────────────────────────────────────────────────────

fn codex_sessions(project_path: &str) -> Vec<wire::ExternalSession> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.is_dir() {
        return Vec::new();
    }

    let titles = codex_titles(&home);
    let mut files = Vec::new();
    collect_jsonl(&sessions_dir, &mut files);

    let mut out = Vec::new();
    for path in files {
        let Some((id, cwd)) = codex_meta(&path) else {
            continue;
        };
        if cwd != project_path {
            continue;
        }
        let title = titles.get(&id).cloned().unwrap_or_default();
        out.push(wire::ExternalSession {
            agent: "codex".into(),
            session_id: id,
            title: truncate(&title, 100),
            updated_at: mtime_secs(&path),
            message_count: 0,
        });
    }
    out
}

/// Parse `~/.codex/session_index.jsonl` into id → thread_name.
fn codex_titles(home: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let index = home.join(".codex").join("session_index.jsonl");
    let Ok(text) = std::fs::read_to_string(index) else {
        return map;
    };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (
            v.get("id").and_then(|s| s.as_str()),
            v.get("thread_name").and_then(|s| s.as_str()),
        ) {
            map.insert(id.to_string(), name.to_string());
        }
    }
    map
}

/// Read a codex session file's first `session_meta` frame → (id, cwd).
fn codex_meta(path: &Path) -> Option<(String, String)> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut first = String::new();
    std::io::BufReader::new(file).read_line(&mut first).ok()?;
    let v: Value = serde_json::from_str(first.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    let id = payload.get("id").and_then(|s| s.as_str())?.to_string();
    let cwd = payload.get("cwd").and_then(|s| s.as_str())?.to_string();
    Some((id, cwd))
}

/// Recursively collect `*.jsonl` paths under `dir`.
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}
