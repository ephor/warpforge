use std::path::Path;

use warpforge_protocol::{AgentAccountLimits, AgentLimitWindow};

use crate::daemon::accounts::AccountIdentity;
use crate::daemon::claude_auth;
use crate::daemon::store::StoredAccount;

const USAGE_PATH: &str = "/api/oauth/usage";
const BETA: &str = "oauth-2025-04-20";
const TIMEOUT_SECS: u64 = 10;

fn parse_resets(v: &serde_json::Value) -> Option<i64> {
    crate::daemon::limits::shared::parse_resets(v)
}

pub fn map_usage(
    body: &serde_json::Value,
    fetched_at: i64,
    account_id: &str,
    label: &str,
    active: bool,
) -> AgentAccountLimits {
    let mut windows = Vec::new();
    let defs: &[(&str, &str, Option<u64>)] = &[
        ("five_hour", "Session", Some(300)),
        ("seven_day", "Weekly", Some(10080)),
        ("seven_day_opus", "Weekly (Opus)", Some(10080)),
        ("seven_day_sonnet", "Weekly (Sonnet)", Some(10080)),
    ];
    for (id, lbl, mins) in defs {
        if let Some(obj) = body.get(*id) {
            if obj.is_null() {
                continue;
            }
            let Some(u) = obj.get("utilization").and_then(|v| v.as_f64()) else {
                continue;
            };
            let resets_at = obj.get("resets_at").and_then(parse_resets);
            windows.push(AgentLimitWindow {
                id: id.to_string(),
                label: lbl.to_string(),
                used_percent: u,
                resets_at,
                window_minutes: *mins,
            });
        }
    }
    let exhausted = windows.iter().any(|w| w.used_percent >= 100.0);
    let plan = body
        .get("plan")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());
    AgentAccountLimits {
        account_id: account_id.to_string(),
        agent_id: "claude".into(),
        label: label.to_string(),
        active,
        plan,
        windows,
        exhausted,
        fetched_at,
        source: "api".into(),
        error: None,
    }
}

fn extract_access_token(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|s| s.as_str())
        .or_else(|| v.get("accessToken").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
}

