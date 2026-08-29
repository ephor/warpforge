use std::path::Path;

use warpforge_protocol::AgentAccountLimits;

use crate::daemon::claude_auth;
use crate::daemon::store::StoredAccount;

use super::claude_usage::{
    account_identity, choose_token, extract_access_token, map_usage, token_expired,
};

const USAGE_PATH: &str = "/api/oauth/usage";
const BETA: &str = "oauth-2025-04-20";
const TIMEOUT_SECS: u64 = 10;

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
                // `choose_token` owns the decision, including refusing to answer
                // at all when it cannot confirm the live login belongs here.
                return choose_token(live_id, acct_id, live_token, vault_token);
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
    use super::super::claude_usage::is_token_expired_for_test;
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
