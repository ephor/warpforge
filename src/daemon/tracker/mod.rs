//! External issue-tracker integration (GitHub / Linear).
//!
//! This module owns the tracker connections: the Linear API key (stored in the
//! macOS keychain, mirroring the Claude credential pattern in `claude_auth`),
//! and the create/read network calls.
//!
//! GitHub prefers a PAT (`repo` + `read:project`) via keychain + reqwest;
//! `gh` CLI is a deprecated fallback. Linear uses GraphQL over reqwest with a personal API key.
//!
//! Directionality: warpforge creates issues in either tracker and *reads* their
//! status back — for GitHub that means the Projects V2 board column, which is
//! where a repo's real status lives. Writing status *out* is deliberately
//! unsupported for both trackers; the board mirrors remote state.
//!
//! Persistence (`tracker_links` rows) is owned by `Store`; the actor layer
//! hands rows in/out because `Store` (rusqlite `Connection`) is not `Send` and
//! must never be borrowed across an `.await`.
//!
//! Layout: `linear` and `github` are the provider calls, `import` adopts a
//! listing into the backlog (and refreshes what it already tracks), `page`
//! serves the paged listing read straight from a tracker. This module holds
//! what both providers share — the fetched-issue shape and the connection
//! state.

mod github;
mod import;
mod linear;
mod page;

pub use github::github_login;
pub(crate) use github::github_owner_repo;
pub use github::take_last_board_warning;
pub use import::{adopt_imported, fetch_importable, fetch_links_status};
pub use linear::{keychain_read, linear_teams};
pub use page::fetch_page;

use anyhow::{anyhow, bail, Context, Result};

use warpforge_protocol as wire;

use super::store::{Store, TrackerLink};

/// Ceiling on any single tracker call. Tracker work happens on the request
/// path, so an unbounded call is a hung UI, not just a slow refresh.
const NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// How many issues one listing pulls per tracker. Import is a convenience for
/// seeing the backlog, not a mirror of the whole tracker.
const IMPORT_LIMIT: usize = 100;

/// A tracker issue as fetched, before it is given a backlog identity.
pub struct RemoteIssue {
    pub external_id: String,
    pub title: String,
    pub body: String,
    pub url: String,
    pub status: String,
    pub remote_status: String,
    pub assignee: Option<String>,
    /// When the tracker says the issue was opened, unix seconds. 0 when the
    /// provider did not give one; callers fall back to `updated_at` rather
    /// than showing 1970.
    pub created_at: u64,
    pub updated_at: u64,
}

impl RemoteIssue {
    /// The issue's creation time, falling back to its last update. A backlog
    /// row whose "Created" reads later than its "Updated" is worse than a
    /// slightly late one.
    pub fn created_or_updated(&self) -> u64 {
        if self.created_at == 0 {
            self.updated_at
        } else {
            self.created_at
        }
    }
}

/// A tracker's own status word, mapped onto warpforge's five. `None` for a
/// label this vocabulary does not recognize — the caller decides what an
/// unknown column means, because only it knows what else it has to go on
/// (ADR-0002 invariant 6: an unknown label never overwrites the normalized
/// status, it is kept in `remote_status` for display).
///
/// Substring matching, not a table: Linear states and GitHub project columns
/// are named by whoever set the board up ("In progress", "In Progress · dev",
/// "Doing"), and no fixed list survives contact with that.
fn normalize_status(label: &str) -> Option<&'static str> {
    let low = label.trim().to_lowercase();
    if low.is_empty() {
        return None;
    }
    // Cancelled is checked first: "Cancelled (done)" is not done.
    if low.contains("cancel") || low.contains("won't") || low.contains("wont ") {
        Some("cancelled")
    } else if low.contains("done")
        || low.contains("complete")
        || low.contains("closed")
        || low.contains("shipped")
        || low.contains("merged")
    {
        Some("done")
    } else if low.contains("progress")
        || low.contains("started")
        || low.contains("doing")
        || low.contains("review")
        // Boards name the verification column "In Test", "Testing" or "QA";
        // work sitting there is in flight, not waiting to be picked up.
        || low.contains("test")
        || low
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word == "qa")
    {
        Some("in_progress")
    } else if low.contains("wait") || low.contains("block") || low.contains("hold") {
        Some("waiting")
    } else if low.contains("todo")
        || low.contains("to do")
        || low.contains("backlog")
        || low.contains("triage")
        || low.contains("ready")
        || low.contains("planned")
        || low.contains("open")
        || low.contains("new")
    {
        Some("todo")
    } else {
        None
    }
}

