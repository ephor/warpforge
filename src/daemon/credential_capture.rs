//! Capturing the token rotations the agent CLIs perform.
//!
//! A vault is written once, at import (`accounts::import_agent_login`). After
//! that the CLI is the only thing that ever refreshes a credential, and it does
//! so wherever it happens to be running: a task pinned to an account refreshes
//! inside that account's vault, but a task that predates accounts runs in the
//! agent's *own* home and rotates the token there. Both homes started from the
//! same refresh token, so the first refresh anywhere invalidates the other
//! copy — and the vault, never written again, is the one that goes stale.
//! Deleting and re-importing the account was the only cure.
//!
//! Nothing here refreshes anything. It notices that a refresh already happened
//! and files the result under the right account:
//!
//! 1. Remember the bytes last seen in — or written to — the home the CLI runs in.
//! 2. Re-read. Identical → nothing happened, stop.
//! 3. Different → the CLI rotated the token. Attribute the new bytes to an
//!    account **by identity**, never by "it was probably the active one".
//! 4. No single match → refuse and log, write nothing. A wrong write logs
//!    somebody out of an account they never touched.
//! 5. No baseline (a fresh daemon) → identity alone does not prove the runtime
//!    copy is the newer one, so a strictly newer refresh stamp is required too.
//!
//! Everything is best-effort: a failure costs one more stale cycle, which is
//! the thing being fixed anyway — it must never cost a working login. Writes go
//! through a temp file and a rename at `0600`, so a crash mid-write can never
//! leave a vault holding half a credential.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use super::accounts;
use super::claude_auth::{self, ClaudeRuntime};
use super::limits::codex_auth;
use super::store::StoredAccount;

/// Credential file inside a Codex vault (the vault *is* a `CODEX_HOME`).
const CODEX_AUTH_FILE: &str = "auth.json";

/// What one capture attempt did. `Rejected` is never a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Capture {
    /// Nothing readable there, or the same bytes we last saw.
    Unchanged,
    /// The rotated credential now lives in this account's storage.
    Persisted(String),
    /// Something changed that could not be filed safely.
    Rejected(&'static str),
}

/// Where a captured credential would go, and what is stored there now.
struct Target {
    id: String,
    /// A vault proven ours. `None` for a Claude account whose vault stopped
    /// verifying — the keychain copy is still worth updating.
    vault: Option<PathBuf>,
    /// The credential that account already has, when it is readable.
    stored: Option<String>,
}

#[derive(Debug, Default)]
pub struct CredentialCapture {
    /// Bytes last seen in — or written to — each agent's live credential
    /// store, keyed by agent id. A later difference is the CLI's own rotation:
    /// warpforge writes there only on an explicit account switch, and records
    /// what it wrote here when it does.
    baselines: HashMap<&'static str, String>,
}

impl CredentialCapture {
    /// Capture whatever the CLIs rotated since the last look, for every agent
    /// that keeps credentials we can file.
    /// An agent with no vaults has nothing to file, so it is not looked at all
    /// — no credential read, and no "nobody owns this login" for the ordinary
    /// case of a user who never registered an account.
    pub fn run(&mut self, runtime: &ClaudeRuntime, accounts: &[StoredAccount]) {
        if managed(accounts, "codex").next().is_some() {
            report("codex", self.capture_codex(accounts));
        }
        if managed(accounts, "claude").next().is_some() {
            report("claude", self.capture_claude(runtime, accounts, None));
        }
    }

    /// Remember credentials we just made live, so the next capture can tell the
    /// CLI's rotation from our own write.
    pub fn note_live_claude(&mut self, credentials: &str) {
        self.baselines.insert("claude", credentials.to_string());
    }

    fn capture_codex(&mut self, accounts: &[StoredAccount]) -> Capture {
        let Some(live) = live_codex_auth_path() else {
            return Capture::Unchanged;
        };
        self.capture_codex_at(&accounts::accounts_root(), &live, accounts)
    }

