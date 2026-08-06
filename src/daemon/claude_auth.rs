//! Claude account switching: which login the `claude` CLI uses right now.
//!
//! Claude is not switched by environment. Its config directory holds skills,
//! plugins, settings, MCP config and project history, so giving each account its
//! own `CLAUDE_CONFIG_DIR` would fragment all of that. Instead there is one
//! config dir and the *credentials inside it* are swapped — the same choice Orca
//! makes on the host (`runtime-auth-service.ts`).
//!
//! Two consequences follow, and both are load-bearing:
//!
//! * **Switching is global.** The user's terminal `claude` follows it too. A
//!   running session also follows it, on its next request — the CLI re-reads
//!   credentials rather than holding them for its lifetime. That is the point
//!   (switch mid-task, keep working), not an accident.
//! * **The outgoing account must be captured before it is overwritten.** A live
//!   CLI refreshes and rotates its token; the copy in our vault goes stale the
//!   moment it does. Writing the incoming account over it without reading it
//!   back first throws away the only valid refresh token that account has, and
//!   the user is silently logged out of it — the failure mode that makes naive
//!   credential swapping feel random.
//!
//! On macOS the credentials live in the login keychain, not (only) on disk.
//! Claude Code 2.1+ scopes the keychain item by config dir —
//! `Claude Code-credentials-<first 8 hex of sha256(configDir)>` — while older
//! builds and the default config dir use the unsuffixed service. Reads try the
//! scoped item first and fall back; writes update the canonical item always and
//! the scoped one only when it already exists (see `write_live_credentials`).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Keychain service Claude Code itself reads (pre-2.1, and still the fallback).
const ACTIVE_SERVICE: &str = "Claude Code-credentials";
/// Keychain service holding our per-account copies. Keyed by account id.
const MANAGED_SERVICE: &str = "Warpforge Claude Managed Credentials";
/// Credential file name inside a config dir (and inside our vaults).
pub const CREDENTIALS_FILE: &str = ".credentials.json";
/// Account metadata we store alongside it, for the switcher's label.
pub const OAUTH_ACCOUNT_FILE: &str = "oauth-account.json";

/// How to reach the keychain and the config dir. Injectable so the swap can be
/// tested without touching the real login keychain.
#[derive(Debug, Clone)]
pub struct ClaudeRuntime {
    /// Claude's config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
    pub config_dir: PathBuf,
    /// The `.claude.json` the CLI actually reads: colocated in the config dir
    /// when one was set explicitly, else `~/.claude.json`.
    pub config_path: PathBuf,
    /// `security` binary. `None` disables keychain access (non-macOS, tests).
    pub security_bin: Option<PathBuf>,
    /// Keychain account name — the login user.
    pub user: String,
}

impl ClaudeRuntime {
    pub fn detect() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let explicit = std::env::var("CLAUDE_CONFIG_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from);
        let config_dir = explicit.clone().unwrap_or_else(|| home.join(".claude"));
        let colocated = config_dir.join(".claude.json");
        let config_path = if explicit.is_some() || colocated.is_file() {
            colocated
        } else {
            home.join(".claude.json")
        };
        Self {
            config_dir,
            config_path,
            security_bin: cfg!(target_os = "macos").then(|| PathBuf::from("/usr/bin/security")),
            user: std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_else(|_| "user".to_string()),
        }
    }