/// Seconds since the epoch for an RFC-3339 UTC timestamp, 0 if unparseable.
///
/// Hand-rolled rather than pulling in a date crate for one field: both GitHub
/// and Linear emit `YYYY-MM-DDTHH:MM:SS` with a `Z` suffix, and the value is
/// only used for display ordering, so a miss is harmless.
fn rfc3339_secs(value: &str) -> u64 {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return 0;
    }
    let num = |range: std::ops::Range<usize>| value[range].parse::<i64>().ok();
    let (Some(year), Some(month), Some(day), Some(hour), Some(min), Some(sec)) = (
        num(0..4),
        num(5..7),
        num(8..10),
        num(11..13),
        num(14..16),
        num(17..19),
    ) else {
        return 0;
    };
    // Days from civil (Howard Hinnant's algorithm), epoch 1970-01-01.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec;
    secs.max(0) as u64
}

// ── Connection state ─────────────────────────────────────────────────────────

/// Current tracker status for the wire protocol.
pub async fn status() -> wire::TrackerStatus {
    let linear = linear::keychain_read().map(|_| wire::TrackerLinearStatus {
        connected: true,
        email: None,
        organization: None,
    });
    let github = if github::github_token().is_some() {
        Some(wire::TrackerGithubStatus {
            connected: true,
            login: github::github_login().await,
            warning: None,
        })
    } else {
        github::github_login()
            .await
            .map(|login| wire::TrackerGithubStatus {
                connected: true,
                login: Some(login),
                warning: None,
            })
    };
    wire::TrackerStatus { linear, github }
}

pub async fn connect_github(token: &str) -> Result<()> {
    let t = token.trim();
    if t.is_empty() {
        bail!("GitHub token is empty");
    }
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {t}"))
        .header("User-Agent", "warpforge")
        .timeout(NETWORK_TIMEOUT)
        .send()
        .await
        .context("GitHub token validation")?;
    if !resp.status().is_success() {
        bail!("GitHub token invalid: {}", resp.status());
    }
    github::github_keychain_write(t)
}
pub async fn disconnect_github() -> Result<()> {
    github::github_keychain_delete()
}

/// Connect (or refresh) the Linear API key: validate it, then store it.
pub async fn connect_linear(api_key: &str) -> Result<()> {
    let (email, org) = linear::linear_identity(api_key).await?;
    linear::keychain_write(api_key)?;
    // Surface the freshly-validated identity to callers.
    let _ = (email, org);
    Ok(())
}

/// Disconnect Linear by deleting the stored key.
pub async fn disconnect_linear() -> Result<()> {
    linear::keychain_delete()
}

// ── Backlog item ↔ external issue ────────────────────────────────────────────

/// Create an external issue for a backlog item. Returns `(external_id, url)`.
///
/// `item_id` is the client-generated backlog item id; `repo_dir` is used only
/// by the github provider. The caller persists the resulting [`TrackerLink`].
pub async fn create_external(
    provider: &str,
    repo_dir: Option<&str>,
    title: &str,
    body: &str,
    linear_team_id: Option<&str>,
) -> Result<(String, String)> {
    match provider {
        "linear" => linear::linear_create_issue(title, body, linear_team_id).await,
        "github" => {
            let dir = repo_dir.ok_or_else(|| anyhow!("github provider needs a git repository"))?;
            github::github_create_issue(dir, title, body).await
        }
        other => bail!("unknown tracker provider: {other}"),
    }
}

