//! Last-known quota snapshot, kept on disk so a daemon restart shows numbers
//! immediately instead of empty cards plus an instant round of HTTP at every
//! provider. Restarting eight times in an afternoon is how we earned a 429 from
//! Anthropic; the cache makes a restart cost nothing.
//!
//! It lives in its own small JSON file rather than `warpforge.db`: this is
//! disposable state a few kilobytes wide, and the database is half a gigabyte
//! with a WAL to match. Losing this file must cost nothing, so it is written
//! atomically (temp + rename) and every read failure means "start empty".
//!
//! Each entry records the identity of the login that produced it. A cached
//! number whose account we cannot re-confirm at load is thrown away — showing
//! one account's quota under another account's name is worse than showing
//! nothing, and that mislabelling has happened here before.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use warpforge_protocol::AgentAccountLimits;

use crate::daemon::store::StoredAccount;

/// A persisted snapshot entry: the wire value plus the login it belongs to.
///
/// `identity` deliberately lives here and not on `AgentAccountLimits` — that
/// type is mirrored by the desktop client, and this is daemon-private bookkeeping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedLimits {
    #[serde(default)]
    pub identity: Option<String>,
    pub limits: AgentAccountLimits,
}

fn cache_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
        .join("agent-limits.json")
}

/// Emails compare case-insensitively and an empty string names nobody.
fn normalize(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

/// Who is signed in as the account this entry describes, right now.
///
/// Registered accounts answer from their own vault; the synthesized `:live`
/// rows answer from whatever login the provider's default home currently holds,
/// which is exactly the thing that can change between launches.
fn current_identity(
    agent_id: &str,
    account_id: &str,
    accounts: &[StoredAccount],
) -> Option<String> {
    let stored = accounts.iter().find(|a| a.id == account_id);
    if stored.is_none() && !account_id.ends_with(":live") {
        // An account we no longer have: nothing can confirm the entry, and a
        // removed account must not reappear as a card.
        return None;
    }
    let raw = match (agent_id, stored) {
        ("claude", Some(account)) => {
            super::claude_usage::account_identity(account).and_then(|id| id.email)
        }
        ("claude", None) => live_claude_email(),
        ("codex", Some(account)) => codex_account_email(account),
        ("codex", None) => super::codex::live_identity(),
        // opencode has no per-account vault: only the live key identifies it.
        ("opencode", _) => super::opencode::live_identity(),
        _ => None,
    };
    raw.as_deref().and_then(normalize)
}

fn live_claude_email() -> Option<String> {
    let account = crate::daemon::claude_auth::ClaudeRuntime::detect().read_live_oauth_account()?;
    crate::daemon::accounts::claude_identity(&account.to_string()).email
}

fn codex_account_email(account: &StoredAccount) -> Option<String> {
    if let Some(email) = account.email.as_deref().and_then(normalize) {
        return Some(email);
    }
    let raw = std::fs::read_to_string(Path::new(&account.home_dir).join("auth.json")).ok()?;
    crate::daemon::accounts::codex_identity(&raw).email
}

/// Write the snapshot. Failures are not worth interrupting a poll over.
pub fn save(limits: &[AgentAccountLimits], accounts: &[StoredAccount]) {
    let entries: Vec<CachedLimits> = limits
        .iter()
        .map(|l| CachedLimits {
            identity: current_identity(&l.agent_id, &l.account_id, accounts),
            limits: l.clone(),
        })
        .collect();
    if let Err(e) = save_to(&cache_path(), &entries) {
        eprintln!("[limits] could not cache quota snapshot: {e}");
    }
}

/// Last known snapshot, minus anything we cannot re-confirm belongs to the
/// account it is filed under.
pub fn load(accounts: &[StoredAccount]) -> Vec<AgentAccountLimits> {
    load_from(&cache_path(), accounts)
}

fn save_to(path: &Path, entries: &[CachedLimits]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(entries)?;
    // Temp + rename: a crash mid-write leaves the previous snapshot intact
    // rather than a truncated file the next launch has to guess about.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            Err(e)
        }
    }
}