    /// The `oauthAccount` block the CLI currently believes it is signed in as.
    pub fn read_live_oauth_account(&self) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(&self.config_path).ok()?;
        let config: serde_json::Value = serde_json::from_str(&text).ok()?;
        config.get("oauthAccount").cloned()
    }

    /// Point the CLI's config at `account`, leaving the rest of `.claude.json`
    /// untouched.
    ///
    /// Swapping credentials without this is the bug it was written for: the CLI
    /// gets a token for one account while its config still names another, and
    /// reports "OAuth session expired and could not be refreshed" — or, across
    /// organizations, refuses the login as not a member. The file also holds
    /// every project's history, so it is edited in place, never rewritten.
    pub fn write_live_oauth_account(&self, account: &serde_json::Value) -> Result<()> {
        let mut config = match std::fs::read_to_string(&self.config_path) {
            Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                .with_context(|| format!("parsing {}", self.config_path.display()))?,
            Err(_) => serde_json::json!({}),
        };
        let Some(object) = config.as_object_mut() else {
            bail!("{} is not a JSON object", self.config_path.display());
        };
        object.insert("oauthAccount".to_string(), account.clone());
        let serialized = serde_json::to_string(&config)?;
        write_config_file(&self.config_path, &serialized)
    }

    fn credentials_path(&self) -> PathBuf {
        self.config_dir.join(CREDENTIALS_FILE)
    }

    /// Keychain service scoped to this config dir, as Claude Code 2.1+ derives it.
    fn scoped_service(&self) -> String {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(self.config_dir.to_string_lossy().as_bytes());
        let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
        format!("{ACTIVE_SERVICE}-{hex}")
    }

    /// Services to try when reading, newest scheme first.
    fn active_services(&self) -> Vec<String> {
        vec![self.scoped_service(), ACTIVE_SERVICE.to_string()]
    }

    /// The credentials the CLI would use right now: scoped keychain item, then
    /// the legacy one, then the file. Returns `None` when not logged in.
    pub fn read_live_credentials(&self) -> Result<Option<String>> {
        for service in self.active_services() {
            if let Some(secret) = self.keychain_read(&service, &self.user)? {
                return Ok(Some(secret));
            }
        }
        let path = self.credentials_path();
        if path.is_file() {
            return Ok(Some(std::fs::read_to_string(&path)?));
        }
        Ok(None)
    }

    /// Make `credentials` the live login: the file, the canonical keychain
    /// item, and the scoped one *if the CLI is already using it*.
    ///
    /// Creating a scoped item that Claude does not read would be worse than
    /// useless: reads prefer the scoped service, so the invented item would
    /// shadow the canonical one and go stale the next time the user logs in
    /// from a terminal — handing back an old token on the next switch.
    /// Verified on this machine: with the default `~/.claude`, only the
    /// unsuffixed service exists.
    pub fn write_live_credentials(&self, credentials: &str) -> Result<()> {
        std::fs::create_dir_all(&self.config_dir)
            .with_context(|| format!("creating {}", self.config_dir.display()))?;
        // Only refresh a credentials file that the CLI already maintains.
        // Creating one where there was none adds a second source of truth that
        // nothing updates: Claude rotates its token into the keychain, the file
        // keeps the old one, and whichever the CLI happens to read next decides
        // whether the user is logged in.
        let path = self.credentials_path();
        let file_exists = path.is_file();
        let scoped = self.scoped_service();
        let scoped_exists = self.keychain_read(&scoped, &self.user)?.is_some();
        if file_exists || (!scoped_exists && self.security_bin.is_none()) {
            write_secret_file(&path, credentials)?;
        }
        if scoped_exists {
            self.keychain_write(&scoped, &self.user, credentials)?;
        }
        self.keychain_write(ACTIVE_SERVICE, &self.user, credentials)
    }

    /// Our own per-account copy, kept in the keychain when there is one.
    pub fn read_managed_credentials(&self, account_id: &str) -> Result<Option<String>> {
        self.keychain_read(MANAGED_SERVICE, account_id)
    }

    pub fn write_managed_credentials(&self, account_id: &str, credentials: &str) -> Result<()> {
        self.keychain_write(MANAGED_SERVICE, account_id, credentials)
    }

    pub fn delete_managed_credentials(&self, account_id: &str) -> Result<()> {
        let Some(bin) = &self.security_bin else {
            return Ok(());
        };
        let output = std::process::Command::new(bin)
            .args(["delete-generic-password", "-s", MANAGED_SERVICE, "-a"])
            .arg(account_id)
            .output();
        // A missing item is the desired end state, not an error.
        let _ = output;
        Ok(())
    }

    fn keychain_read(&self, service: &str, account: &str) -> Result<Option<String>> {
        let Some(bin) = &self.security_bin else {
            return Ok(None);
        };
        let output = std::process::Command::new(bin)
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .with_context(|| format!("running {}", bin.display()))?;
        if !output.status.success() {
            return Ok(None);
        }
        let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!secret.is_empty()).then_some(secret))
    }

    fn keychain_write(&self, service: &str, account: &str, secret: &str) -> Result<()> {
        let Some(bin) = &self.security_bin else {
            return Ok(());
        };
        let output = std::process::Command::new(bin)
            .args([
                "add-generic-password",
                "-U",
                "-s",
                service,
                "-a",
                account,
                "-w",
            ])
            .arg(secret)
            .output()
            .with_context(|| format!("running {}", bin.display()))?;
        if !output.status.success() {
            bail!(
                "keychain write failed for {service}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }
}

/// Environment variables that override the selected account. Any of these set
/// in the daemon's environment makes the CLI authenticate as something else,
/// and the switch appears to do nothing at all — so they are removed from the
/// child rather than trusted to be absent.
pub const CONFLICTING_AUTH_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
];

/// Whether a custom-headers value smuggles credentials (Orca applies the same
/// test before stripping it).
pub fn headers_look_like_auth(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    ["authorization", "x-api-key", "api-key", "bearer"]
        .iter()
        .any(|needle| lowered.contains(needle))
}

/// A credentials blob is usable if it parses and carries a non-empty token.
///
/// This exists because a live CLI that loses a refresh race can write an empty
/// credentials blob. Persisting that into a vault would log the account out for
/// good, so an unusable read-back is discarded rather than stored.
pub fn credentials_are_usable(blob: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(blob) else {
        return false;
    };
    // Claude has nested the token under different keys across versions
    // (`accessToken`, `claudeAiOauth.refreshToken`, …), so look for any
    // non-empty `*token*` string anywhere in the blob rather than a fixed path.
    fn has_token(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(map) => map.iter().any(|(key, v)| {
                let named_token = key.to_ascii_lowercase().contains("token");
                match v {
                    serde_json::Value::String(s) => named_token && !s.trim().is_empty(),
                    nested => has_token(nested),
                }
            }),
            serde_json::Value::Array(items) => items.iter().any(has_token),
            _ => false,
        }
    }
    has_token(&value)
}