    fn capture_codex_at(
        &mut self,
        root: &Path,
        live: &Path,
        accounts: &[StoredAccount],
    ) -> Capture {
        let Ok(contents) = std::fs::read_to_string(live) else {
            return Capture::Unchanged;
        };
        // A blob with no token is a logged-out or half-written home. Filing it
        // would replace a working vault credential with nothing.
        if codex_auth::credential_from(&contents).is_none() {
            return Capture::Unchanged;
        }
        let baseline = self.baselines.get("codex").cloned();
        if baseline.as_deref() == Some(contents.as_str()) {
            return Capture::Unchanged;
        }
        let target = match attribute_codex(root, accounts, &contents) {
            Ok(target) => target,
            Err(reason) => return Capture::Rejected(reason),
        };
        let strict = baseline.is_none();
        self.commit("codex", &target, &contents, codex_freshness, strict, |t| {
            let vault = t.vault.as_deref().context("no verified vault")?;
            write_credential_atomically(vault, CODEX_AUTH_FILE, &contents)
        })
    }

    /// Capture a Claude rotation out of the live credential store.
    ///
    /// `expected` names the account a switch is moving *away* from. That is the
    /// one case where identity is used only to veto: the credentials blob
    /// carries no identity of its own, and an unknown one must keep the
    /// token-preserving behaviour the switch has always had. Unattended
    /// captures pass `None` and require a positive, unambiguous match.
    pub fn capture_claude(
        &mut self,
        runtime: &ClaudeRuntime,
        accounts: &[StoredAccount],
        expected: Option<&StoredAccount>,
    ) -> Capture {
        self.capture_claude_under(&accounts::accounts_root(), runtime, accounts, expected)
    }

    pub(crate) fn capture_claude_under(
        &mut self,
        root: &Path,
        runtime: &ClaudeRuntime,
        accounts: &[StoredAccount],
        expected: Option<&StoredAccount>,
    ) -> Capture {
        let Ok(Some(contents)) = runtime.read_live_credentials() else {
            return Capture::Unchanged;
        };
        // The empty blob a CLI writes when it loses a refresh race: storing it
        // logs the account out for good.
        if !claude_auth::credentials_are_usable(&contents) {
            return Capture::Unchanged;
        }
        let baseline = self.baselines.get("claude").cloned();
        if baseline.as_deref() == Some(contents.as_str()) {
            return Capture::Unchanged;
        }
        let target = match expected {
            Some(account) => {
                if live_belongs_to(runtime, account) {
                    Ok(claude_target(root, runtime, account))
                } else {
                    Err("the live login belongs to a different account")
                }
            }
            None => attribute_claude(root, runtime, accounts),
        };
        let target = match target {
            Ok(target) => target,
            Err(reason) => return Capture::Rejected(reason),
        };
        // A named outgoing account supplies the attribution the identity check
        // cannot, and its live credential is about to be overwritten — so the
        // no-baseline rule would trade a stale vault for no vault at all.
        let strict = expected.is_none() && baseline.is_none();
        self.commit(
            "claude",
            &target,
            &contents,
            claude_freshness,
            strict,
            |t| {
                runtime.write_managed_credentials(&t.id, &contents)?;
                match t.vault.as_deref() {
                    Some(vault) => {
                        write_credential_atomically(vault, claude_auth::CREDENTIALS_FILE, &contents)
                    }
                    None => Ok(()),
                }
            },
        )
    }

    /// Gate a candidate credential and, if it passes, store it.
    fn commit(
        &mut self,
        agent: &'static str,
        target: &Target,
        contents: &str,
        freshness: fn(&str) -> Option<i64>,
        strict: bool,
        write: impl FnOnce(&Target) -> Result<()>,
    ) -> Capture {
        if target.stored.as_deref() == Some(contents) {
            // The account already holds these bytes — the CLI refreshed
            // straight into its own vault. Nothing to do but remember them.
            self.baselines.insert(agent, contents.to_string());
            return Capture::Unchanged;
        }
        let candidate = freshness(contents);
        let stored = target.stored.as_deref().and_then(freshness);
        let fresher = matches!((candidate, stored), (Some(c), Some(s)) if c > s);
        // Provably not newer than what the account already has: a rollback,
        // which would swap a live token for a dead one.
        if matches!((candidate, stored), (Some(c), Some(s)) if c <= s) {
            return Capture::Rejected("older than the credential already stored");
        }
        if strict && !fresher {
            return Capture::Rejected("no baseline, and no proof it is newer");
        }
        if let Err(error) = write(target) {
            eprintln!("[accounts] could not store the rotated {agent} credential: {error}");
            return Capture::Rejected("could not be written");
        }
        self.baselines.insert(agent, contents.to_string());
        Capture::Persisted(target.id.clone())
    }
}

