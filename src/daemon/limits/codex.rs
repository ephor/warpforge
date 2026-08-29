use std::path::{Path, PathBuf};

use warpforge_protocol::{AgentAccountLimits, AgentLimitWindow};

const TIMEOUT_SECS: u64 = 10;
const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

fn codex_home() -> PathBuf {
    if let Ok(h) = std::env::var("CODEX_HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

fn auth_paths() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Ok(h) = std::env::var("CODEX_HOME") {
        if !h.trim().is_empty() {
            v.push(PathBuf::from(h).join("auth.json"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".codex/auth.json"));
        v.push(home.join(".config/codex/auth.json"));
    }
    v
}

fn read_access_token() -> Option<(String, String)> {
    for p in auth_paths() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(tok) = val
                    .get("tokens")
                    .and_then(|t| t.get("access_token"))
                    .and_then(|s| s.as_str())
                {
                    return Some((tok.to_string(), raw));
                }
                if let Some(tok) = val.get("OPENAI_API_KEY").and_then(|s| s.as_str()) {
                    if !tok.is_empty() {
                        return Some((tok.to_string(), raw));
                    }
                }
            }
        }
    }
    None
}

pub fn has_live_login() -> bool {
    read_access_token().is_some()
}

pub fn live_label() -> String {
    live_identity().unwrap_or_else(|| "Signed in".to_string())
}

/// Email of the login currently in Codex's own home, or `None` when nothing
/// names it. Used to decide whether a cached quota still belongs to it.
pub fn live_identity() -> Option<String> {
    for p in auth_paths() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            let id = crate::daemon::accounts::codex_identity(&raw);
            if id.email.is_some() {
                return id.email;
            }
        }
    }
    None
}

fn parse_retry_after(hv: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    hv?.to_str().ok()?.trim().parse().ok()
}

fn windows_from_obj(
    primary: Option<&serde_json::Value>,
    secondary: Option<&serde_json::Value>,
) -> Vec<AgentLimitWindow> {
    let mut out = vec![];
    for (id, obj) in [("primary", primary), ("secondary", secondary)] {
        let Some(o) = obj else { continue };
        if o.is_null() {
            continue;
        }
        let used = o
            .get("used_percent")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let wm = o.get("window_minutes").and_then(|v| v.as_u64());
        let resets_at = o
            .get("resets_at")
            .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)));
        let label = if wm.unwrap_or(10080) <= 300 {
            "Session"
        } else {
            "Weekly"
        };
        out.push(AgentLimitWindow {
            id: id.to_string(),
            label: label.to_string(),
            used_percent: used,
            resets_at,
            window_minutes: wm,
        });
    }
    out
}

pub fn map_rate_limits(
    line: &str,
    fetched_at: i64,
    account_id: &str,
    label: &str,
    active: bool,
) -> Option<AgentAccountLimits> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let rl = v.get("rate_limits")?;
    let plan = rl
        .get("plan_type")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let windows = windows_from_obj(rl.get("primary"), rl.get("secondary"));
    let exhausted = windows.iter().any(|w| w.used_percent >= 100.0);
    Some(AgentAccountLimits {
        account_id: account_id.to_string(),
        agent_id: "codex".into(),
        label: label.to_string(),
        active,
        plan,
        windows,
        exhausted,
        fetched_at,
        source: "local".into(),
        error: None,
    })
}