fn load_from(path: &Path, accounts: &[StoredAccount]) -> Vec<AgentAccountLimits> {
    // Absent, unreadable or corrupt all mean the same thing: no history.
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(entries) = serde_json::from_str::<Vec<CachedLimits>>(&raw) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| {
            // A `<agent>:live` row stands in for a login the user never
            // registered. Once one IS registered and active, the poller stops
            // emitting that row — but a cache written before the import still
            // carries it, and it renders as a second card for the same login,
            // doubling the quota and spend on screen until the next poll.
            if entry.limits.account_id.ends_with(":live")
                && accounts
                    .iter()
                    .any(|a| a.agent_id == entry.limits.agent_id && a.active)
            {
                return false;
            }
            let cached = entry.identity.as_deref().and_then(normalize);
            let current =
                current_identity(&entry.limits.agent_id, &entry.limits.account_id, accounts);
            // Unknown on either side is not a match: an unverifiable number is
            // the failure this cache exists to avoid. Never relabel, only drop.
            matches!((cached, current), (Some(a), Some(b)) if a == b)
        })
        .map(|entry| entry.limits)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use warpforge_protocol::AgentLimitWindow;

    fn account(id: &str, email: Option<&str>, home: &Path) -> StoredAccount {
        StoredAccount {
            id: id.into(),
            agent_id: "claude".into(),
            label: "personal".into(),
            email: email.map(str::to_string),
            plan: None,
            home_dir: home.to_string_lossy().into_owned(),
            created_at: 0,
            active: true,
        }
    }

    fn limits(account_id: &str) -> AgentAccountLimits {
        AgentAccountLimits {
            account_id: account_id.into(),
            agent_id: "claude".into(),
            label: "personal".into(),
            active: true,
            plan: Some("max".into()),
            windows: vec![AgentLimitWindow {
                id: "five_hour".into(),
                label: "Session".into(),
                used_percent: 53.0,
                resets_at: Some(1000),
                window_minutes: Some(300),
            }],
            exhausted: false,
            fetched_at: 100,
            source: "api".into(),
            error: None,
        }
    }

    fn save_snapshot(path: &Path, limits: &[AgentAccountLimits], accounts: &[StoredAccount]) {
        let entries: Vec<CachedLimits> = limits
            .iter()
            .map(|l| CachedLimits {
                identity: current_identity(&l.agent_id, &l.account_id, accounts),
                limits: l.clone(),
            })
            .collect();
        save_to(path, &entries).unwrap();
    }

    #[test]
    fn round_trips_through_the_persisted_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-limits.json");
        let accounts = vec![account(
            "claude:personal",
            Some("me@example.com"),
            dir.path(),
        )];
        let snapshot = vec![limits("claude:personal")];

        save_snapshot(&path, &snapshot, &accounts);
        assert_eq!(load_from(&path, &accounts), snapshot);
    }

    #[test]
    fn entry_whose_identity_changed_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-limits.json");
        let before = vec![account(
            "claude:personal",
            Some("work@example.com"),
            dir.path(),
        )];
        save_snapshot(&path, &[limits("claude:personal")], &before);

        // Same account row, different login behind it now.
        let after = vec![account(
            "claude:personal",
            Some("personal@example.com"),
            dir.path(),
        )];
        assert!(load_from(&path, &after).is_empty());
    }

    #[test]
    fn entry_with_unknown_identity_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-limits.json");
        // No stored email and no vault identity file: nothing names this login.
        let accounts = vec![account("claude:personal", None, dir.path())];
        save_snapshot(&path, &[limits("claude:personal")], &accounts);

        assert!(load_from(&path, &accounts).is_empty());
    }

    #[test]
    fn entry_for_a_removed_account_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-limits.json");
        let accounts = vec![account(
            "claude:personal",
            Some("me@example.com"),
            dir.path(),
        )];
        save_snapshot(&path, &[limits("claude:personal")], &accounts);

        assert!(load_from(&path, &[]).is_empty());
    }

    /// Importing an account leaves a cache that still holds the unregistered
    /// login it replaced. Serving both renders the same quota and spend twice.
    #[test]
    fn live_entry_is_dropped_once_that_agent_has_a_registered_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-limits.json");
        let live = account("claude:live", Some("me@example.com"), dir.path());
        save_snapshot(&path, &[limits("claude:live")], &[live]);

        // Before the import the row is the only thing describing that login.
        assert_eq!(
            load_from(&path, &[]).len(),
            0,
            "no accounts: nothing to confirm it"
        );

        let registered = account("claude:personal", Some("me@example.com"), dir.path());
        assert!(
            load_from(&path, std::slice::from_ref(&registered)).is_empty(),
            "the registered account now covers this login"
        );
    }

    #[test]
    fn missing_or_corrupt_file_yields_an_empty_cache() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = vec![account(
            "claude:personal",
            Some("me@example.com"),
            dir.path(),
        )];

        let missing = dir.path().join("nope.json");
        assert!(load_from(&missing, &accounts).is_empty());

        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "{not json at all").unwrap();
        assert!(load_from(&corrupt, &accounts).is_empty());
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-limits.json");
        let accounts = vec![account(
            "claude:personal",
            Some("me@example.com"),
            dir.path(),
        )];
        save_snapshot(&path, &[limits("claude:personal")], &accounts);

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
