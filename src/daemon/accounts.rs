//! Agent accounts: several logins for the same agent, one active at a time.
//!
//! Each account owns a vault directory under `~/.warpforge/accounts/<agent>/`
//! holding whatever that agent needs to be that account — for Codex the whole
//! `CODEX_HOME`, for Claude just the credential blob. Two rules hold for both,
//! and both exist because the alternative silently destroys user data:
//!
//! * **Never write inside the agent's own home** (`~/.codex`, `~/.claude`).
//!   It is a read-only input; everything we create lives in our vault.
//! * **Every vault path is proven ours before use** — inside the accounts root,
//!   not a symlink, and carrying a marker file naming the account. A row in
//!   SQLite is not proof; a crafted `home_dir` would otherwise make the daemon
//!   read or overwrite arbitrary files.
//!
//! Credentials never leave this module: `AccountInfo` carries the label, email
//! and plan, never a token. See `plans/005-agent-account-hot-swap.md`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::daemon::store::StoredAccount;

/// Marker file written into every vault directory, containing the account id.
const OWNERSHIP_MARKER: &str = ".warpforge-account";

/// Root of all account vaults: `~/.warpforge/accounts`.
pub fn accounts_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
        .join("accounts")
}

/// Vault path for an account. Path only — does not create anything, so
/// read-only callers cannot materialize a vault as a side effect.
pub fn vault_path(agent_id: &str, slug: &str) -> PathBuf {
    accounts_root().join(agent_id).join(slug)
}

/// Turn a user-supplied label into a filesystem-safe slug. Anything that is not
/// alphanumeric, `-` or `_` collapses to `-`, so a label can never escape the
/// accounts root or collide with a marker file.
pub fn slugify(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut last_dash = false;
    for ch in label.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        "account".to_string()
    } else {
        slug
    }
}

/// Account id: stable, agent-scoped, derived from the slug.
pub fn account_id(agent_id: &str, slug: &str) -> String {
    format!("{agent_id}:{slug}")
}

/// Create a vault directory (0700) and stamp it with its ownership marker.
/// Fails if the path exists and belongs to another account.
pub fn create_vault(agent_id: &str, slug: &str, id: &str) -> Result<PathBuf> {
    create_vault_under(&accounts_root(), agent_id, slug, id)
}

/// `create_vault` against an explicit root, so the checks can be exercised
/// without writing into the real home directory.
fn create_vault_under(root: &Path, agent_id: &str, slug: &str, id: &str) -> Result<PathBuf> {
    let path = root.join(agent_id).join(slug);
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .with_context(|| format!("creating account vault {}", path.display()))?;
        set_owner_only(&path)?;
    }
    // Stamp any unmarked directory sitting at the one path this account owns.
    // Besides the fresh create, that covers a husk: removing an account deletes
    // the vault, but an agent still spawned against it recreates the directory
    // as it writes caches back, and an unmarked husk would otherwise reject
    // every future import at this path with no way out from the UI. Only a real
    // directory is stamped — `symlink_metadata` reports a symlink as such, so a
    // redirected path falls through to be rejected below, as does a marker
    // naming somebody else.
    let marker = path.join(OWNERSHIP_MARKER);
    if !marker.exists() && std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
        std::fs::write(&marker, format!("{id}\n")).context("writing account ownership marker")?;
    }
    verify_vault_under(root, &path, id)
}

/// Prove a stored vault path is ours before reading or writing through it:
/// it must resolve inside the accounts root, not be a symlink, and carry a
/// marker naming this account. Returns the canonical path on success.
pub fn verify_vault(path: &Path, id: &str) -> Result<PathBuf> {
    verify_vault_under(&accounts_root(), path, id)
}

/// `verify_vault` against an explicit root, so the checks can be exercised
/// without writing into the real home directory.
fn verify_vault_under(root: &Path, path: &Path, id: &str) -> Result<PathBuf> {
    let root = root.to_path_buf();
    if !path.exists() {
        bail!("account vault {} does not exist", path.display());
    }
    let meta = std::fs::symlink_metadata(path)
        .with_context(|| format!("reading account vault {}", path.display()))?;
    if meta.file_type().is_symlink() {
        bail!("account vault {} is a symlink", path.display());
    }
    if !meta.is_dir() {
        bail!("account vault {} is not a directory", path.display());
    }
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("resolving account vault {}", path.display()))?;
    // The root may not exist yet on a fresh install; canonicalize it when it
    // does so a symlinked home directory still compares equal.
    let canonical_root = std::fs::canonicalize(&root).unwrap_or(root);
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        bail!(
            "account vault {} is outside {}",
            canonical.display(),
            canonical_root.display()
        );
    }
    let marker = canonical.join(OWNERSHIP_MARKER);
    let marker_meta = std::fs::symlink_metadata(&marker)
        .with_context(|| format!("account vault {} has no ownership marker", path.display()))?;
    if marker_meta.file_type().is_symlink() || !marker_meta.is_file() {
        bail!(
            "ownership marker in {} is not a regular file",
            path.display()
        );
    }
    let owner = std::fs::read_to_string(&marker).context("reading account ownership marker")?;
    if owner.trim() != id {
        bail!(
            "account vault {} belongs to {}, not {id}",
            path.display(),
            owner.trim()
        );
    }
    Ok(canonical)
}

/// Read a file from a verified vault. Refuses symlinks and anything outside the
/// vault, so a swapped-in link cannot redirect the read.
pub fn read_vault_file(vault: &Path, name: &str) -> Result<Option<String>> {
    let path = vault.join(name);
    if !is_owned_regular_file(vault, &path) {
        return Ok(None);
    }
    Ok(Some(
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?,
    ))
}

