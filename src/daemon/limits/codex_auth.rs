//! Which Codex credential answers for which account.
//!
//! Every registered Codex account owns an `auth.json` inside its vault, written
//! at import (`accounts::import_agent_login`), so a quota question can be asked
//! with that account's own bearer token instead of whatever login Codex's own
//! home happens to hold right now.
//!
//! The live copy is still worth preferring — it is the one Codex keeps
//! refreshed — but *only* when it provably belongs to the same login. An
//! out-of-band `codex login` swaps that file under us, and reporting one
//! account's quota under another account's name is the specific bug that
//! shipped here before. So the rule is Claude's (`limits::claude::choose_token`):
//! live on a positive identity match, otherwise the vault, otherwise nothing.

use std::path::{Path, PathBuf};

use crate::daemon::accounts::{codex_identity, AccountIdentity};
use crate::daemon::store::StoredAccount;

/// A usable Codex credential, with both halves read out of the same `auth.json`
/// so the token and the organisation it is scoped to can never disagree.
#[derive(Debug, Clone, PartialEq)]
pub struct Credential {
    pub token: String,
    /// `tokens.account_id`: the ChatGPT organisation this login is acting as.
    /// Absent when the file does not name one.
    pub chatgpt_account_id: Option<String>,
}

/// Where Codex's own home may keep its credentials.
pub fn auth_paths() -> Vec<PathBuf> {
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

fn parse_token(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if let Some(token) = value
        .get("tokens")
        .and_then(|t| t.get("access_token"))
        .and_then(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        return Some(token.to_string());
    }
    value
        .get("OPENAI_API_KEY")
        .and_then(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

fn parse_chatgpt_account_id(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    value
        .get("tokens")
        .and_then(|t| t.get("account_id"))
        .and_then(|s| s.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// A credential out of an `auth.json` blob, or `None` when it carries no token.
pub fn credential_from(raw: &str) -> Option<Credential> {
    Some(Credential {
        token: parse_token(raw)?,
        chatgpt_account_id: parse_chatgpt_account_id(raw),
    })
}

/// The `auth.json` of the login in Codex's own home — the first one that
/// actually carries a token, so an empty file earlier in the list cannot mask a
/// real login later in it.
pub fn live_auth() -> Option<String> {
    auth_paths().into_iter().find_map(|path| {
        let raw = std::fs::read_to_string(&path).ok()?;
        parse_token(&raw).map(|_| raw)
    })
}

/// The `auth.json` an account keeps in its own vault.
///
/// An empty `home_dir` is the synthesized `:live` row, which has no vault; it
/// must not fall through to a relative `auth.json` in the daemon's cwd.
pub fn vault_auth(account: &StoredAccount) -> Option<String> {
    if account.home_dir.trim().is_empty() {
        return None;
    }
    std::fs::read_to_string(Path::new(&account.home_dir).join("auth.json")).ok()
}

/// Whether an account row stands for Codex's own home rather than a vault.
pub fn is_live_row(account: &StoredAccount) -> bool {
    account.id.ends_with(":live")
}

/// Who this account is, preferring what the switcher already recorded and
/// falling back to the claims inside its own vault credentials.
pub fn account_identity(
    account: &StoredAccount,
    vault_auth: Option<&str>,
) -> Option<AccountIdentity> {
    if let Some(email) = account.email.as_deref().filter(|e| !e.trim().is_empty()) {
        return Some(AccountIdentity {
            email: Some(email.to_string()),
            plan: account.plan.clone(),
        });
    }
    let identity = codex_identity(vault_auth?);
    identity.email.is_some().then_some(identity)
}

/// Whether both sides name the same login. An identity we cannot read on either
/// side is never a match — that is the whole point of asking.
pub fn same_login(live: Option<&AccountIdentity>, account: Option<&AccountIdentity>) -> bool {
    match (
        live.and_then(|i| i.email.as_deref()),
        account.and_then(|i| i.email.as_deref()),
    ) {
        (Some(live), Some(acct)) if !live.trim().is_empty() && !acct.trim().is_empty() => {
            live.trim().eq_ignore_ascii_case(acct.trim())
        }
        _ => false,
    }
}

/// Which `auth.json` blob to ask about this account's quota.
///
/// Mirrors `limits::claude::choose_token`: the live copy only on a confirmed
/// identity match, this account's vault otherwise, and nothing at all when the
/// vault has none. Reporting "not logged in" is honest; reporting somebody
/// else's numbers is not.
pub fn choose_auth(
    live_identity: Option<AccountIdentity>,
    account_identity: Option<AccountIdentity>,
    live_auth: Option<String>,
    vault_auth: Option<String>,
) -> Option<String> {
    if same_login(live_identity.as_ref(), account_identity.as_ref()) {
        live_auth.or(vault_auth)
    } else {
        vault_auth
    }
}

/// The credential to query an account's quota with, plus whether the machine's
/// own Codex home belongs to it.
#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    pub credential: Option<Credential>,
    /// The rollout files under Codex's own home are global to the machine, so
    /// their numbers may only be attributed to an account when this holds.
    pub owns_live_home: bool,
}

/// Resolve an account to the credential that speaks for it.
pub fn select(account: &StoredAccount) -> Selection {
    let live = live_auth();
    if is_live_row(account) {
        return Selection {
            credential: live.as_deref().and_then(credential_from),
            owns_live_home: true,
        };
    }
    let vault = vault_auth(account);
    let live_identity = live.as_deref().map(codex_identity);
    let account_identity = account_identity(account, vault.as_deref());
    let owns_live_home = same_login(live_identity.as_ref(), account_identity.as_ref());
    let chosen = choose_auth(live_identity, account_identity, live, vault);
    Selection {
        credential: chosen.as_deref().and_then(credential_from),
        owns_live_home,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Payload: {"email":"me@example.com",
    ///           "https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}
    const ME_CLAIMS: &str = "eyJlbWFpbCI6Im1lQGV4YW1wbGUuY29tIiwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfcGxhbl90eXBlIjoicHJvIn19";

    fn auth(token: &str, account_id: Option<&str>) -> String {
        let account_id = account_id
            .map(|id| format!(",\"account_id\":\"{id}\""))
            .unwrap_or_default();
        format!(
            "{{\"tokens\":{{\"access_token\":\"{token}\",\"id_token\":\"h.{ME_CLAIMS}.s\"{account_id}}}}}"
        )
    }

    fn identity(email: &str) -> AccountIdentity {
        AccountIdentity {
            email: Some(email.to_string()),
            plan: None,
        }
    }

    #[test]
    fn credential_carries_the_token_and_the_organisation() {
        let c = credential_from(&auth("tok", Some("org-1"))).unwrap();
        assert_eq!(c.token, "tok");
        assert_eq!(c.chatgpt_account_id.as_deref(), Some("org-1"));

        // An empty `account_id` names nobody — the header must be omitted.
        let c = credential_from(&auth("tok", Some(""))).unwrap();
        assert_eq!(c.chatgpt_account_id, None);
        let c = credential_from(&auth("tok", None)).unwrap();
        assert_eq!(c.chatgpt_account_id, None);

        // An API-key login still has a bearer token.
        let c = credential_from(r#"{"OPENAI_API_KEY":"sk-1"}"#).unwrap();
        assert_eq!(c.token, "sk-1");
        // Nothing usable at all.
        assert_eq!(credential_from("{}"), None);
        assert_eq!(credential_from("not json"), None);
    }

    #[test]
    fn live_token_is_used_when_the_identity_matches() {
        let chosen = choose_auth(
            Some(identity("me@example.com")),
            Some(identity("ME@Example.com")),
            Some("live".into()),
            Some("vault".into()),
        );
        assert_eq!(chosen.as_deref(), Some("live"));
    }

    #[test]
    fn a_mismatched_live_login_falls_back_to_the_vault() {
        let chosen = choose_auth(
            Some(identity("someone.else@example.com")),
            Some(identity("me@example.com")),
            Some("live".into()),
            Some("vault".into()),
        );
        assert_eq!(chosen.as_deref(), Some("vault"));
    }

    /// With nobody named on one side there is no match to confirm, and with no
    /// vault to fall back to the answer is "nothing" — not "use it and hope".
    #[test]
    fn an_unconfirmable_live_login_is_never_borrowed() {
        let unnamed = AccountIdentity::default();
        assert_eq!(
            choose_auth(
                Some(unnamed),
                Some(identity("me@example.com")),
                Some("live".into()),
                None
            ),
            None
        );
        assert_eq!(
            choose_auth(
                Some(identity("someone.else@example.com")),
                Some(identity("me@example.com")),
                Some("live".into()),
                None
            ),
            None
        );
        // …and an account we cannot name either.
        assert_eq!(
            choose_auth(
                Some(identity("me@example.com")),
                None,
                Some("live".into()),
                None
            ),
            None
        );
    }

    #[test]
    fn a_vaulted_account_answers_on_its_own_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("auth.json"),
            auth("vault-tok", Some("org-9")),
        )
        .unwrap();
        let account = StoredAccount {
            id: "codex:work".into(),
            agent_id: "codex".into(),
            label: "work".into(),
            // A login the machine's own Codex home is not signed into.
            email: Some("work@example.com".into()),
            plan: None,
            home_dir: dir.path().to_string_lossy().into_owned(),
            created_at: 0,
            active: false,
        };
        let selection = select(&account);
        let credential = selection.credential.expect("vault credential");
        assert_eq!(credential.token, "vault-tok");
        assert_eq!(credential.chatgpt_account_id.as_deref(), Some("org-9"));
        // Nothing confirmed this account owns the machine's Codex home, so the
        // machine-global rollout file must not be read as its numbers.
        assert!(!selection.owns_live_home);
    }

    #[test]
    fn a_live_row_has_no_vault_to_read() {
        let account = StoredAccount {
            id: "codex:live".into(),
            agent_id: "codex".into(),
            label: "live".into(),
            email: None,
            plan: None,
            home_dir: String::new(),
            created_at: 0,
            active: true,
        };
        assert!(is_live_row(&account));
        assert_eq!(vault_auth(&account), None);
        assert!(select(&account).owns_live_home);
    }
}
