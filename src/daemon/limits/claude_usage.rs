//! Reading Claude's usage body, and deciding which credential may speak for an
//! account.
//!
//! All of it is functions over JSON and strings, kept apart from the HTTP and
//! keychain work in `limits::claude` so the network side stays small enough to
//! read.

use std::path::Path;

use warpforge_protocol::{AgentAccountLimits, AgentLimitWindow};

use crate::daemon::accounts::AccountIdentity;
use crate::daemon::claude_auth;
use crate::daemon::store::StoredAccount;

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

pub fn extract_access_token(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|s| s.as_str())
        .or_else(|| v.get("accessToken").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
}

pub fn token_expired(raw: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
