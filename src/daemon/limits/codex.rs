use std::path::{Path, PathBuf};

use warpforge_protocol::AgentAccountLimits;

use crate::daemon::store::StoredAccount;

use super::codex_auth::{self, Credential};
use super::codex_usage::{find_latest_rollout, map_rate_limits, map_wham, tail_find_rate_limits};

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
    codex_auth::auth_paths()
}

pub fn has_live_login() -> bool {
    codex_auth::live_auth().is_some()
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

/// The usage request for one credential.
///
/// `ChatGPT-Account-Id` names the organisation the token should act as — a
/// login that belongs to several answers for the wrong one without it. Omitted
/// when the credential does not name one, which is what the Codex clients do.
fn usage_request(
    client: &reqwest::Client,
    credential: &Credential,
) -> reqwest::Result<reqwest::Request> {
    let mut request = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {}", credential.token));
    if let Some(org) = credential.chatgpt_account_id.as_deref() {
        request = request.header("ChatGPT-Account-Id", org);
    }
    request.build()
}

/// Ask one account's own credential about its quota.
///
/// Each registered account is queried on the token in its own vault, so a
/// non-active account is as answerable as the active one. Only the synthesized
/// `codex:live` row speaks for whatever login Codex's own home holds.
pub async fn fetch_for_account(account: &StoredAccount, fetched_at: i64) -> AgentAccountLimits {
    let selection = codex_auth::select(account);
    let owns_live_home = selection.owns_live_home;
    let Some(credential) = selection.credential else {
        return empty(account, fetched_at, "api", Some("not logged in".into()));
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => return fallback(account, fetched_at, Some(e.to_string()), owns_live_home),
    };
    let request = match usage_request(&client, &credential) {
        Ok(r) => r,
        Err(e) => return fallback(account, fetched_at, Some(e.to_string()), owns_live_home),
    };
    match client.execute(request).await {
        Ok(r) if r.status().as_u16() == 429 => {
            let ra = parse_retry_after(r.headers().get("retry-after"));
            super::poll::set_backoff(&account.id, fetched_at + ra.unwrap_or(60) as i64);
            super::shared::throttled_account(
                "codex",
                &account.id,
                &account.label,
                account.active,
                fetched_at,
            )
        }
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(body) => map_wham(
                &body,
                fetched_at,
                &account.id,
                &account.label,
                account.active,
            ),
            Err(_) => fallback(account, fetched_at, None, owns_live_home),
        },
        Ok(r) if r.status().as_u16() == 401 => {
            empty(account, fetched_at, "api", Some("not logged in".into()))
        }
        _ => fallback(account, fetched_at, None, owns_live_home),
    }
}

/// A row carrying no numbers, only why there are none.
fn empty(
    account: &StoredAccount,
    fetched_at: i64,
    source: &str,
    error: Option<String>,
) -> AgentAccountLimits {
    AgentAccountLimits {
        account_id: account.id.clone(),
        agent_id: "codex".into(),
        label: account.label.clone(),
        active: account.active,
        plan: account.plan.clone(),
        windows: vec![],
        exhausted: false,
        fetched_at,
        source: source.to_string(),
        error,
    }
}

fn fallback(
    account: &StoredAccount,
    fetched_at: i64,
    err: Option<String>,
    owns_live_home: bool,
) -> AgentAccountLimits {
    fallback_from(&codex_home(), account, fetched_at, err, owns_live_home)
}

/// Last resort when the network call fails: the rate limits Codex recorded in
/// its most recent rollout file.
///
/// That file is global to the machine — it belongs to whichever login was
/// running, not to the account being described. So it may only be read for an
/// account we have confirmed owns that home; anything else gets no windows and
/// an honest error, never another account's numbers under this one's name.
fn fallback_from(
    home: &Path,
    account: &StoredAccount,
    fetched_at: i64,
    err: Option<String>,
    owns_live_home: bool,
) -> AgentAccountLimits {
    if owns_live_home {
        if let Some(p) = find_latest_rollout(home) {
            if let Some(line) = tail_find_rate_limits(&p) {
                if let Some(mapped) = map_rate_limits(
                    &line,
                    fetched_at,
                    &account.id,
                    &account.label,
                    account.active,
                ) {
                    return mapped;
                }
            }
        }
    }
    let reason = if owns_live_home {
        "no rollout file"
    } else {
        "no usage for this account and no local data that provably belongs to it"
    };
    empty(
        account,
        fetched_at,
        "local",
        err.or_else(|| Some(reason.into())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, active: bool) -> StoredAccount {
        StoredAccount {
            id: id.into(),
            agent_id: "codex".into(),
            label: "work".into(),
            email: None,
            plan: None,
            home_dir: String::new(),
            created_at: 0,
            active,
        }
    }

    /// A login that belongs to several ChatGPT organisations answers for the
    /// wrong one without this header.
    #[test]
    fn the_organisation_header_rides_along_when_the_login_names_one() {
        let client = reqwest::Client::new();
        let request = usage_request(
            &client,
            &Credential {
                token: "tok".into(),
                chatgpt_account_id: Some("org-1".into()),
            },
        )
        .unwrap();
        assert_eq!(
            request.headers().get("Authorization").unwrap(),
            "Bearer tok"
        );
        assert_eq!(
            request.headers().get("ChatGPT-Account-Id").unwrap(),
            "org-1"
        );
    }

    #[test]
    fn the_organisation_header_is_omitted_when_the_login_names_none() {
        let client = reqwest::Client::new();
        let request = usage_request(
            &client,
            &Credential {
                token: "tok".into(),
                chatgpt_account_id: None,
            },
        )
        .unwrap();
        assert!(request.headers().get("ChatGPT-Account-Id").is_none());
    }

    /// The rollout file is whatever login was last running on this machine.
    /// Filing its numbers under an account we cannot tie to that login is the
    /// mislabelling this whole path exists to avoid.
    #[test]
    fn the_rollout_file_is_only_read_for_the_account_that_owns_the_home() {
        let home = tempfile::tempdir().unwrap();
        let day = home.path().join("sessions/2026/08/29");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join("rollout-2026-08-29.jsonl"),
            "{\"rate_limits\":{\"primary\":{\"used_percent\":81.0,\"window_minutes\":10080,\"resets_at\":7},\"secondary\":null}}\n",
        )
        .unwrap();

        // Confirmed to be this home's login: the local numbers are its own.
        let owner = fallback_from(home.path(), &account("codex:personal", true), 0, None, true);
        assert_eq!(owner.windows.len(), 1);
        assert_eq!(owner.windows[0].used_percent, 81.0);

        // Anybody else gets nothing, and is told why.
        let stranger = fallback_from(home.path(), &account("codex:work", false), 0, None, false);
        assert!(stranger.windows.is_empty());
        assert!(!stranger.exhausted);
        assert!(!stranger.active);
        assert!(stranger
            .error
            .as_deref()
            .is_some_and(|e| e.contains("provably belongs")));
    }
}
