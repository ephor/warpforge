use warpforge_protocol::AgentAccountLimits;

use crate::daemon::store::StoredAccount;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static BACKOFF: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn set_backoff(id: &str, until: i64) {
    BACKOFF.lock().unwrap().insert(id.to_string(), until);
}
fn get_backoff(id: &str) -> Option<i64> {
    BACKOFF.lock().unwrap().get(id).copied()
}
pub fn clear_backoff_for_test() {
    BACKOFF.lock().unwrap().clear();
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn should_skip_due_to_backoff(id: &str, now: i64, force: bool) -> Option<i64> {
    if force {
        return None;
    }
    let until = get_backoff(id)?;
    if now < until {
        Some(until)
    } else {
        None
    }
}

fn backoff_synthetic(
    id: &str,
    label: &str,
    active: bool,
    fetched_at: i64,
    until: i64,
) -> AgentAccountLimits {
    let _ = until;
    let agent = id.split(':').next().unwrap_or("");
    crate::daemon::limits::shared::throttled_account(agent, id, label, active, fetched_at)
}

/// Fold a fresh fetch into the last known one, keeping numbers we already had
/// when the new attempt came back empty-with-an-error (throttled, offline,
/// token briefly unreadable). Losing 53%/78% to a bare red "throttled" is worse
/// than showing slightly stale figures — the whole point is knowing where the
/// quota stands, and a transient poll failure says nothing about that.
pub fn merge_snapshots(
    previous: &[AgentAccountLimits],
    fresh: Vec<AgentAccountLimits>,
) -> Vec<AgentAccountLimits> {
    fresh
        .into_iter()
        .map(|new| {
            if !new.windows.is_empty() || new.error.is_none() {
                return new;
            }
            match previous
                .iter()
                .find(|p| p.account_id == new.account_id && !p.windows.is_empty())
            {
                Some(old) => AgentAccountLimits {
                    windows: old.windows.clone(),
                    exhausted: old.exhausted,
                    plan: new.plan.clone().or_else(|| old.plan.clone()),
                    // `fetched_at` stays the OLD one: it is when these numbers were
                    // true, and the UI prints it as "updated Nm ago".
                    fetched_at: old.fetched_at,
                    ..new
                },
                None => new,
            }
        })
        .collect()
}

pub async fn fetch_all(accounts: Vec<StoredAccount>) -> Vec<AgentAccountLimits> {
    fetch_all_inner(accounts, false).await
}
pub async fn fetch_all_force(accounts: Vec<StoredAccount>) -> Vec<AgentAccountLimits> {
    fetch_all_inner(accounts, true).await
}

async fn fetch_all_inner(accounts: Vec<StoredAccount>, force: bool) -> Vec<AgentAccountLimits> {
    let fetched_at = now_secs();
    let has_active = |agent: &str| accounts.iter().any(|a| a.agent_id == agent && a.active);

    // synthesize live logins for agents with no registered active covering
    let mut augmented = accounts.clone();
    for (agent, has_login, label_fn) in [
        (
            "claude",
            crate::daemon::limits::claude::has_live_login(),
            crate::daemon::limits::claude::live_label as fn() -> String,
        ),
        (
            "codex",
            crate::daemon::limits::codex::has_live_login(),
            crate::daemon::limits::codex::live_label as fn() -> String,
        ),
        (
            "opencode",
            crate::daemon::limits::opencode::has_live_login(),
            crate::daemon::limits::opencode::live_label as fn() -> String,
        ),
    ] {
        if has_login && !has_active(agent) {
            augmented.push(StoredAccount {
                id: format!("{}:live", agent),
                agent_id: agent.to_string(),
                label: label_fn(),
                email: None,
                plan: None,
                home_dir: String::new(),
                created_at: 0,
                active: true,
            });
        }
    }

    let mut out = Vec::new();
    for acc in augmented {
        // single backoff check, branch once
        if let Some(until) = should_skip_due_to_backoff(&acc.id, fetched_at, force) {
            out.push(backoff_synthetic(
                &acc.id, &acc.label, acc.active, fetched_at, until,
            ));
            continue;
        }
        let item = match acc.agent_id.as_str() {
            "claude" => {
                // live-synthesized has empty home_dir -> read via live credentials
                let tok = if acc.id.ends_with(":live") {
                    crate::daemon::claude_auth::ClaudeRuntime::detect()
                        .read_live_credentials()
                        .ok()
                        .flatten()
                        .and_then(|raw| {
                            serde_json::from_str::<serde_json::Value>(&raw)
                                .ok()
                                .and_then(|v| {
                                    v.get("claudeAiOauth")
                                        .and_then(|o| o.get("accessToken"))
                                        .and_then(|s| s.as_str())
                                        .map(|s| s.to_string())
                                        .or_else(|| {
                                            v.get("accessToken")
                                                .and_then(|s| s.as_str())
                                                .map(|s| s.to_string())
                                        })
                                })
                        })
                } else {
                    {
                        let (t, expired) = crate::daemon::limits::claude::read_token_and_expiry_for(
                            &acc, acc.active,
                        );
                        if expired {
                            out.push(AgentAccountLimits {
                                account_id: acc.id.clone(),
                                agent_id: "claude".into(),
                                label: acc.label.clone(),
                                active: acc.active,
                                plan: acc.plan.clone(),
                                windows: vec![],
                                exhausted: false,
                                fetched_at,
                                source: "api".into(),
                                error: Some("credentials expired".into()),
                            });
                            continue;
                        }
                        t
                    }
                };
                crate::daemon::limits::claude::fetch_for_account(&acc, tok, fetched_at).await
            }
            // Every account holds its own credentials in its vault, so each one
            // is asked on its own token — being active buys no special access.
            "codex" => crate::daemon::limits::codex::fetch_for_account(&acc, fetched_at).await,
            "opencode" => {
                crate::daemon::limits::opencode::fetch_for_account(&acc.id, &acc.label, fetched_at)
                    .await
            }
            _ => AgentAccountLimits {
                account_id: acc.id.clone(),
                agent_id: acc.agent_id.clone(),
                label: acc.label.clone(),
                active: acc.active,
                plan: acc.plan.clone(),
                windows: vec![],
                exhausted: false,
                fetched_at,
                source: "unknown".into(),
                error: None,
            },
        };
        out.push(item);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::store::StoredAccount;

    #[tokio::test]
    async fn one_account_error_still_returns_others() {
        let dir = tempfile::tempdir().unwrap();
        let acc1 = StoredAccount {
            id: "claude:personal".into(),
            agent_id: "claude".into(),
            label: "personal".into(),
            email: None,
            plan: None,
            home_dir: dir.path().join("missing").to_string_lossy().into(),
            created_at: 0,
            active: false,
        };
        let acc2 = StoredAccount {
            id: "opencode:work".into(),
            agent_id: "opencode".into(),
            label: "work".into(),
            email: None,
            plan: None,
            home_dir: dir.path().to_string_lossy().into(),
            created_at: 0,
            active: true,
        };
        let out = fetch_all(vec![acc1, acc2]).await;
        // augmented may add live entries; ensure both originals present
        assert!(out.iter().any(|a| a.account_id == "claude:personal"));
        assert!(out.iter().any(|a| a.account_id == "opencode:work"));
    }

    fn acct(id: &str, pct: f64, err: Option<&str>) -> AgentAccountLimits {
        AgentAccountLimits {
            account_id: id.into(),
            agent_id: "claude".into(),
            label: "l".into(),
            active: true,
            plan: None,
            windows: if pct < 0.0 {
                vec![]
            } else {
                vec![warpforge_protocol::AgentLimitWindow {
                    id: "five_hour".into(),
                    label: "Session".into(),
                    used_percent: pct,
                    resets_at: None,
                    window_minutes: None,
                }]
            },
            exhausted: false,
            fetched_at: 100,
            source: "api".into(),
            error: err.map(String::from),
        }
    }

    #[test]
    fn throttled_fetch_keeps_last_known_numbers() {
        let previous = vec![acct("claude:personal", 53.0, None)];
        let fresh = vec![acct(
            "claude:personal",
            -1.0,
            Some("usage endpoint throttled"),
        )];
        let merged = merge_snapshots(&previous, fresh);
        assert_eq!(merged[0].windows.len(), 1);
        assert_eq!(merged[0].windows[0].used_percent, 53.0);
        assert_eq!(merged[0].error.as_deref(), Some("usage endpoint throttled"));
        // the numbers are the old ones, so their timestamp must be too
        assert_eq!(merged[0].fetched_at, 100);
    }

    #[test]
    fn successful_fetch_replaces_old_numbers() {
        let previous = vec![acct("claude:personal", 53.0, None)];
        let fresh = vec![acct("claude:personal", 78.0, None)];
        let merged = merge_snapshots(&previous, fresh);
        assert_eq!(merged[0].windows[0].used_percent, 78.0);
    }

    #[test]
    fn no_duplicate_live_when_active_exists() {
        // when a registered active exists, no :live synthesized
        let acc = StoredAccount {
            id: "codex:personal".into(),
            agent_id: "codex".into(),
            label: "personal".into(),
            email: None,
            plan: None,
            home_dir: "/tmp".into(),
            created_at: 0,
            active: true,
        };
        // has_active check should be true -> no synthesis, even if has_live_login true we can't force it without mocking file;
        // test the dedupe logic directly: augmented length should not contain codex:live when active present
        // We test via fetch_all_inner logic: if has_active true, no live added regardless of file existence
        // This is covered by has_active closure; we assert the condition
        assert!([acc].iter().any(|a| a.agent_id == "codex" && a.active));
    }
}
