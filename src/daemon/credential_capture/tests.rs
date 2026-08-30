use super::*;

/// A Codex `id_token` carrying just the claim identity is read from.
fn jwt(email: &str) -> String {
    use base64::Engine;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{{\"email\":\"{email}\"}}"));
    format!("header.{payload}.sig")
}

/// The shape Codex writes: token, identity and the refresh stamp it bumps on
/// every rotation (verified against a real `~/.codex/auth.json`).
fn codex_auth(email: &str, token: &str, last_refresh: &str) -> String {
    format!(
        "{{\"tokens\":{{\"id_token\":\"{}\",\"access_token\":\"{token}\",\"refresh_token\":\"r-{token}\"}},\"last_refresh\":\"{last_refresh}\"}}",
        jwt(email)
    )
}

fn codex_account(root: &Path, slug: &str, email: &str) -> StoredAccount {
    let id = accounts::account_id("codex", slug);
    let vault = accounts::create_vault_under(root, "codex", slug, &id).unwrap();
    StoredAccount {
        id,
        agent_id: "codex".to_string(),
        label: slug.to_string(),
        email: Some(email.to_string()),
        plan: None,
        home_dir: vault.to_string_lossy().into_owned(),
        created_at: 0,
        active: false,
    }
}

fn stock(account: &StoredAccount, auth: &str) {
    accounts::write_vault_file(Path::new(&account.home_dir), CODEX_AUTH_FILE, auth).unwrap();
}

fn vault_auth(account: &StoredAccount) -> String {
    std::fs::read_to_string(Path::new(&account.home_dir).join(CODEX_AUTH_FILE)).unwrap()
}

/// A live Codex home holding `auth`.
fn live_home(auth: &str) -> (tempfile::TempDir, PathBuf) {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    std::fs::write(&path, auth).unwrap();
    (home, path)
}

/// The bug this module exists for: a task with no recorded account ran in
/// Codex's own home, the CLI rotated the token there, and the vault — written
/// once at import — was left holding a refresh token that no longer works.
#[test]
fn a_rotation_in_the_shared_home_lands_in_the_account_that_owns_the_identity() {
    let root = tempfile::tempdir().unwrap();
    let account = codex_account(root.path(), "personal", "me@example.com");
    stock(
        &account,
        &codex_auth("me@example.com", "v1", "2026-08-01T00:00:00Z"),
    );
    let rotated = codex_auth("me@example.com", "v2", "2026-08-02T00:00:00Z");
    let (_home, live) = live_home(&rotated);

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Persisted(account.id.clone())
    );
    assert_eq!(vault_auth(&account), rotated);

    // Looking again changes nothing: the bytes are the ones we last stored.
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Unchanged
    );
}

/// After a daemon restart there is no record of what the home held, so identity
/// alone cannot prove the runtime copy is the newer of the two.
#[test]
fn without_a_baseline_a_rotation_must_prove_it_is_newer() {
    let root = tempfile::tempdir().unwrap();
    let account = codex_account(root.path(), "personal", "me@example.com");
    let stored = codex_auth("me@example.com", "v2", "2026-08-02T00:00:00Z");
    stock(&account, &stored);

    // Same instant, different bytes: nothing here says which came first.
    let (_home, live) = live_home(&codex_auth(
        "me@example.com",
        "other",
        "2026-08-02T00:00:00Z",
    ));
    let mut capture = CredentialCapture::default();
    assert!(matches!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Rejected(_)
    ));
    assert_eq!(vault_auth(&account), stored);

    // A strictly later refresh is proof, and is taken.
    let rotated = codex_auth("me@example.com", "v3", "2026-08-03T00:00:00Z");
    std::fs::write(&live, &rotated).unwrap();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Persisted(account.id.clone())
    );
    assert_eq!(vault_auth(&account), rotated);
}

/// A home that went *backwards* — an old copy restored, a stale WSL/remote
/// mirror — must never overwrite a newer stored credential, baseline or not.
#[test]
fn a_rollback_to_an_older_token_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let account = codex_account(root.path(), "personal", "me@example.com");
    stock(
        &account,
        &codex_auth("me@example.com", "v1", "2026-08-01T00:00:00Z"),
    );
    let fresh = codex_auth("me@example.com", "v2", "2026-08-02T00:00:00Z");
    let (_home, live) = live_home(&fresh);

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Persisted(account.id.clone())
    );

    std::fs::write(
        &live,
        codex_auth("me@example.com", "v1", "2026-08-01T00:00:00Z"),
    )
    .unwrap();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Rejected("older than the credential already stored")
    );
    assert_eq!(vault_auth(&account), fresh);
}