/// Replace a config file atomically, keeping its existing permissions — it is
/// not a secret, and `.claude.json` is world-readable by default.
fn write_config_file(path: &Path, contents: &str) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).ok();
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config")
    ));
    std::fs::write(&tmp, contents).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))
}

fn write_secret_file(path: &Path, contents: &str) -> Result<()> {
    // Write through a sibling temp file and rename, so a crash mid-write can
    // never leave the live credentials truncated.
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("cred")
    ));
    std::fs::write(&tmp, contents).with_context(|| format!("writing {}", tmp.display()))?;
    set_owner_only(&tmp)?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    set_owner_only(path)
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
pub(crate) mod tests {
    use super::*;

    /// A stub `security` that stores items as files in a directory, so the swap
    /// logic can be exercised without the real login keychain.
    #[cfg(unix)]
    pub(crate) fn stub_runtime(dir: &Path) -> ClaudeRuntime {
        let store = dir.join("keychain");
        std::fs::create_dir_all(&store).unwrap();
        let script = dir.join("security");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
store='{}'
cmd="$1"; shift
service=""; account=""; secret=""; want_w=0
while [ $# -gt 0 ]; do
  case "$1" in
    -s) service="$2"; shift 2;;
    -a) account="$2"; shift 2;;
    -w) if [ "$cmd" = "add-generic-password" ]; then secret="$2"; shift 2; else want_w=1; shift; fi;;
    -U) shift;;
    *) shift;;
  esac
done
key=$(printf '%s' "$service/$account" | tr -c 'A-Za-z0-9' '_')
case "$cmd" in
  add-generic-password) printf '%s' "$secret" > "$store/$key"; exit 0;;
  find-generic-password) [ -f "$store/$key" ] || exit 44; cat "$store/$key"; exit 0;;
  delete-generic-password) rm -f "$store/$key"; exit 0;;