fn map_wham(
    body: &serde_json::Value,
    fetched_at: i64,
    account_id: &str,
    label: &str,
) -> AgentAccountLimits {
    let rl = body.get("rate_limit");
    let primary = rl.and_then(|r| r.get("primary_window"));
    let secondary = rl.and_then(|r| r.get("secondary_window"));
    let mut windows = Vec::new();
    for (id, obj) in [("primary", primary), ("secondary", secondary)] {
        let Some(o) = obj else { continue };
        if o.is_null() {
            continue;
        }
        // status not used for codex; windows always present
        let used = o
            .get("used_percent")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let secs = o.get("limit_window_seconds").and_then(|v| v.as_u64());
        let wm = secs.map(|s| s / 60);
        let resets_at = o
            .get("reset_at")
            .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)));
        let label_str = if wm.unwrap_or(10080) <= 300 {
            "Session"
        } else {
            "Weekly"
        };
        windows.push(AgentLimitWindow {
            id: id.to_string(),
            label: label_str.to_string(),
            used_percent: used,
            resets_at,
            window_minutes: wm,
        });
    }
    let plan = body
        .get("plan_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let email_label = body
        .get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let final_label = if account_id.ends_with(":live") {
        email_label.as_deref().unwrap_or(label).to_string()
    } else {
        label.to_string()
    };
    let final_plan = plan.clone().or_else(|| {
        body.get("plan_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });
    // explicit exhaustion signals
    let limit_reached = rl
        .and_then(|r| r.get("limit_reached"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let reached_type = body
        .get("rate_limit_reached_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .is_some();
    let exhausted =
        windows.iter().any(|w| w.used_percent >= 100.0) || limit_reached || reached_type;
    AgentAccountLimits {
        account_id: account_id.to_string(),
        agent_id: "codex".into(),
        label: final_label,
        active: true,
        plan: final_plan,
        windows,
        exhausted,
        fetched_at,
        source: "api".into(),
        error: None,
    }
}

pub fn find_latest_rollout(home: &Path) -> Option<PathBuf> {
    let pattern = home.join("sessions");
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for e in walkdir::WalkDir::new(&pattern)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if e.file_name().to_string_lossy().starts_with("rollout-")
            && e.file_name().to_string_lossy().ends_with(".jsonl")
        {
            if let Some(m) = e.metadata().ok().and_then(|m| m.modified().ok()) {
                if latest.as_ref().is_none_or(|(t, _)| m > *t) {
                    latest = Some((m, e.path().to_path_buf()));
                }
            }
        }
    }
    latest.map(|(_, p)| p)
}

pub fn tail_find_rate_limits(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: usize = 64 * 1024;
    const CAP: usize = 4 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    let mut scanned = 0usize;
    let mut buf = Vec::new();
    let mut pos = len;
    while pos > 0 && scanned < CAP {
        let take = (CHUNK as u64).min(pos) as usize;
        pos -= take as u64;
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut chunk = vec![0u8; take];
        file.read_exact(&mut chunk).ok()?;
        let mut new_buf = chunk;
        new_buf.extend_from_slice(&buf);
        buf = new_buf;
        scanned += take;
        if buf.contains(&b'\n') {
            let text = String::from_utf8_lossy(&buf);
            for line in text.lines().rev() {
                if line.contains("rate_limits") {
                    return Some(line.to_string());
                }
            }
            if scanned >= CAP {
                break;
            }
        }
    }
    if !buf.is_empty() {
        let text = String::from_utf8_lossy(&buf);
        for line in text.lines().rev() {
            if line.contains("rate_limits") {
                return Some(line.to_string());
            }
        }
    }
    None
}

pub async fn fetch_for_account(
    account_id: &str,
    label: &str,
    fetched_at: i64,
) -> AgentAccountLimits {
    let Some((token, _raw)) = read_access_token() else {
        return AgentAccountLimits {
            account_id: account_id.to_string(),
            agent_id: "codex".into(),
            label: label.to_string(),
            active: true,
            plan: None,
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some("not logged in".into()),
        };
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return fallback(account_id, label, fetched_at, Some(e.to_string()));
        }
    };
    let resp = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().as_u16() == 429 => {
            let ra = parse_retry_after(r.headers().get("retry-after"));
            super::poll::set_backoff(account_id, fetched_at + ra.unwrap_or(60) as i64);
            super::shared::throttled_account("codex", account_id, label, true, fetched_at)
        }
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(body) => {
                let mapped = map_wham(&body, fetched_at, account_id, label);
                if mapped.windows.is_empty() {
                    // no window-shaped quota -> honest empty api
                    mapped
                } else {
                    mapped
                }
            }
            Err(_) => fallback(account_id, label, fetched_at, None),
        },
        Ok(r) if r.status().as_u16() == 401 => AgentAccountLimits {
            account_id: account_id.to_string(),
            agent_id: "codex".into(),
            label: label.to_string(),
            active: true,
            plan: None,
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some("not logged in".into()),
        },
        _ => fallback(account_id, label, fetched_at, None),
    }
}

fn fallback(
    account_id: &str,
    label: &str,
    fetched_at: i64,
    err: Option<String>,
) -> AgentAccountLimits {
    let home = codex_home();
    if let Some(p) = find_latest_rollout(&home) {
        if let Some(line) = tail_find_rate_limits(&p) {
            if let Some(mapped) = map_rate_limits(&line, fetched_at, account_id, label, true) {
                return mapped;
            }
        }
    }
    AgentAccountLimits {
        account_id: account_id.to_string(),
        agent_id: "codex".into(),
        label: label.to_string(),
        active: true,
        plan: None,
        windows: vec![],
        exhausted: false,
        fetched_at,
        source: "local".into(),
        error: err.or(Some("no rollout file".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_sample() {
        let line = r#"{"rate_limits":{"limit_id":"codex","primary":{"used_percent":81.0,"window_minutes":10080,"resets_at":1787212542},"secondary":null,"plan_type":"plus"}}"#;
        let a = map_rate_limits(line, 0, "codex:personal", "personal", true).unwrap();
        assert_eq!(a.windows.len(), 1);
        assert_eq!(a.windows[0].id, "primary");
        assert!(!a.exhausted);
    }
    #[test]
    fn exhausted_case() {
        let line = r#"{"rate_limits":{"primary":{"used_percent":100,"window_minutes":300,"resets_at":0},"secondary":null,"plan_type":"plus"}}"#;
        let a = map_rate_limits(line, 0, "codex:personal", "personal", true).unwrap();
        assert!(a.exhausted);
        assert_eq!(a.windows[0].label, "Session");
    }
    #[test]
    fn tail_finds_last_not_final() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let content = r#"{"msg":"a"}
{"rate_limits":{"primary":{"used_percent":10,"window_minutes":300,"resets_at":1},"secondary":null}}
{"msg":"between"}
{"rate_limits":{"primary":{"used_percent":99,"window_minutes":10080,"resets_at":2},"secondary":null}}
{"msg":"tail after"}
"#;
        std::fs::write(&path, content).unwrap();
        assert!(tail_find_rate_limits(&path).unwrap().contains("99"));
    }
    #[test]
    fn wham_maps_real_fixture() {
        let body: serde_json::Value = serde_json::from_str(r#"{"user_id":"user-…","account_id":"","email":"…@gmail.com","plan_type":"plus","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":0,"limit_window_seconds":18000,"reset_after_seconds":18000,"reset_at":1788045481},"secondary_window":{"used_percent":42,"limit_window_seconds":604800,"reset_after_seconds":425180,"reset_at":1788452661}},"code_review_rate_limit":null,"additional_rate_limits":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"spend_control":{"reached":false,"individual_limit":null},"rate_limit_reached_type":null}"#).unwrap();
        let a = map_wham(&body, 0, "codex:live", "live");
        assert_eq!(a.windows.len(), 2);
        let p = a.windows.iter().find(|w| w.id == "primary").unwrap();
        assert_eq!(p.used_percent, 0.0);
        assert_eq!(p.window_minutes, Some(300));
        assert_eq!(p.resets_at, Some(1788045481));
        let s = a.windows.iter().find(|w| w.id == "secondary").unwrap();
        assert_eq!(s.used_percent, 42.0);
        assert_eq!(s.window_minutes, Some(10080));
        assert_eq!(s.resets_at, Some(1788452661));
        assert!(!a.exhausted);
    }
    #[test]
    fn wham_limit_reached_exhausted() {
        let body: serde_json::Value = serde_json::from_str(r#"{"plan_type":"plus","rate_limit":{"limit_reached":true,"primary_window":{"used_percent":50,"limit_window_seconds":18000,"reset_at":1},"secondary_window":{"used_percent":50,"limit_window_seconds":604800,"reset_at":2}},"rate_limit_reached_type":"primary"}"#).unwrap();
        let a = map_wham(&body, 0, "codex:live", "live");
        assert!(a.exhausted);
    }
}