/// Two vaults answering to the same login: guessing between them would log one
/// of them out, so neither is written.
#[test]
fn an_ambiguous_rotation_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let one = codex_account(root.path(), "personal", "me@example.com");
    let two = codex_account(root.path(), "personal-2", "me@example.com");
    let old = codex_auth("me@example.com", "v1", "2026-08-01T00:00:00Z");
    stock(&one, &old);
    stock(&two, &old);
    let (_home, live) = live_home(&codex_auth("me@example.com", "v2", "2026-08-02T00:00:00Z"));

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, &[one.clone(), two.clone()]),
        Capture::Rejected("more than one account claims that login")
    );
    assert_eq!(vault_auth(&one), old);
    assert_eq!(vault_auth(&two), old);
}

/// A login nobody registered — a colleague's `codex login` in a terminal — is
/// not somebody's vault contents just because a vault was due an update.
#[test]
fn an_unattributable_rotation_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let account = codex_account(root.path(), "personal", "me@example.com");
    let old = codex_auth("me@example.com", "v1", "2026-08-01T00:00:00Z");
    stock(&account, &old);
    let (_home, live) = live_home(&codex_auth(
        "stranger@example.com",
        "v2",
        "2026-08-02T00:00:00Z",
    ));

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Rejected("no account owns that login")
    );
    assert_eq!(vault_auth(&account), old);

    // …and a home with no token at all is a logged-out home, not a rotation.
    std::fs::write(&live, "{}").unwrap();
    assert_eq!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Unchanged
    );
    assert_eq!(vault_auth(&account), old);
}

#[cfg(unix)]
#[test]
fn the_write_is_atomic_owner_only_and_leaves_no_temp_file() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let account = codex_account(root.path(), "personal", "me@example.com");
    stock(
        &account,
        &codex_auth("me@example.com", "v1", "2026-08-01T00:00:00Z"),
    );
    let (_home, live) = live_home(&codex_auth("me@example.com", "v2", "2026-08-02T00:00:00Z"));

    let mut capture = CredentialCapture::default();
    assert!(matches!(
        capture.capture_codex_at(root.path(), &live, std::slice::from_ref(&account)),
        Capture::Persisted(_)
    ));

    let vault = Path::new(&account.home_dir);
    let leftovers: Vec<_> = std::fs::read_dir(vault)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let mode = std::fs::metadata(vault.join(CODEX_AUTH_FILE))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

/// A link planted where the credential goes must not be written through — that
/// would push a live token wherever it points.
#[cfg(unix)]
#[test]
fn a_symlinked_destination_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let outside = dir.path().join("outside.json");
    std::fs::write(&outside, "keep me").unwrap();
    std::os::unix::fs::symlink(&outside, vault.join(CODEX_AUTH_FILE)).unwrap();

    assert!(write_credential_atomically(&vault, CODEX_AUTH_FILE, "{}").is_err());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");
}

/// A `security` stub whose `find-generic-password` always exits `code`, so a
/// real keychain failure (ACL denial, locked keychain) can be exercised.
#[cfg(unix)]
fn failing_security(dir: &Path, code: i32) -> ClaudeRuntime {
    let script = dir.join("security");
    std::fs::write(
        &script,
        format!("#!/bin/sh\n[ \"$1\" = find-generic-password ] && exit {code}\nexit 0\n"),
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

/// The defect this diagnosis exists for: a keychain read that fails must come
/// back as a reported failure, not as the quiet "nothing happened" — the two
/// are indistinguishable to whoever is staring at stale vaults.
#[cfg(unix)]
#[test]
fn a_failing_live_read_is_reported_not_silenced() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = failing_security(dir.path(), 45);
    let mut capture = CredentialCapture::default();
    assert!(matches!(
        capture.capture_claude_under(dir.path(), &runtime, &[], None),
        Capture::Failed(_)
    ));
}

/// Exit 44 is `security`'s "no such item": a logged-out machine is quiet, not
/// an error.
#[cfg(unix)]
#[test]
fn a_missing_live_credential_is_still_quiet() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = failing_security(dir.path(), 44);
    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_claude_under(dir.path(), &runtime, &[], None),
        Capture::Unchanged
    );
}

/// The Codex live file was readable when the path was picked; if it cannot be
/// read by the time the capture looks, that is a failure to report.
#[test]
fn an_unreadable_codex_live_file_is_reported() {
    let root = tempfile::tempdir().unwrap();
    let unreadable = root.path().join("auth.json");
    std::fs::create_dir_all(&unreadable).unwrap();
    let mut capture = CredentialCapture::default();
    assert!(matches!(
        capture.capture_codex_at(root.path(), &unreadable, &[]),
        Capture::Failed(_)
    ));
}