/// Write a file into a verified vault with owner-only permissions, refusing to
/// follow a symlink planted at the destination.
pub fn write_vault_file(vault: &Path, name: &str, contents: &str) -> Result<()> {
    let path = vault.join(name);
    if path.exists() && !is_owned_regular_file(vault, &path) {
        bail!(
            "{} is not a regular file owned by this vault",
            path.display()
        );
    }
    std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
    set_owner_only(&path)?;
    Ok(())
}

/// Remove an account's vault. Verifies ownership first so a bad row can never
/// point the daemon at someone else's directory.
pub fn remove_vault(path: &Path, id: &str) -> Result<()> {
    let canonical = verify_vault(path, id)?;
    std::fs::remove_dir_all(&canonical)
        .with_context(|| format!("removing account vault {}", canonical.display()))
}

fn is_owned_regular_file(vault: &Path, path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return false;
    }
    match (std::fs::canonicalize(vault), std::fs::canonicalize(path)) {
        (Ok(vault), Ok(file)) => file.starts_with(&vault) && file != vault,
        _ => false,
    }
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path)?;
    let mode = if meta.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("restricting permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<()> {
    Ok(())
}

/// Display identity of an account, read out of its vault. Never includes a
/// token: only what the switcher shows.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AccountIdentity {
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// Decode the claims of a JWT without verifying its signature. The token comes
/// from a local file we already trust; we only want the account label out of
/// it. Returns `None` for anything that is not a three-part JWT.
pub fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Identity of a Codex account from its `auth.json` contents: the email and
/// plan carried in the `id_token` claims.
pub fn codex_identity(auth_json: &str) -> AccountIdentity {
    let Ok(auth) = serde_json::from_str::<serde_json::Value>(auth_json) else {
        return AccountIdentity::default();
    };
    let Some(claims) = auth
        .get("tokens")
        .and_then(|t| t.get("id_token"))
        .and_then(|t| t.as_str())
        .and_then(jwt_claims)
    else {
        return AccountIdentity::default();
    };
    AccountIdentity {
        email: claims
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        plan: claims
            .get("https://api.openai.com/auth")
            .and_then(|v| v.get("chatgpt_plan_type"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

/// Identity of a Claude account from a `.claude.json` (or our stored
/// `oauth-account.json`) blob.
pub fn claude_identity(config_json: &str) -> AccountIdentity {
    let Ok(config) = serde_json::from_str::<serde_json::Value>(config_json) else {
        return AccountIdentity::default();
    };
    let account = config.get("oauthAccount").unwrap_or(&config);
    AccountIdentity {
        email: account
            .get("emailAddress")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        plan: account
            .get("seatTier")
            .or_else(|| account.get("billingType"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

/// Entries that make an account *be* that account, so each vault keeps its own
/// real file: the credentials, and the model list (which depends on the plan).
const CODEX_PRIVATE_ENTRIES: &[&str] = &["auth.json", "models_cache.json"];

/// Per-runtime state that must stay real inside the vault.
///
/// Codex opens SQLite databases directly under `CODEX_HOME`. Linking those at
/// the shared home puts one database behind two paths — with the `-wal`/`-shm`
/// pair split across them — and Codex refuses to start at all:
///
/// ```text
/// Error: failed to initialize sqlite state runtime under <CODEX_HOME>
/// ```
///
/// Lock directories, the IPC socket dir and scratch space are per-run for the
/// same reason. Logs and memories are here because they are noise, not state.
const CODEX_LOCAL_ENTRIES: &[&str] = &[
    "log",
    "memories",
    "tmp",
    ".tmp",
    "ipc",
    "sqlite",
    "thread-writer-locks",
    "mcp-oauth-locks",
    "process_manager",
];

/// Whether an entry stays local to the vault. Database names carry a serial
/// (`state_5.sqlite`, `logs_2.sqlite-wal`) that changes with Codex versions, so
/// they are matched by extension rather than listed.
fn is_codex_local_entry(name: &str) -> bool {
    CODEX_LOCAL_ENTRIES.contains(&name) || name.contains(".sqlite")
}

/// Give a Codex account home everything that is not account-specific by
/// symlinking it out of the shared `~/.codex`.
///
/// Without this a vault is an empty Codex home: no `config.toml`, no MCP
/// servers, and — most visibly — no `sessions/`, so every existing conversation
/// disappears the moment an account becomes active. Only links inside the vault
/// are created; the shared home is never written to, except to adopt sessions a
/// half-configured vault already collected (see `link_shared_entry`).
///
/// Idempotent: re-run on every activation, since the shared home grows entries
/// over time.
pub fn materialize_codex_home(shared: &Path, vault: &Path) -> Result<()> {
    let entries = std::fs::read_dir(shared)
        .with_context(|| format!("reading {}", shared.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name());
    for name in entries {
        let Some(name) = name.to_str() else { continue };
        if CODEX_PRIVATE_ENTRIES.contains(&name) || is_codex_local_entry(name) {
            continue;
        }
        link_shared_entry(shared, vault, name)?;
    }
    unlink_wrongly_shared(vault)?;
    Ok(())
}

/// Drop links a previous build created for entries that must be the vault's
/// own: a shared `auth.json` would silently merge two logins into one, and a
/// shared database stops Codex from starting. Only links are removed — a real
/// file is the vault's own state and is left alone.
fn unlink_wrongly_shared(vault: &Path) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(vault) else {
        return Ok(());
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !CODEX_PRIVATE_ENTRIES.contains(&name) && !is_codex_local_entry(name) {
            continue;
        }
        let path = entry.path();
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            std::fs::remove_file(&path)
                .with_context(|| format!("removing shared {name} from vault"))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn link_shared_entry(shared: &Path, vault: &Path, name: &str) -> Result<()> {
    let target = shared.join(name);
    let link = vault.join(name);
    match std::fs::symlink_metadata(&link) {
        // Already ours and pointing at the right place.
        Ok(meta) if meta.file_type().is_symlink() => {
            if std::fs::read_link(&link).is_ok_and(|current| current == target) {
                return Ok(());
            }
            std::fs::remove_file(&link)?;
        }
        // A real directory here means the vault ran as an unmaterialized home
        // and collected state of its own. Move that state into the shared home
        // rather than stranding it, then link — otherwise those sessions are
        // invisible from everywhere else forever.
        Ok(meta) if meta.is_dir() => {
            if !adopt_directory(&link, &target)? {
                return Ok(());
            }
        }
        // A real file we cannot merge: leave it alone rather than lose it.
        Ok(_) => return Ok(()),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(&target, &link)
        .with_context(|| format!("linking {} to {}", link.display(), target.display()))
}

#[cfg(not(unix))]
fn link_shared_entry(_shared: &Path, _vault: &Path, _name: &str) -> Result<()> {
    Ok(())
}

/// Move a vault directory's contents into the shared home and remove it.
/// Returns false when something could not be moved, leaving the directory (and
/// the caller's link) alone — never silently discards a file.
fn adopt_directory(local: &Path, shared: &Path) -> Result<bool> {
    std::fs::create_dir_all(shared)?;
    let mut moved_everything = true;
    for entry in std::fs::read_dir(local)? {
        let entry = entry?;
        let destination = shared.join(entry.file_name());
        // Directories that exist on both sides are merged, not skipped: session
        // history is partitioned by date, so the common case is both homes
        // holding a `2026/` and only the leaf files differing.
        if entry.file_type()?.is_dir() {
            if !adopt_directory(&entry.path(), &destination)? {
                moved_everything = false;
            }
        } else if destination.exists() {
            // Same file name on both sides: keep the shared copy, keep ours too.
            moved_everything = false;
        } else if std::fs::rename(entry.path(), &destination).is_err() {
            moved_everything = false;
        }
    }
    if moved_everything {
        std::fs::remove_dir_all(local)?;
    }
    Ok(moved_everything)
}

/// Home directory the agent itself uses — the read-only source an import copies
/// from. Never written to.
pub fn agent_home(agent_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match agent_id {
        "codex" => Some(home.join(".codex")),
        "claude" => Some(home.join(".claude")),
        _ => None,
    }
}

/// Copy the agent's currently-authenticated login into a vault and return the
/// identity read from it.
///
/// Codex keeps its whole session in `auth.json`, so the import is a file copy.
/// Claude's credentials come from wherever the CLI actually keeps them (login
/// keychain first, file second) via `runtime`, and are stored both in the vault
/// and in our own keychain service.
pub fn import_agent_login(
    agent_id: &str,
    vault: &Path,
    account_id: &str,
    runtime: &super::claude_auth::ClaudeRuntime,
) -> Result<AccountIdentity> {
    let Some(home) = agent_home(agent_id) else {
        bail!("agent '{agent_id}' has no known account storage");
    };
    match agent_id {
        "codex" => {
            let auth = std::fs::read_to_string(home.join("auth.json")).with_context(|| {
                format!(
                    "no Codex credentials in {} — run `codex login` first",
                    home.display()
                )
            })?;
            write_vault_file(vault, "auth.json", &auth)?;
            // The model list depends on the account's plan, so it must not be
            // shared between accounts.
            if let Ok(models) = std::fs::read_to_string(home.join("models_cache.json")) {
                write_vault_file(vault, "models_cache.json", &models)?;
            }
            materialize_codex_home(&home, vault)?;
            Ok(codex_identity(&auth))
        }
        "claude" => {
            let Some(credentials) = runtime.read_live_credentials()? else {
                bail!("no Claude login found — run `claude` and sign in first");
            };
            if !super::claude_auth::credentials_are_usable(&credentials) {
                bail!("the current Claude login has no usable token — sign in again first");
            }
            // Keychain is the durable copy on macOS; the vault file is the
            // fallback for platforms without one.
            runtime.write_managed_credentials(account_id, &credentials)?;
            write_vault_file(vault, super::claude_auth::CREDENTIALS_FILE, &credentials)?;
            // Store only the `oauthAccount` block. The rest of `.claude.json`
            // is that machine's whole project history — tens of thousands of
            // lines that belong to no account in particular.
            let Some(oauth_account) = runtime.read_live_oauth_account() else {
                bail!("no Claude login found — run `claude` and sign in first");
            };
            write_vault_file(
                vault,
                super::claude_auth::OAUTH_ACCOUNT_FILE,
                &serde_json::to_string(&oauth_account)?,
            )?;
            Ok(claude_identity(&oauth_account.to_string()))
        }
        _ => bail!("agent '{agent_id}' does not support accounts"),
    }
}

/// Claude keeps its account block in `~/.claude.json` by default, and in
/// `<config dir>/.claude.json` when `CLAUDE_CONFIG_DIR` is set. Try both.
fn claude_config_json(home: &Path) -> Result<String> {
    let colocated = home.join(".claude.json");
    if colocated.is_file() {
        return Ok(std::fs::read_to_string(&colocated)?);
    }
    let sibling = home
        .parent()
        .map(|p| p.join(".claude.json"))
        .unwrap_or_else(|| PathBuf::from(".claude.json"));
    Ok(std::fs::read_to_string(&sibling)?)
}

/// Make `target` the account the Claude CLI uses, capturing whatever the
/// outgoing account's credentials became first.
///
/// The order matters and is the whole point of the function. A live CLI rotates
/// its refresh token; the vault copy of the *outgoing* account is stale from
/// that moment. Overwriting the live credentials without reading them back
/// discards the only valid token that account has, and it is silently logged
/// out. So: read live → store under the outgoing account → write the target.
///
/// An unusable read-back (the empty blob a CLI writes when it loses a refresh
/// race) is dropped rather than persisted, which would log the account out for
/// good.
pub fn activate_claude_account(
    runtime: &super::claude_auth::ClaudeRuntime,
    outgoing: Option<&StoredAccount>,
    target: &StoredAccount,
) -> Result<()> {
    activate_claude_account_under(&accounts_root(), runtime, outgoing, target)
}

/// Whether the credentials currently live really belong to `account`.
///
/// Write-back assumes the live login is the outgoing account's. That breaks if
/// the user signed into a *different* account from a terminal since the last
/// switch: capturing those credentials under the outgoing account's id would
/// mean "switch to personal" later logs you into whatever that terminal login
/// was. The credentials blob carries no identity, so compare Claude's own
/// account metadata instead, and only skip when it clearly disagrees — an
/// unknown identity keeps the token-preserving behavior.
fn live_belongs_to(runtime: &super::claude_auth::ClaudeRuntime, account: &StoredAccount) -> bool {
    let Some(expected) = account.email.as_deref() else {
        return true;
    };
    let live_email = runtime
        .read_live_oauth_account()
        .and_then(|account| claude_identity(&account.to_string()).email);
    match live_email {
        Some(live) => live.eq_ignore_ascii_case(expected),
        None => true,
    }
}

/// The `oauthAccount` block out of a stored identity file.
///
/// Accounts imported before this file held only the block store the whole
/// `.claude.json` instead. Writing that back verbatim would nest an entire
/// config (including every project's history) under `oauthAccount`, so unwrap
/// it when present rather than requiring a re-import.
fn stored_oauth_account(stored: serde_json::Value) -> serde_json::Value {
    stored
        .get("oauthAccount")
        .cloned()
        .unwrap_or_else(|| stored.clone())
}

fn activate_claude_account_under(
    root: &Path,
    runtime: &super::claude_auth::ClaudeRuntime,
    outgoing: Option<&StoredAccount>,
    target: &StoredAccount,
) -> Result<()> {
    if let Some(outgoing) = outgoing {
        if outgoing.id != target.id && live_belongs_to(runtime, outgoing) {
            if let Some(live) = runtime.read_live_credentials()? {
                if super::claude_auth::credentials_are_usable(&live) {
                    runtime.write_managed_credentials(&outgoing.id, &live)?;
                    if let Ok(vault) =
                        verify_vault_under(root, Path::new(&outgoing.home_dir), &outgoing.id)
                    {
                        write_vault_file(&vault, super::claude_auth::CREDENTIALS_FILE, &live)?;
                    }
                }
            }
        }
    }

    let vault = verify_vault_under(root, Path::new(&target.home_dir), &target.id)?;
    // Keychain first: on macOS it is what the CLI actually reads, so it is the
    // fresher copy whenever a previous switch wrote both.
    let credentials = match runtime.read_managed_credentials(&target.id)? {
        Some(credentials) => credentials,
        None => {
            read_vault_file(&vault, super::claude_auth::CREDENTIALS_FILE)?.ok_or_else(|| {
                anyhow::anyhow!(
                    "no stored credentials for '{}' — re-import that account",
                    target.label
                )
            })?
        }
    };
    if !super::claude_auth::credentials_are_usable(&credentials) {
        bail!(
            "stored credentials for '{}' have no usable token — re-import that account",
            target.label
        );
    }
    // Identity before credentials. The CLI cross-checks the two: a token for one
    // account against a config naming another fails as "OAuth session expired",
    // and across organizations as "not a member of this organization".
    if let Some(oauth_account) = read_vault_file(&vault, super::claude_auth::OAUTH_ACCOUNT_FILE)?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(stored_oauth_account)
    {
        runtime.write_live_oauth_account(&oauth_account)?;
    }
    runtime.write_live_credentials(&credentials)
}

/// Environment changes an agent process needs: variables to set, and variables
/// that must be *removed* from what the daemon would otherwise pass down.
///
/// Removal is not a detail. An `ANTHROPIC_API_KEY` inherited by the daemon makes
/// the Claude CLI authenticate as something else entirely, so every account
/// switch appears to do nothing — with no error anywhere to explain it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentEnv {
    pub set: std::collections::HashMap<String, String>,
    pub remove: Vec<String>,
}

impl AgentEnv {
    pub fn is_empty(&self) -> bool {
        self.set.is_empty() && self.remove.is_empty()
    }
}

/// Pick the account a spawn runs under: an explicit per-task selection when
/// there is one, otherwise the agent's active account.
///
/// A vault that no longer verifies — deleted, or replaced by a symlink — is
/// dropped rather than handed to a child process. The agent then falls back to
/// its own home, which is wrong-but-working; pointing it at a directory we
/// cannot vouch for is neither.
pub fn select_for_spawn<'a>(
    accounts: &'a [StoredAccount],
    agent_id: &str,
    account_id: Option<&str>,
) -> Option<&'a StoredAccount> {
    select_for_spawn_under(&accounts_root(), accounts, agent_id, account_id)
}

/// `select_for_spawn` against an explicit root, so the vault check can be
/// exercised without writing into the real home directory.
fn select_for_spawn_under<'a>(
    root: &Path,
    accounts: &'a [StoredAccount],
    agent_id: &str,
    account_id: Option<&str>,
) -> Option<&'a StoredAccount> {
    match account_id {
        Some(id) => accounts.iter().find(|a| a.id == id),
        None => accounts.iter().find(|a| a.agent_id == agent_id && a.active),
    }
    .filter(|account| verify_vault_under(root, Path::new(&account.home_dir), &account.id).is_ok())
}

/// Environment for an agent, given the selected account (if any).
///
/// Codex selects its account by `CODEX_HOME`. Claude does not — its account is
/// swapped in place — so it contributes only the strip list.
pub fn env_for(agent_id: &str, account: Option<&StoredAccount>) -> AgentEnv {
    let mut env = AgentEnv::default();
    match agent_id {
        "codex" => {
            if let Some(account) = account {
                env.set
                    .insert("CODEX_HOME".to_string(), account.home_dir.clone());
            }
        }
        "claude" => {
            env.remove = super::claude_auth::CONFLICTING_AUTH_ENV
                .iter()
                .map(|v| v.to_string())
                .collect();
            if std::env::var("ANTHROPIC_CUSTOM_HEADERS")
                .is_ok_and(|value| super::claude_auth::headers_look_like_auth(&value))
            {
                env.remove.push("ANTHROPIC_CUSTOM_HEADERS".to_string());
            }
        }
        _ => {}
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, home: &Path) -> StoredAccount {
        StoredAccount {
            id: id.to_string(),
            agent_id: "codex".to_string(),
            label: "personal".to_string(),
            email: None,
            plan: None,
            home_dir: home.to_string_lossy().into_owned(),
            created_at: 0,
            active: true,
        }
    }

    #[test]
    fn slugify_keeps_paths_safe() {
        assert_eq!(slugify("Work Account"), "work-account");
        assert_eq!(slugify("../../etc"), "etc");
        assert_eq!(slugify("  "), "account");
        assert_eq!(slugify("a/b"), "a-b");
    }

    #[test]
    fn verify_rejects_vault_outside_root() {
        let dir = tempfile::tempdir().unwrap();
        let stray = dir.path().join("stray");
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join(OWNERSHIP_MARKER), "codex:personal\n").unwrap();
        let err = verify_vault(&stray, "codex:personal").unwrap_err();
        assert!(err.to_string().contains("outside"), "{err}");
    }

    #[test]
    fn verify_rejects_missing_and_foreign_marker() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("codex").join("personal");
        std::fs::create_dir_all(&vault).unwrap();
        let err = verify_vault_under(root.path(), &vault, "codex:personal").unwrap_err();
        assert!(err.to_string().contains("ownership marker"), "{err}");

        std::fs::write(vault.join(OWNERSHIP_MARKER), "codex:work\n").unwrap();
        let err = verify_vault_under(root.path(), &vault, "codex:personal").unwrap_err();
        assert!(err.to_string().contains("belongs to"), "{err}");

        std::fs::write(vault.join(OWNERSHIP_MARKER), "codex:personal\n").unwrap();
        assert!(verify_vault_under(root.path(), &vault, "codex:personal").is_ok());
    }

    #[test]
    fn create_reclaims_an_unmarked_husk_but_not_a_foreign_vault() {
        let root = tempfile::tempdir().unwrap();

        let vault = create_vault_under(root.path(), "codex", "personal", "codex:personal").unwrap();
        assert!(vault.join(OWNERSHIP_MARKER).is_file());

        // What a removed-then-resurrected vault looks like: the agent recreated
        // the directory and its caches, but nothing recreated the marker.
        std::fs::remove_file(vault.join(OWNERSHIP_MARKER)).unwrap();
        std::fs::write(vault.join("models_cache.json"), "{}").unwrap();
        let reclaimed =
            create_vault_under(root.path(), "codex", "personal", "codex:personal").unwrap();
        assert_eq!(reclaimed, vault.canonicalize().unwrap());
        assert!(vault.join("models_cache.json").exists(), "caches kept");

        // A marker that names another account is never overwritten.
        std::fs::write(vault.join(OWNERSHIP_MARKER), "codex:work\n").unwrap();
        let err =
            create_vault_under(root.path(), "codex", "personal", "codex:personal").unwrap_err();
        assert!(err.to_string().contains("belongs to"), "{err}");
    }

    #[test]
    fn verify_rejects_symlinked_vault_and_marker() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let real = outside.path().join("elsewhere");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join(OWNERSHIP_MARKER), "codex:personal\n").unwrap();

        // A vault path that is itself a link out of the root: rejected before
        // canonicalization can make it look legitimate.
        let linked = root.path().join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        let err = verify_vault_under(root.path(), &linked, "codex:personal").unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");

        // A real vault whose marker is a link to a file we don't control.
        let vault = root.path().join("codex").join("personal");
        std::fs::create_dir_all(&vault).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(real.join(OWNERSHIP_MARKER), vault.join(OWNERSHIP_MARKER))
            .unwrap();
        let err = verify_vault_under(root.path(), &vault, "codex:personal").unwrap_err();
        assert!(err.to_string().contains("not a regular file"), "{err}");
    }

    #[test]
    fn vault_file_io_refuses_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let outside = dir.path().join("outside.json");
        std::fs::write(&outside, "{\"secret\":true}").unwrap();

        write_vault_file(&vault, "auth.json", "{}").unwrap();
        assert_eq!(
            read_vault_file(&vault, "auth.json").unwrap().as_deref(),
            Some("{}")
        );

        std::fs::remove_file(vault.join("auth.json")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, vault.join("auth.json")).unwrap();
        // A symlink planted at the destination must neither be read through…
        assert_eq!(read_vault_file(&vault, "auth.json").unwrap(), None);
        // …nor written through, which would clobber the link target.
        assert!(write_vault_file(&vault, "auth.json", "{}").is_err());
    }

    #[test]
    fn codex_identity_reads_id_token_claims() {
        // Payload: {"email":"dev@example.com",
        //           "https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}
        let payload = "eyJlbWFpbCI6ImRldkBleGFtcGxlLmNvbSIsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X3BsYW5fdHlwZSI6InBybyJ9fQ";
        let auth = format!("{{\"tokens\":{{\"id_token\":\"header.{payload}.sig\"}}}}");
        let identity = codex_identity(&auth);
        assert_eq!(identity.email.as_deref(), Some("dev@example.com"));
        assert_eq!(identity.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn codex_identity_tolerates_garbage() {
        assert_eq!(codex_identity("not json"), AccountIdentity::default());
        assert_eq!(codex_identity("{}"), AccountIdentity::default());
        assert_eq!(
            codex_identity("{\"tokens\":{\"id_token\":\"nope\"}}"),
            AccountIdentity::default()
        );
    }

    /// Build two Claude accounts inside a temp accounts-root, with a stubbed
    /// keychain, so activation can be exercised end to end.
    #[cfg(unix)]
    fn claude_fixture(
        root: &Path,
    ) -> (
        super::super::claude_auth::ClaudeRuntime,
        StoredAccount,
        StoredAccount,
    ) {
        let runtime = super::super::claude_auth::tests::stub_runtime(root);
        let make = |slug: &str| {
            let id = account_id("claude", slug);
            let vault = root.join("claude").join(slug);
            std::fs::create_dir_all(&vault).unwrap();
            std::fs::write(vault.join(OWNERSHIP_MARKER), format!("{id}\n")).unwrap();
            StoredAccount {
                id,
                agent_id: "claude".to_string(),
                label: slug.to_string(),
                email: None,
                plan: None,
                home_dir: vault.to_string_lossy().into_owned(),
                created_at: 0,
                active: false,
            }
        };
        (runtime, make("personal"), make("work"))
    }

    #[cfg(unix)]
    #[test]
    fn activation_captures_the_outgoing_account_before_overwriting_it() {
        let root = tempfile::tempdir().unwrap();
        let (runtime, mut personal, work) = claude_fixture(root.path());
        personal.active = true;

        // Both accounts were imported at some point.
        runtime
            .write_managed_credentials(&personal.id, r#"{"accessToken":"personal-v1"}"#)
            .unwrap();
        runtime
            .write_managed_credentials(&work.id, r#"{"accessToken":"work-v1"}"#)
            .unwrap();
        runtime
            .write_live_credentials(r#"{"accessToken":"personal-v1"}"#)
            .unwrap();

        // The live CLI refreshes and rotates its token: the stored copy for
        // `personal` is now stale, and it is the only thing that can log that
        // account back in.
        runtime
            .write_live_credentials(r#"{"accessToken":"personal-v2"}"#)
            .unwrap();

        activate_claude_account_under(root.path(), &runtime, Some(&personal), &work).unwrap();

        // The rotated token was captured, not thrown away…
        assert_eq!(
            runtime.read_managed_credentials(&personal.id).unwrap(),
            Some(r#"{"accessToken":"personal-v2"}"#.to_string())
        );
        // …and the CLI now runs as the target account.
        assert_eq!(
            runtime.read_live_credentials().unwrap(),
            Some(r#"{"accessToken":"work-v1"}"#.to_string())
        );

        // Switching back restores the captured token, not the stale one.
        activate_claude_account_under(root.path(), &runtime, Some(&work), &personal).unwrap();
        assert_eq!(
            runtime.read_live_credentials().unwrap(),
            Some(r#"{"accessToken":"personal-v2"}"#.to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn activation_moves_identity_and_credentials_together() {
        let root = tempfile::tempdir().unwrap();
        let (runtime, personal, work) = claude_fixture(root.path());
        for (account, email) in [(&personal, "me@example.com"), (&work, "me@corp.com")] {
            runtime
                .write_managed_credentials(&account.id, r#"{"accessToken":"t"}"#)
                .unwrap();
            write_vault_file(
                Path::new(&account.home_dir),
                super::super::claude_auth::OAUTH_ACCOUNT_FILE,
                &format!("{{\"emailAddress\":\"{email}\"}}"),
            )
            .unwrap();
        }
        std::fs::create_dir_all(&runtime.config_dir).unwrap();
        std::fs::write(
            &runtime.config_path,
            r#"{"oauthAccount":{"emailAddress":"me@corp.com"}}"#,
        )
        .unwrap();

        activate_claude_account_under(root.path(), &runtime, Some(&work), &personal).unwrap();

        // Leaving the config on the previous account is what produced
        // "OAuth session expired and could not be refreshed" in the field: the
        // CLI had one account's token and another account's identity.
        assert_eq!(
            runtime.read_live_oauth_account().unwrap()["emailAddress"],
            "me@example.com"
        );
    }

    #[test]
    fn a_whole_claude_json_stored_by_an_older_build_is_unwrapped() {
        let stored = serde_json::json!({
            "oauthAccount": { "emailAddress": "me@example.com" },
            "projects": { "/a": { "history": [1, 2] } },
        });
        // Written back verbatim, this would bury the entire config — history and
        // all — inside `oauthAccount`.
        assert_eq!(
            stored_oauth_account(stored)["emailAddress"],
            "me@example.com"
        );
        // A bare block (what current imports store) passes through untouched.
        let bare = serde_json::json!({ "emailAddress": "me@example.com" });
        assert_eq!(stored_oauth_account(bare.clone()), bare);
    }

    #[cfg(unix)]
    #[test]
    fn write_back_is_skipped_when_the_live_login_is_a_different_account() {
        let root = tempfile::tempdir().unwrap();
        let (runtime, mut personal, work) = claude_fixture(root.path());
        personal.email = Some("personal@example.com".into());
        personal.active = true;
        runtime
            .write_managed_credentials(&personal.id, r#"{"accessToken":"personal-v1"}"#)
            .unwrap();
        runtime
            .write_managed_credentials(&work.id, r#"{"accessToken":"work-v1"}"#)
            .unwrap();

        // The user signed in as somebody else from a terminal since the last
        // switch, so the live credentials are not `personal`'s.
        std::fs::create_dir_all(&runtime.config_dir).unwrap();
        std::fs::write(
            runtime.config_dir.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"stranger@example.com"}}"#,
        )
        .unwrap();
        runtime
            .write_live_credentials(r#"{"accessToken":"stranger-token"}"#)
            .unwrap();

        activate_claude_account_under(root.path(), &runtime, Some(&personal), &work).unwrap();

        // `personal` keeps its own credentials instead of adopting the
        // stranger's session under its label.
        assert_eq!(
            runtime.read_managed_credentials(&personal.id).unwrap(),
            Some(r#"{"accessToken":"personal-v1"}"#.to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn activation_discards_an_empty_read_back_and_refuses_a_broken_target() {
        let root = tempfile::tempdir().unwrap();
        let (runtime, personal, work) = claude_fixture(root.path());
        runtime
            .write_managed_credentials(&personal.id, r#"{"accessToken":"personal-v1"}"#)
            .unwrap();
        runtime
            .write_managed_credentials(&work.id, r#"{"accessToken":"work-v1"}"#)
            .unwrap();

        // A live CLI that lost a refresh race wrote an empty blob. Persisting it
        // would log `personal` out permanently.
        runtime
            .write_live_credentials(r#"{"accessToken":""}"#)
            .unwrap();
        activate_claude_account_under(root.path(), &runtime, Some(&personal), &work).unwrap();
        assert_eq!(
            runtime.read_managed_credentials(&personal.id).unwrap(),
            Some(r#"{"accessToken":"personal-v1"}"#.to_string()),
            "an unusable read-back must not overwrite a good stored token"
        );

        // A target with nothing stored fails loudly instead of leaving the CLI
        // authenticated as the previous account while the UI claims otherwise.
        let (runtime2, _, unknown) = claude_fixture(root.path());
        runtime2.delete_managed_credentials(&unknown.id).unwrap();
        std::fs::remove_file(
            Path::new(&unknown.home_dir).join(super::super::claude_auth::CREDENTIALS_FILE),
        )
        .ok();
        let err =
            activate_claude_account_under(root.path(), &runtime2, None, &unknown).unwrap_err();
        assert!(err.to_string().contains("re-import"), "{err}");
    }

    #[test]
    fn claude_identity_reads_oauth_account() {
        let config = r#"{"oauthAccount":{"emailAddress":"dev@example.com","seatTier":"max"}}"#;
        let identity = claude_identity(config);
        assert_eq!(identity.email.as_deref(), Some("dev@example.com"));
        assert_eq!(identity.plan.as_deref(), Some("max"));
    }

    #[cfg(unix)]
    #[test]
    fn materialize_links_shared_state_and_keeps_credentials_private() {
        let shared = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(shared.path().join("config.toml"), "model = 'gpt'").unwrap();
        std::fs::create_dir_all(shared.path().join("sessions/2026")).unwrap();
        std::fs::write(shared.path().join("sessions/2026/old.jsonl"), "old").unwrap();
        std::fs::write(shared.path().join("auth.json"), "{\"shared\":true}").unwrap();
        std::fs::write(vault.path().join("auth.json"), "{\"mine\":true}").unwrap();

        materialize_codex_home(shared.path(), vault.path()).unwrap();

        // Shared config and history are visible from the vault…
        assert_eq!(
            std::fs::read_to_string(vault.path().join("config.toml")).unwrap(),
            "model = 'gpt'"
        );
        assert_eq!(
            std::fs::read_to_string(vault.path().join("sessions/2026/old.jsonl")).unwrap(),
            "old"
        );
        // …while the credentials stay this account's own file.
        assert!(!std::fs::symlink_metadata(vault.path().join("auth.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(vault.path().join("auth.json")).unwrap(),
            "{\"mine\":true}"
        );

        // Re-running changes nothing (it runs before every spawn).
        materialize_codex_home(shared.path(), vault.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(vault.path().join("config.toml")).unwrap(),
            "model = 'gpt'"
        );
    }

    /// Codex refuses to start when its databases live behind a symlink:
    /// "failed to initialize sqlite state runtime under <CODEX_HOME>". Every
    /// account therefore gets its own, and a link a previous build created is
    /// cleaned up rather than left to break the next spawn.
    #[cfg(unix)]
    #[test]
    fn materialize_keeps_databases_and_locks_out_of_the_link_farm() {
        let shared = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(shared.path().join("config.toml"), "model = 'gpt'").unwrap();
        for name in ["state_5.sqlite", "state_5.sqlite-wal", "logs_2.sqlite-shm"] {
            std::fs::write(shared.path().join(name), "db").unwrap();
        }
        for name in ["sqlite", "ipc", "thread-writer-locks"] {
            std::fs::create_dir_all(shared.path().join(name)).unwrap();
        }
        // What the previous build left behind: the databases linked out.
        std::os::unix::fs::symlink(
            shared.path().join("state_5.sqlite"),
            vault.path().join("state_5.sqlite"),
        )
        .unwrap();

        materialize_codex_home(shared.path(), vault.path()).unwrap();

        assert!(vault.path().join("config.toml").exists(), "config shared");
        for name in [
            "state_5.sqlite",
            "state_5.sqlite-wal",
            "logs_2.sqlite-shm",
            "sqlite",
            "ipc",
            "thread-writer-locks",
        ] {
            assert!(
                !vault.path().join(name).exists(),
                "{name} must not be linked into the vault"
            );
        }
        assert!(
            std::fs::symlink_metadata(vault.path().join("state_5.sqlite")).is_err(),
            "a database linked by an older build must be unlinked"
        );

        // A database the vault created for itself is its own state: kept.
        std::fs::write(vault.path().join("state_5.sqlite"), "mine").unwrap();
        materialize_codex_home(shared.path(), vault.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(vault.path().join("state_5.sqlite")).unwrap(),
            "mine"
        );
    }

    #[cfg(unix)]
    #[test]
    fn materialize_adopts_sessions_a_half_configured_vault_collected() {
        let shared = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(shared.path().join("sessions/2026/08/04")).unwrap();
        std::fs::write(shared.path().join("sessions/2026/08/04/a.jsonl"), "a").unwrap();
        // Sessions recorded while the vault was an empty Codex home.
        std::fs::create_dir_all(vault.path().join("sessions/2026/08/05")).unwrap();
        std::fs::write(vault.path().join("sessions/2026/08/05/b.jsonl"), "b").unwrap();

        materialize_codex_home(shared.path(), vault.path()).unwrap();

        // Both histories end up in one place, reachable through the vault.
        assert_eq!(
            std::fs::read_to_string(shared.path().join("sessions/2026/08/05/b.jsonl")).unwrap(),
            "b"
        );
        assert_eq!(
            std::fs::read_to_string(vault.path().join("sessions/2026/08/04/a.jsonl")).unwrap(),
            "a"
        );
        assert!(std::fs::symlink_metadata(vault.path().join("sessions"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn materialize_never_discards_a_colliding_file() {
        let shared = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(shared.path().join("sessions")).unwrap();
        std::fs::write(shared.path().join("sessions/same.jsonl"), "shared").unwrap();
        std::fs::create_dir_all(vault.path().join("sessions")).unwrap();
        std::fs::write(vault.path().join("sessions/same.jsonl"), "local").unwrap();

        materialize_codex_home(shared.path(), vault.path()).unwrap();

        // Neither copy is overwritten, and the directory stays real rather than
        // becoming a link that hides the local file.
        assert_eq!(
            std::fs::read_to_string(shared.path().join("sessions/same.jsonl")).unwrap(),
            "shared"
        );
        assert_eq!(
            std::fs::read_to_string(vault.path().join("sessions/same.jsonl")).unwrap(),
            "local"
        );
    }

    #[test]
    fn env_is_agent_specific() {
        let dir = tempfile::tempdir().unwrap();
        let codex = account("codex:personal", dir.path());
        let env = env_for("codex", Some(&codex));
        assert_eq!(
            env.set.get("CODEX_HOME").map(String::as_str),
            Some(dir.path().to_string_lossy().as_ref())
        );
        assert!(env.remove.is_empty());

        // Codex without a selected account contributes nothing at all.
        assert!(env_for("codex", None).is_empty());

        // Claude never sets a home — it is swapped in place — but always strips
        // the auth env that would override the selected account.
        let claude = StoredAccount {
            agent_id: "claude".to_string(),
            ..account("claude:personal", dir.path())
        };
        let env = env_for("claude", Some(&claude));
        assert!(env.set.is_empty());
        assert!(env.remove.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert!(env.remove.contains(&"CLAUDE_CODE_OAUTH_TOKEN".to_string()));
    }

    #[test]
    fn spawn_prefers_the_explicit_account_over_the_active_one() {
        let root = tempfile::tempdir().unwrap();
        let personal =
            create_vault_under(root.path(), "codex", "personal", "codex:personal").unwrap();
        let work = create_vault_under(root.path(), "codex", "work", "codex:work").unwrap();
        let claude_vault =
            create_vault_under(root.path(), "claude", "personal", "claude:personal").unwrap();

        let accounts = vec![
            StoredAccount {
                active: true,
                ..account("codex:personal", &personal)
            },
            StoredAccount {
                active: false,
                ..account("codex:work", &work)
            },
            StoredAccount {
                agent_id: "claude".to_string(),
                active: true,
                ..account("claude:personal", &claude_vault)
            },
        ];

        // A task pinned to an account uses it even though another is active.
        let picked = select_for_spawn_under(root.path(), &accounts, "codex", Some("codex:work"));
        assert_eq!(picked.map(|a| a.id.as_str()), Some("codex:work"));

        // With no pin, the agent's own active account — not another agent's.
        let picked = select_for_spawn_under(root.path(), &accounts, "codex", None);
        assert_eq!(picked.map(|a| a.id.as_str()), Some("codex:personal"));
        let picked = select_for_spawn_under(root.path(), &accounts, "claude", None);
        assert_eq!(picked.map(|a| a.id.as_str()), Some("claude:personal"));

        // An id that no longer exists selects nothing rather than falling back
        // to the active account: a task pinned elsewhere must not silently run
        // under someone else's login.
        assert!(
            select_for_spawn_under(root.path(), &accounts, "codex", Some("codex:gone")).is_none()
        );

        // An agent with no accounts at all.
        assert!(select_for_spawn_under(root.path(), &accounts, "gemini", None).is_none());
    }

    #[test]
    fn spawn_drops_an_account_whose_vault_stopped_verifying() {
        let root = tempfile::tempdir().unwrap();
        let vault = create_vault_under(root.path(), "codex", "personal", "codex:personal").unwrap();
        let accounts = vec![account("codex:personal", &vault)];
        assert!(select_for_spawn_under(root.path(), &accounts, "codex", None).is_some());

        // The vault was deleted behind the daemon's back. The row survives, but
        // handing a stale path to the child would give it an empty CODEX_HOME.
        std::fs::remove_dir_all(&vault).unwrap();
        assert!(select_for_spawn_under(root.path(), &accounts, "codex", None).is_none());

        // And a path swapped for a link out of the accounts root is refused
        // even though it now resolves to a real, marked vault.
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = outside.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join(OWNERSHIP_MARKER), "codex:personal\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, &vault).unwrap();
            assert!(select_for_spawn_under(root.path(), &accounts, "codex", None).is_none());
        }
    }
}