fn report(agent: &str, outcome: Capture) {
    match outcome {
        Capture::Persisted(id) => {
            eprintln!("[accounts] stored a rotated {agent} credential under '{id}'");
        }
        Capture::Rejected(reason) => {
            eprintln!("[accounts] not storing the rotated {agent} credential: {reason}");
        }
        Capture::Unchanged => {}
    }
}

/// The `auth.json` Codex's own home is actually using — the first path that
/// carries a token, so an empty file earlier in the list cannot mask a real
/// login later in it (the rule `limits::codex_auth::live_auth` already applies).
fn live_codex_auth_path() -> Option<PathBuf> {
    codex_auth::auth_paths().into_iter().find(|path| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| codex_auth::credential_from(&raw))
            .is_some()
    })
}

/// Which account a rotated Codex credential belongs to, by the identity inside
/// it. Exactly one match, or nothing.
fn attribute_codex(
    root: &Path,
    accounts: &[StoredAccount],
    contents: &str,
) -> Result<Target, &'static str> {
    let identity = accounts::codex_identity(contents);
    if identity.email.as_deref().unwrap_or("").trim().is_empty() {
        return Err("it names no account");
    }
    let org = codex_auth::credential_from(contents).and_then(|c| c.chatgpt_account_id);
    let mut matched: Vec<Target> = Vec::new();
    for account in managed(accounts, "codex") {
        let Ok(vault) =
            accounts::verify_vault_under(root, Path::new(&account.home_dir), &account.id)
        else {
            continue;
        };
        let stored = accounts::read_vault_file(&vault, CODEX_AUTH_FILE)
            .ok()
            .flatten();
        if !codex_auth::same_login(
            Some(&identity),
            codex_auth::account_identity(account, stored.as_deref()).as_ref(),
        ) {
            continue;
        }
        // Same person in a different organisation is a different login: the
        // token is scoped to the organisation it was minted for.
        let stored_org = stored
            .as_deref()
            .and_then(codex_auth::credential_from)
            .and_then(|c| c.chatgpt_account_id);
        if matches!((&org, &stored_org), (Some(a), Some(b)) if a != b) {
            continue;
        }
        matched.push(Target {
            id: account.id.clone(),
            vault: Some(vault),
            stored,
        });
    }
    single(matched)
}

/// Which account a rotated Claude credential belongs to. The blob carries no
/// identity, so the CLI's own account metadata answers instead.
fn attribute_claude(
    root: &Path,
    runtime: &ClaudeRuntime,
    accounts: &[StoredAccount],
) -> Result<Target, &'static str> {
    let live = runtime
        .read_live_oauth_account()
        .and_then(|account| accounts::claude_identity(&account.to_string()).email)
        .filter(|email| !email.trim().is_empty());
    let Some(live) = live else {
        return Err("the live login names no account");
    };
    let matched: Vec<Target> = managed(accounts, "claude")
        .filter(|account| {
            claude_account_email(root, account)
                .is_some_and(|email| email.trim().eq_ignore_ascii_case(live.trim()))
        })
        .map(|account| claude_target(root, runtime, account))
        .collect();
    single(matched)
}

/// Every account of an agent that owns a vault. The synthesized `:live` row
/// stands for the agent's own home and has nothing to store.
fn managed<'a>(
    accounts: &'a [StoredAccount],
    agent_id: &'a str,
) -> impl Iterator<Item = &'a StoredAccount> {
    accounts
        .iter()
        .filter(move |a| a.agent_id == agent_id && !codex_auth::is_live_row(a))
}

fn single(mut matched: Vec<Target>) -> Result<Target, &'static str> {
    match matched.len() {
        0 => Err("no account owns that login"),
        1 => Ok(matched.remove(0)),
        _ => Err("more than one account claims that login"),
    }
}