// ---- Claude -------------------------------------------------------------

#[cfg(unix)]
fn claude_blob(token: &str, expires_at: i64) -> String {
    format!("{{\"claudeAiOauth\":{{\"accessToken\":\"{token}\",\"expiresAt\":{expires_at}}}}}")
}

/// A Claude account inside `root`, with `root` doubling as the accounts root.
#[cfg(unix)]
fn claude_account(root: &Path, slug: &str, email: &str) -> StoredAccount {
    let id = accounts::account_id("claude", slug);
    let vault = accounts::create_vault_under(root, "claude", slug, &id).unwrap();
    StoredAccount {
        id,
        agent_id: "claude".to_string(),
        label: slug.to_string(),
        email: Some(email.to_string()),
        plan: None,
        home_dir: vault.to_string_lossy().into_owned(),
        created_at: 0,
        active: true,
    }
}

/// Point the stub CLI's config at `email` — the only place a Claude credential
/// blob's identity can be read from.
#[cfg(unix)]
fn signed_in_as(runtime: &ClaudeRuntime, email: &str) {
    std::fs::create_dir_all(&runtime.config_dir).unwrap();
    std::fs::write(
        &runtime.config_path,
        format!("{{\"oauthAccount\":{{\"emailAddress\":\"{email}\"}}}}"),
    )
    .unwrap();
}

#[cfg(unix)]
#[test]
fn a_claude_rotation_is_filed_under_the_account_the_cli_is_signed_into() {
    let root = tempfile::tempdir().unwrap();
    let runtime = claude_auth::tests::stub_runtime(root.path());
    let account = claude_account(root.path(), "personal", "me@example.com");
    signed_in_as(&runtime, "ME@Example.com");
    runtime
        .write_managed_credentials(&account.id, &claude_blob("v1", 1_000))
        .unwrap();
    let rotated = claude_blob("v2", 2_000);
    runtime.write_live_credentials(&rotated).unwrap();

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_claude_under(root.path(), &runtime, std::slice::from_ref(&account), None),
        Capture::Persisted(account.id.clone())
    );
    assert_eq!(
        runtime.read_managed_credentials(&account.id).unwrap(),
        Some(rotated.clone())
    );
    assert_eq!(
        accounts::read_vault_file(Path::new(&account.home_dir), claude_auth::CREDENTIALS_FILE)
            .unwrap(),
        Some(rotated)
    );

    // A second look finds the bytes it stored and does nothing.
    assert_eq!(
        capture.capture_claude_under(root.path(), &runtime, std::slice::from_ref(&account), None),
        Capture::Unchanged
    );
}

/// `expiresAt` is Claude's monotonic stamp: an earlier expiry is an older
/// token, and an equal one proves nothing.
#[cfg(unix)]
#[test]
fn a_claude_credential_that_is_not_newer_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let runtime = claude_auth::tests::stub_runtime(root.path());
    let account = claude_account(root.path(), "personal", "me@example.com");
    signed_in_as(&runtime, "me@example.com");
    runtime
        .write_managed_credentials(&account.id, &claude_blob("v2", 2_000))
        .unwrap();
    runtime
        .write_live_credentials(&claude_blob("v1", 1_000))
        .unwrap();

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_claude_under(root.path(), &runtime, std::slice::from_ref(&account), None),
        Capture::Rejected("older than the credential already stored")
    );
    assert_eq!(
        runtime.read_managed_credentials(&account.id).unwrap(),
        Some(claude_blob("v2", 2_000))
    );
}

/// The user signed into somebody else from a terminal. Those credentials are
/// nobody's vault contents.
#[cfg(unix)]
#[test]
fn a_claude_login_no_account_claims_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let runtime = claude_auth::tests::stub_runtime(root.path());
    let account = claude_account(root.path(), "personal", "me@example.com");
    signed_in_as(&runtime, "stranger@example.com");
    runtime
        .write_managed_credentials(&account.id, &claude_blob("v1", 1_000))
        .unwrap();
    runtime
        .write_live_credentials(&claude_blob("x", 9_000))
        .unwrap();

    let mut capture = CredentialCapture::default();
    assert_eq!(
        capture.capture_claude_under(root.path(), &runtime, std::slice::from_ref(&account), None),
        Capture::Rejected("no account owns that login")
    );
    assert_eq!(
        runtime.read_managed_credentials(&account.id).unwrap(),
        Some(claude_blob("v1", 1_000))
    );
}