fn token_expired(raw: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(exp) = v
        .get("claudeAiOauth")
        .and_then(|o| o.get("expiresAt"))
        .and_then(|s| s.as_i64())
    else {
        return false;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    exp <= now_ms
}

pub fn is_token_expired_for_test(raw: &str) -> bool {
    token_expired(raw)
}

/// Which credential to ask about this account's quota.
///
/// The live login is the freshest copy, but it belongs to whoever last signed
/// in — not necessarily the account warpforge has flagged active. Using it
/// unchecked once reported Work's quota under Personal's name, which is worse
/// than reporting nothing: the feature exists to pick a login with room left.
///
/// So the live token is used ONLY on a positive identity match. Anything else —
/// mismatch, or an identity we cannot read on either side — falls back to this
/// account's own vault, and to nothing at all if the vault has none. Reporting
/// "not logged in" is honest; reporting someone else's numbers is not.
pub fn choose_token(
    live_identity: Option<AccountIdentity>,
    account_identity: Option<AccountIdentity>,
    live_token: Option<String>,
    vault_token: Option<String>,
) -> Option<String> {
    let confirmed_same = match (
        live_identity.as_ref().and_then(|i| i.email.as_deref()),
        account_identity.as_ref().and_then(|i| i.email.as_deref()),
    ) {
        (Some(live), Some(acct)) if !live.trim().is_empty() && !acct.trim().is_empty() => {
            live.trim().eq_ignore_ascii_case(acct.trim())
        }
        _ => false,
    };
    if confirmed_same {
        live_token.or(vault_token)
    } else {
        vault_token
    }
}

pub fn account_identity(account: &StoredAccount) -> Option<AccountIdentity> {
    // Prefer stored email; fall back to vault oauth-account file
    if let Some(email) = account.email.clone() {
        if !email.trim().is_empty() {
            return Some(AccountIdentity {
                email: Some(email),
                plan: account.plan.clone(),
            });
        }
    }
    let vault = Path::new(&account.home_dir);
    let raw = std::fs::read_to_string(vault.join(claude_auth::OAUTH_ACCOUNT_FILE)).ok()?;
    let id = crate::daemon::accounts::claude_identity(&raw);
    if id.email.is_none() {
        None
    } else {
        Some(id)
    }
}

pub fn read_token_for(account: &StoredAccount, active: bool) -> Option<String> {
    let vault_raw =
        std::fs::read_to_string(Path::new(&account.home_dir).join(claude_auth::CREDENTIALS_FILE))
            .ok();
    let vault_token = vault_raw.as_deref().and_then(extract_access_token);

    if active {
        if let Ok(Some(live_raw)) = claude_auth::ClaudeRuntime::detect().read_live_credentials() {
            let live_token = extract_access_token(&live_raw);
            if live_token.is_some() {
                let live_id = claude_auth::ClaudeRuntime::detect()
                    .read_live_oauth_account()
                    .map(|v| crate::daemon::accounts::claude_identity(&v.to_string()));
                let acct_id = account_identity(account);
                // If we cannot confirm identity, prefer vault
                let chosen =
                    choose_token(live_id, acct_id, live_token.clone(), vault_token.clone());
                // choose_token already prefers vault when uncertain; but if identities match it returns live
                // For mismatch case, it returns vault. Use that.
                // If both None case, it returned vault.or(live); fallback to vault.
                if chosen.is_some() {
                    // Need to ensure mismatch doesn't return live token; choose_token handles.
                    // However if vault_token is None and identities mismatch, chosen is None - return None (not live)
                    return chosen;
                }
                // If choose_token returned None but we have a matching live, return live
                // (already handled). Otherwise None.
                return None;
            }
        }
    }
    vault_token
}

pub fn read_token_and_expiry_for(account: &StoredAccount, active: bool) -> (Option<String>, bool) {
    // Re-read raw for expiry check on chosen token's source
    let vault_raw =
        std::fs::read_to_string(Path::new(&account.home_dir).join(claude_auth::CREDENTIALS_FILE))
            .ok();
    let tok = read_token_for(account, active);
    if tok.is_none() {
        return (None, false);
    }
    // Determine which raw was used
    let live_raw = if active {
        claude_auth::ClaudeRuntime::detect()
            .read_live_credentials()
            .ok()
            .flatten()
    } else {
        None
    };
    let live_tok = live_raw.as_deref().and_then(extract_access_token);
    let use_live = live_tok.as_ref() == tok.as_ref() && live_raw.is_some();
    let raw_for_expiry = if use_live { live_raw } else { vault_raw };
    if let Some(raw) = raw_for_expiry {
        if token_expired(&raw) {
            return (None, true);
        }
    }
    (tok, false)
}

pub fn has_live_login() -> bool {
    claude_auth::ClaudeRuntime::detect()
        .read_live_credentials()
        .ok()
        .flatten()
        .is_some()
}

pub fn live_label() -> String {
    if let Ok(rt) = std::panic::catch_unwind(claude_auth::ClaudeRuntime::detect) {
        let _ = rt;
    }
    let rt = claude_auth::ClaudeRuntime::detect();
    if let Some(v) = rt.read_live_oauth_account() {
        let id = crate::daemon::accounts::claude_identity(&v.to_string());
        if let Some(email) = id.email {
            return email;
        }
    }
    "Signed in".to_string()
}

fn parse_retry_after(hv: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    hv?.to_str().ok()?.trim().parse().ok()
}

pub async fn fetch_for_account(
    account: &StoredAccount,
    token: Option<String>,
    fetched_at: i64,
) -> AgentAccountLimits {
    let Some(tok) = token.filter(|t| !t.trim().is_empty()) else {
        return AgentAccountLimits {
            account_id: account.id.clone(),
            agent_id: "claude".into(),
            label: account.label.clone(),
            active: account.active,
            plan: account.plan.clone(),
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some("not logged in".into()),
        };
    };
    // TODO: refresh via https://platform.claude.com/v1/oauth/token
    let base = std::env::var("CLAUDE_CODE_CUSTOM_OAUTH_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}{}", base.trim_end_matches('/'), USAGE_PATH);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return AgentAccountLimits {
                account_id: account.id.clone(),
                agent_id: "claude".into(),
                label: account.label.clone(),
                active: account.active,
                plan: account.plan.clone(),
                windows: vec![],
                exhausted: false,
                fetched_at,
                source: "api".into(),
                error: Some(e.to_string()),
            };
        }
    };
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", tok))
        .header("anthropic-beta", BETA)
        .send()
        .await;
    match resp {
        Ok(r) if r.status().as_u16() == 401 => AgentAccountLimits {
            account_id: account.id.clone(),
            agent_id: "claude".into(),
            label: account.label.clone(),
            active: account.active,
            plan: account.plan.clone(),
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some("not logged in".into()),
        },
        Ok(r) if r.status().as_u16() == 429 => {
            let ra = parse_retry_after(r.headers().get("retry-after"));
            super::poll::set_backoff(&account.id, fetched_at + ra.unwrap_or(60) as i64);
            super::shared::throttled_account(
                "claude",
                &account.id,
                &account.label,
                account.active,
                fetched_at,
            )
        }
        Ok(r) if !r.status().is_success() => AgentAccountLimits {
            account_id: account.id.clone(),
            agent_id: "claude".into(),
            label: account.label.clone(),
            active: account.active,
            plan: account.plan.clone(),
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some(format!("http {}", r.status())),
        },
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(body) => map_usage(
                &body,
                fetched_at,
                &account.id,
                &account.label,
                account.active,
            ),
            Err(e) => AgentAccountLimits {
                account_id: account.id.clone(),
                agent_id: "claude".into(),
                label: account.label.clone(),
                active: account.active,
                plan: account.plan.clone(),
                windows: vec![],
                exhausted: false,
                fetched_at,
                source: "api".into(),
                error: Some(e.to_string()),
            },
        },
        Err(e) => AgentAccountLimits {
            account_id: account.id.clone(),
            agent_id: "claude".into(),
            label: account.label.clone(),
            active: account.active,
            plan: account.plan.clone(),
            windows: vec![],
            exhausted: false,
            fetched_at,
            source: "api".into(),
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A throttled poll must never masquerade as spent quota — that bug shipped
    /// once and painted a 47%-used account as exhausted.
    #[test]
    fn throttling_is_not_exhaustion() {
        let a =
            super::super::shared::throttled_account("claude", "claude:work", "work", false, 1000);
        assert!(!a.exhausted);
        assert!(a.windows.is_empty());
    }
    #[test]
    fn maps_sample_body() {
        let body: serde_json::Value = serde_json::from_str(r#"{"five_hour":{"utilization":42.5,"resets_at":1787212542},"seven_day":null,"seven_day_opus":{"utilization":10,"resets_at":"2026-08-29T00:00:00Z"}}"#).unwrap();
        let a = map_usage(&body, 0, "claude:personal", "personal", true);
        assert_eq!(a.windows.len(), 2);
        assert!(!a.exhausted);
    }
    #[test]
    fn exhausted_when_100() {
        let body: serde_json::Value =
            serde_json::from_str(r#"{"five_hour":{"utilization":100,"resets_at":0}}"#).unwrap();
        assert!(map_usage(&body, 0, "claude:personal", "personal", true).exhausted);
    }
    #[test]
    fn empty_plan_not_some() {
        let body: serde_json::Value =
            serde_json::from_str(r#"{"five_hour":{"utilization":10,"resets_at":0},"plan":""}"#)
                .unwrap();
        assert!(map_usage(&body, 0, "claude:personal", "personal", true)
            .plan
            .is_none());
    }
    #[test]
    fn choose_uses_live_when_identity_matches() {
        let live = AccountIdentity {
            email: Some("me@example.com".into()),
            plan: None,
        };
        let acct = AccountIdentity {
            email: Some("ME@example.com".into()),
            plan: None,
        };
        let tok = choose_token(
            Some(live),
            Some(acct),
            Some("live-tok".into()),
            Some("vault-tok".into()),
        );
        assert_eq!(tok.as_deref(), Some("live-tok"));
    }
    #[test]
    fn choose_prefers_vault_when_identity_mismatches() {
        let live = AccountIdentity {
            email: Some("other@example.com".into()),
            plan: None,
        };
        let acct = AccountIdentity {
            email: Some("me@example.com".into()),
            plan: None,
        };
        let tok = choose_token(
            Some(live),
            Some(acct),
            Some("live-tok".into()),
            Some("vault-tok".into()),
        );
        assert_eq!(tok.as_deref(), Some("vault-tok"));
    }
    #[test]
    fn choose_prefers_vault_when_identity_missing() {
        let live = AccountIdentity {
            email: None,
            plan: None,
        };
        let acct = AccountIdentity {
            email: Some("me@example.com".into()),
            plan: None,
        };
        let tok = choose_token(
            Some(live),
            Some(acct),
            Some("live-tok".into()),
            Some("vault-tok".into()),
        );
        assert_eq!(tok.as_deref(), Some("vault-tok"));
    }

    /// With no vault to fall back to and no way to confirm who the live login
    /// belongs to, the answer is "nothing" — not "use it anyway and hope".
    #[test]
    fn choose_returns_nothing_rather_than_an_unconfirmed_live_token() {
        let unconfirmable = AccountIdentity {
            email: None,
            plan: None,
        };
        let acct = AccountIdentity {
            email: Some("me@example.com".into()),
            plan: None,
        };
        assert_eq!(
            choose_token(
                Some(unconfirmable),
                Some(acct.clone()),
                Some("live-tok".into()),
                None
            ),
            None
        );
        // Same for an outright mismatch.
        let other = AccountIdentity {
            email: Some("someone.else@example.com".into()),
            plan: None,
        };
        assert_eq!(
            choose_token(Some(other), Some(acct), Some("live-tok".into()), None),
            None
        );
    }

    #[test]
    fn expired_token_detected() {
        let raw = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"t","expiresAt":{}}}}}"#,
            1
        );
        assert!(is_token_expired_for_test(&raw));
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
            + 3_600_000;
        let raw2 = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"t","expiresAt":{}}}}}"#,
            future
        );
        assert!(!is_token_expired_for_test(&raw2));
    }
    #[tokio::test]
    async fn expired_yields_error_no_http() {
        // expired vault token should be surfaced via poll path without HTTP; test the helper
        assert!(is_token_expired_for_test(
            r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":1}}"#
        ));
        // fetch_for_account with None already returns not logged in; expiry is handled in poll layer
        // verify expired detection does not need network
        let acc = crate::daemon::store::StoredAccount {
            id: "claude:personal".into(),
            agent_id: "claude".into(),
            label: "personal".into(),
            email: None,
            plan: None,
            home_dir: "/tmp/nonexistent".into(),
            created_at: 0,
            active: true,
        };
        // token None path
        let res = fetch_for_account(&acc, None, 0).await;
        assert_eq!(res.error.as_deref(), Some("not logged in"));
    }
}