/// Where a Claude account's credential lives, and what it holds now: the
/// keychain first, because on macOS that is the copy a switch reads back.
fn claude_target(root: &Path, runtime: &ClaudeRuntime, account: &StoredAccount) -> Target {
    let vault = accounts::verify_vault_under(root, Path::new(&account.home_dir), &account.id).ok();
    let stored = runtime
        .read_managed_credentials(&account.id)
        .ok()
        .flatten()
        .or_else(|| {
            vault
                .as_deref()
                .and_then(|v| accounts::read_vault_file(v, claude_auth::CREDENTIALS_FILE).ok())
                .flatten()
        });
    Target {
        id: account.id.clone(),
        vault,
        stored,
    }
}

/// The email a Claude account answers to: what the switcher recorded, else the
/// identity stored alongside its credentials.
fn claude_account_email(root: &Path, account: &StoredAccount) -> Option<String> {
    if let Some(email) = account.email.as_deref().filter(|e| !e.trim().is_empty()) {
        return Some(email.to_string());
    }
    let vault =
        accounts::verify_vault_under(root, Path::new(&account.home_dir), &account.id).ok()?;
    let stored = accounts::read_vault_file(&vault, claude_auth::OAUTH_ACCOUNT_FILE).ok()??;
    accounts::claude_identity(&stored)
        .email
        .filter(|e| !e.trim().is_empty())
}

/// Whether the credentials currently live really belong to `account`.
///
/// Write-back at a switch assumes the live login is the outgoing account's.
/// That breaks if the user signed into a *different* account from a terminal
/// since the last switch: capturing those credentials under the outgoing
/// account's id would mean "switch to personal" later logs you into whatever
/// that terminal login was. The blob carries no identity, so compare Claude's
/// own account metadata instead, and only refuse when it clearly disagrees — an
/// unknown identity keeps the token-preserving behavior.
pub(crate) fn live_belongs_to(runtime: &ClaudeRuntime, account: &StoredAccount) -> bool {
    let Some(expected) = account.email.as_deref() else {
        return true;
    };
    let live = runtime
        .read_live_oauth_account()
        .and_then(|account| accounts::claude_identity(&account.to_string()).email);
    match live {
        Some(live) => live.eq_ignore_ascii_case(expected),
        None => true,
    }
}

/// Codex stamps every refresh with `last_refresh` — an ISO-8601 instant on this
/// machine, a raw epoch in some builds. Milliseconds since the epoch.
fn codex_freshness(auth_json: &str) -> Option<i64> {
    let value: serde_json::Value = serde_json::from_str(auth_json).ok()?;
    match value.get("last_refresh")? {
        serde_json::Value::Number(n) => n.as_f64().map(|n| n as i64),
        serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s.trim())
            .ok()
            .map(|dt| dt.timestamp_millis()),
        _ => None,
    }
}

/// Claude's credentials carry no refresh stamp, but every rotation pushes
/// `claudeAiOauth.expiresAt` (milliseconds since the epoch) further out, so a
/// later expiry is a newer token.
fn claude_freshness(blob: &str) -> Option<i64> {
    let value: serde_json::Value = serde_json::from_str(blob).ok()?;
    let expires = value
        .get("claudeAiOauth")
        .and_then(|o| o.get("expiresAt"))
        .or_else(|| value.get("expiresAt"))?;
    expires
        .as_i64()
        .or_else(|| expires.as_f64().map(|n| n as i64))
}

/// Replace a vault credential atomically at `0600`.
///
/// A symlink planted at the destination is refused rather than followed, so a
/// swapped-in link cannot redirect the write out of the vault. The temp file is
/// removed on any failure: a leftover `.tmp` beside a credential is a second
/// copy of a live token that nothing would ever clean up.
fn write_credential_atomically(vault: &Path, name: &str, contents: &str) -> Result<()> {
    let path = vault.join(name);
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            bail!(
                "{} is not a regular file owned by this vault",
                path.display()
            );
        }
    }
    let tmp = vault.join(format!(".{name}.tmp"));
    let write = || -> Result<()> {
        std::fs::write(&tmp, contents).with_context(|| format!("writing {}", tmp.display()))?;
        set_owner_only(&tmp)?;
        std::fs::rename(&tmp, &path).with_context(|| format!("replacing {}", path.display()))
    };
    match write() {
        Ok(()) => set_owner_only(&path),
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            Err(error)
        }
    }
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("restricting permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests;