esac
exit 1
"#,
                store.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        ClaudeRuntime {
            config_dir: dir.join("config"),
            config_path: dir.join("config").join(".claude.json"),
            security_bin: Some(script),
            user: "tester".to_string(),
        }
    }

    #[test]
    fn scoped_service_matches_claude_2_1_scheme() {
        let runtime = ClaudeRuntime {
            config_dir: PathBuf::from("/Users/tester/.claude"),
            config_path: PathBuf::from("/Users/tester/.claude.json"),
            security_bin: None,
            user: "tester".into(),
        };
        let service = runtime.scoped_service();
        assert!(service.starts_with("Claude Code-credentials-"), "{service}");
        // 8 hex chars of sha256, appended to the canonical service name.
        let suffix = service.trim_start_matches("Claude Code-credentials-");
        assert_eq!(suffix.len(), 8);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
        // Different config dirs must not collide.
        let other = ClaudeRuntime {
            config_dir: PathBuf::from("/Users/tester/.claude-work"),
            ..runtime.clone()
        };
        assert_ne!(runtime.scoped_service(), other.scoped_service());
    }

    #[cfg(unix)]
    #[test]
    fn live_credentials_round_trip_through_keychain_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = stub_runtime(dir.path());
        assert_eq!(runtime.read_live_credentials().unwrap(), None);

        runtime
            .write_live_credentials(r#"{"accessToken":"a"}"#)
            .unwrap();
        assert_eq!(
            runtime.read_live_credentials().unwrap().as_deref(),
            Some(r#"{"accessToken":"a"}"#)
        );
        // The canonical service is always written…
        assert_eq!(
            runtime
                .keychain_read(ACTIVE_SERVICE, &runtime.user)
                .unwrap(),
            Some(r#"{"accessToken":"a"}"#.to_string())
        );
        // …the scoped one is not invented when the CLI isn't using it, or reads
        // would prefer an item nobody else updates.
        assert_eq!(
            runtime
                .keychain_read(&runtime.scoped_service(), &runtime.user)
                .unwrap(),
            None
        );
        // …and no credentials file is invented next to a keychain-backed CLI:
        // nothing would keep it in step, and the CLI might read it later.
        assert!(!runtime.config_dir.join(CREDENTIALS_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_credentials_file_is_kept_in_step() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = stub_runtime(dir.path());
        std::fs::create_dir_all(&runtime.config_dir).unwrap();
        std::fs::write(
            runtime.config_dir.join(CREDENTIALS_FILE),
            r#"{"accessToken":"old"}"#,
        )
        .unwrap();

        runtime
            .write_live_credentials(r#"{"accessToken":"new"}"#)
            .unwrap();

        let file = std::fs::read_to_string(runtime.config_dir.join(CREDENTIALS_FILE)).unwrap();
        assert_eq!(file, r#"{"accessToken":"new"}"#);
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_scoped_item_is_kept_in_step() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = stub_runtime(dir.path());
        // A config dir whose CLI does use the scoped service (Claude 2.1+).
        runtime
            .keychain_write(
                &runtime.scoped_service(),
                &runtime.user,
                r#"{"accessToken":"old"}"#,
            )
            .unwrap();

        runtime
            .write_live_credentials(r#"{"accessToken":"new"}"#)
            .unwrap();

        // Both are updated: a stale scoped item would shadow the canonical one
        // on the next read and hand back the previous account's token.
        assert_eq!(
            runtime
                .keychain_read(&runtime.scoped_service(), &runtime.user)
                .unwrap(),
            Some(r#"{"accessToken":"new"}"#.to_string())
        );
        assert_eq!(
            runtime
                .keychain_read(ACTIVE_SERVICE, &runtime.user)
                .unwrap(),
            Some(r#"{"accessToken":"new"}"#.to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_credentials_are_per_account() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = stub_runtime(dir.path());
        runtime
            .write_managed_credentials("claude:work", r#"{"accessToken":"w"}"#)
            .unwrap();
        runtime
            .write_managed_credentials("claude:home", r#"{"accessToken":"h"}"#)
            .unwrap();
        assert_eq!(
            runtime.read_managed_credentials("claude:work").unwrap(),
            Some(r#"{"accessToken":"w"}"#.to_string())
        );
        runtime.delete_managed_credentials("claude:work").unwrap();
        assert_eq!(
            runtime.read_managed_credentials("claude:work").unwrap(),
            None
        );
        assert!(runtime
            .read_managed_credentials("claude:home")
            .unwrap()
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn writing_the_oauth_account_preserves_the_rest_of_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = stub_runtime(dir.path());
        std::fs::create_dir_all(&runtime.config_dir).unwrap();
        // `.claude.json` also holds every project's history; a swap must not
        // cost the user any of it.
        std::fs::write(
            &runtime.config_path,
            r#"{"oauthAccount":{"emailAddress":"work@corp.com"},"projects":{"/a":{"history":[1,2]}},"userID":"u1"}"#,
        )
        .unwrap();

        runtime
            .write_live_oauth_account(&serde_json::json!({
                "emailAddress": "me@example.com",
                "organizationName": "Personal"
            }))
            .unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&runtime.config_path).unwrap()).unwrap();
        assert_eq!(config["oauthAccount"]["emailAddress"], "me@example.com");
        assert_eq!(config["projects"]["/a"]["history"][1], 2);
        assert_eq!(config["userID"], "u1");
        assert_eq!(
            runtime.read_live_oauth_account().unwrap()["organizationName"],
            "Personal"
        );
    }

    #[test]
    fn unusable_credentials_are_recognised() {
        assert!(credentials_are_usable(r#"{"accessToken":"abc"}"#));
        assert!(credentials_are_usable(
            r#"{"claudeAiOauth":{"refreshToken":"abc"}}"#
        ));
        // The shapes a live CLI writes when it loses a refresh race.
        assert!(!credentials_are_usable(r#"{"accessToken":""}"#));
        assert!(!credentials_are_usable("{}"));
        assert!(!credentials_are_usable(""));
        assert!(!credentials_are_usable("not json"));
    }

    #[test]
    fn auth_like_headers_are_detected() {
        assert!(headers_look_like_auth("Authorization: Bearer x"));
        assert!(headers_look_like_auth("x-api-key: abc"));
        assert!(!headers_look_like_auth("X-Trace-Id: 42"));
    }
}