/// Build a fresh link row for a backlog item (no network I/O). `imported` is
/// true only when a tracker listing minted this row, never when somebody wrote
/// the item here and pushed it out — see `Store::delete_imported_linear_items`.
pub fn make_link(
    item_id: &str,
    provider: &str,
    project: &str,
    external_id: &str,
    url: &str,
    imported: bool,
) -> TrackerLink {
    TrackerLink {
        item_id: item_id.to_string(),
        provider: provider.to_string(),
        project: project.to_string(),
        external_id: external_id.to_string(),
        url: url.to_string(),
        status: "todo".into(),
        remote_status: None,
        last_synced_at: 0,
        task_id: None,
        imported,
    }
}

/// All persisted links (for clients to hydrate the backlog table on load).
pub fn list_links(store: &Store) -> Result<Vec<wire::TrackerLinkInfo>> {
    Ok(store
        .load_all_tracker_links()?
        .into_iter()
        .map(|l| l.to_wire())
        .collect())
}

/// Link a daemon task to a backlog item. If the item has no external link yet
/// (local item), we still record the task link in a placeholder row so the
/// relationship survives restarts.
pub fn link_task(
    store: &Store,
    item_id: &str,
    task_id: &str,
    provider: &str,
    project: &str,
) -> Result<()> {
    if store.load_tracker_link(item_id)?.is_none() {
        store.upsert_tracker_link(&TrackerLink {
            item_id: item_id.to_string(),
            provider: provider.to_string(),
            project: project.to_string(),
            external_id: String::new(),
            url: String::new(),
            status: "todo".into(),
            remote_status: None,
            last_synced_at: 0,
            task_id: Some(task_id.to_string()),
            imported: false,
        })?;
    } else {
        store.set_tracker_link_task(item_id, task_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(created_at: u64, updated_at: u64) -> RemoteIssue {
        RemoteIssue {
            external_id: "#1".into(),
            title: String::new(),
            body: String::new(),
            url: String::new(),
            status: "todo".into(),
            remote_status: "OPEN".into(),
            assignee: None,
            created_at,
            updated_at,
        }
    }

    #[test]
    fn status_words_normalize_across_trackers() {
        let of = |label: &str| normalize_status(label);
        assert_eq!(of("Done"), Some("done"));
        assert_eq!(of("In Progress"), Some("in_progress"));
        assert_eq!(of("In review"), Some("in_progress"));
        assert_eq!(of("In Test"), Some("in_progress"));
        assert_eq!(of("QA"), Some("in_progress"));
        assert_eq!(of("Blocked"), Some("waiting"));
        assert_eq!(of("Backlog"), Some("todo"));
        // Cancelled wins over done, or "Cancelled (not done)" reads as shipped.
        assert_eq!(of("Cancelled"), Some("cancelled"));
        assert_eq!(of("Won't do"), Some("cancelled"));
        // A board column nobody can guess the meaning of stays unknown rather
        // than being forced into one of the five.
        assert_eq!(of("Icebox"), None);
        assert_eq!(of("  "), None);
    }

    #[test]
    fn creation_time_falls_back_to_the_last_update() {
        assert_eq!(issue(100, 500).created_or_updated(), 100);
        // A provider that gave no creation time must not date the row to 1970.
        assert_eq!(issue(0, 500).created_or_updated(), 500);
    }

    #[test]
    fn rfc3339_parsing() {
        assert_eq!(rfc3339_secs("1970-01-01T00:00:00Z"), 0);
        assert_eq!(rfc3339_secs("2024-01-01T00:00:00Z"), 1_704_067_200);
        // Leap day, and a fractional-seconds suffix Linear sometimes emits.
        assert_eq!(rfc3339_secs("2024-02-29T12:34:56.789Z"), 1_709_210_096);
        // Unparseable input orders last rather than failing the import.
        assert_eq!(rfc3339_secs(""), 0);
        assert_eq!(rfc3339_secs("yesterday"), 0);
        assert_eq!(rfc3339_secs("2024-02-29T12:34"), 0);
    }
}
