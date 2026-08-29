use std::path::PathBuf;

use warpforge_protocol::{AgentAccountLimits, AgentLimitWindow};

const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const TIMEOUT_SECS: u64 = 10;

fn auth_path() -> PathBuf {
    if let Ok(d) = std::env::var("OPENCODE_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d).join("auth.json");
        }
    }
    if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        if !x.trim().is_empty() {
            return PathBuf::from(x).join("opencode/auth.json");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local/share/opencode/auth.json")
}

fn read_key() -> Option<(String, String)> {
    let raw = std::fs::read_to_string(auth_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // key is under "opencode-go" entry
    let entry = v.get("opencode-go")?;
    let key = entry
        .get("key")
        .and_then(|k| k.as_str())
        .or_else(|| entry.get("api_key").and_then(|k| k.as_str()))
        .or_else(|| entry.as_str())?;
    if key.trim().is_empty() {
        return None;
    }
    Some((key.to_string(), raw))
}

pub fn has_live_login() -> bool {
    read_key().is_some()
}

pub fn live_label() -> String {
    "Signed in".to_string()
}

/// A stable name for the current opencode login. The auth file carries no
/// email, only the API key, so hash it: enough to tell "same login as last
/// launch" from "a different one" without writing the key to another file.
pub fn live_identity() -> Option<String> {
    use sha2::{Digest, Sha256};
    let (key, _) = read_key()?;
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Some(format!("opencode-key:{hex}"))
}

pub async fn fetch_for_account(
    account_id: &str,
    label: &str,
    fetched_at: i64,
) -> AgentAccountLimits {
    let Some((key, _)) = read_key() else {
        return AgentAccountLimits {
            account_id: account_id.to_string(),
            agent_id: "opencode".into(),
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
            return AgentAccountLimits {
                account_id: account_id.to_string(),
                agent_id: "opencode".into(),
                label: label.to_string(),
                active: true,
                plan: None,
                windows: vec![],
                exhausted: false,
                fetched_at,
                source: "api".into(),
                error: Some(e.to_string()),
            };
        }
    };
    let resp = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(body) => {
                let windows = parse_windows(&body);
                let exhausted = windows
                    .iter()
                    .any(|w: &AgentLimitWindow| w.used_percent >= 100.0);
                AgentAccountLimits {
                    account_id: account_id.to_string(),
                    agent_id: "opencode".into(),
                    label: label.to_string(),
                    active: true,
                    plan: body
                        .get("plan")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    windows,
                    exhausted,
                    fetched_at,
                    source: "api".into(),
                    error: None,
                }
            }
            Err(e) => AgentAccountLimits {
                account_id: account_id.to_string(),
                agent_id: "opencode".into(),
                label: label.to_string(),
                active: true,
                plan: None,
                windows: vec![],
                exhausted: false,
                fetched_at,
                source: "api".into(),
                error: Some(e.to_string()),
            },
        },
        Ok(r) if r.status().as_u16() == 429 => {
            let ra = r
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            super::poll::set_backoff(account_id, fetched_at + ra.unwrap_or(60) as i64);
            super::shared::throttled_account("opencode", account_id, label, true, fetched_at)
        }
        Ok(r) => AgentAccountLimits {
            account_id: account_id.to_string(),
            agent_id: "opencode".into(),
            label: label.to_string(),
            active: true,
            plan: None,
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some(format!("http {}", r.status())),
        },
        Err(e) => AgentAccountLimits {
            account_id: account_id.to_string(),
            agent_id: "opencode".into(),
            label: label.to_string(),
            active: true,
            plan: None,
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some(e.to_string()),
        },
    }
}

fn parse_windows(body: &serde_json::Value) -> Vec<AgentLimitWindow> {
    let usage = body.get("usage").unwrap_or(body);
    let mut out = Vec::new();
    for (id, label) in [
        ("rolling", "Session"),
        ("weekly", "Weekly"),
        ("monthly", "Monthly"),
    ] {
        let Some(o) = usage.get(id) else { continue };
        if o.get("status")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s != "ok")
        {
            continue;
        }
        let Some(percent) = o.get("percent").and_then(|v| v.as_f64()) else {
            continue;
        };
        let resets_at = o
            .get("resetsAt")
            .and_then(crate::daemon::limits::shared::parse_resets);
        out.push(AgentLimitWindow {
            id: id.to_string(),
            label: label.to_string(),
            used_percent: percent,
            resets_at,
            window_minutes: None,
        });
    }
    // legacy fallback: windows array
    if out.is_empty() {
        if let Some(arr) = body.get("windows").and_then(|v| v.as_array()) {
            return arr
                .iter()
                .filter_map(|o| {
                    let id = o.get("id").and_then(|v| v.as_str())?.to_string();
                    let label = o
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let used = o.get("used_percent").and_then(|v| v.as_f64())?;
                    Some(AgentLimitWindow {
                        id,
                        label,
                        used_percent: used,
                        resets_at: o.get("resets_at").and_then(|v| v.as_i64()),
                        window_minutes: o.get("window_minutes").and_then(|v| v.as_u64()),
                    })
                })
                .collect();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_real_fixture() {
        let body: serde_json::Value = serde_json::from_str(r#"{"usage":{"rolling":{"status":"ok","percent":2,"resetsAt":"2026-08-29T22:45:23.137Z"},"weekly":{"status":"ok","percent":47,"resetsAt":"2026-08-31T00:00:00.137Z"},"monthly":{"status":"ok","percent":44,"resetsAt":"2026-09-20T16:42:14.137Z"}}}"#).unwrap();
        let w = parse_windows(&body);
        assert_eq!(w.len(), 3);
        assert_eq!(
            w.iter().find(|x| x.id == "rolling").unwrap().used_percent,
            2.0
        );
        assert_eq!(
            w.iter().find(|x| x.id == "weekly").unwrap().used_percent,
            47.0
        );
        assert_eq!(
            w.iter().find(|x| x.id == "monthly").unwrap().used_percent,
            44.0
        );
        assert!(w.iter().all(|x| x.resets_at.is_some()));
        assert_eq!(w[0].window_minutes, None);
    }
}
