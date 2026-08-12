//! External issue-tracker integration (GitHub / Linear).
//!
//! This module owns the tracker connections: the Linear API key (stored in the
//! macOS keychain, mirroring the Claude credential pattern in `claude_auth`),
//! and the create/read network calls.
//!
//! GitHub uses the user's `gh` CLI session (already required for PRs in
//! `diff`); Linear uses its GraphQL API over reqwest with a personal API key.
//!
//! Directionality: warpforge creates issues in either tracker and *reads* their
//! status back. Writing status *to* GitHub is deliberately unsupported
//! (GitHub's status model is project-specific); Linear status writes are also
//! out of scope for now — the board mirrors remote state.
//!
//! Persistence (`tracker_links` rows) is owned by `Store`; the actor layer
//! hands rows in/out because `Store` (rusqlite `Connection`) is not `Send` and
//! must never be borrowed across an `.await`.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::process::Command;

use warpforge_protocol as wire;

use super::store::{Store, TrackerLink};

const LINEAR_API: &str = "https://api.linear.app/graphql";
const KEYCHAIN_SERVICE: &str = "warpforge-linear";

/// Ceiling on any single tracker call. Tracker work happens on the request
/// path, so an unbounded call is a hung UI, not just a slow refresh.
const NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

// ── Keychain (Linear API key) ────────────────────────────────────────────────

fn security_bin() -> Option<PathBuf> {
    cfg!(target_os = "macos").then(|| PathBuf::from("/usr/bin/security"))
}

pub fn keychain_read() -> Option<String> {
    let bin = security_bin()?;
    let out = std::process::Command::new(bin)
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            "linear",
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let secret = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!secret.is_empty()).then_some(secret)
}

fn keychain_write(secret: &str) -> Result<()> {
    let bin = security_bin().ok_or_else(|| anyhow!("keychain unavailable on this platform"))?;
    let out = std::process::Command::new(bin)
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            "linear",
            "-w",
        ])
        .arg(secret)
        .output()
        .context("running security add-generic-password")?;
    if !out.status.success() {
        bail!(
            "keychain write failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

fn keychain_delete() -> Result<()> {
    let Some(bin) = security_bin() else {
        return Ok(());
    };
    let _ = std::process::Command::new(bin)
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            "linear",
        ])
        .output();
    Ok(())
}

// ── Linear GraphQL ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GqlEnvelope<T> {
    data: Option<T>,
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize)]
struct GqlError {
    message: String,
}

async fn linear_query_with_key<T: for<'de> Deserialize<'de>>(
    key: &str,
    body: &serde_json::Value,
) -> Result<T> {
    let client = reqwest::Client::new();
    let resp = client
        .post(LINEAR_API)
        .header("Authorization", key)
        .header("Content-Type", "application/json")
        .timeout(NETWORK_TIMEOUT)
        .body(serde_json::to_string(body)?)
        .send()
        .await
        .context("Linear API request failed")?;
    let status = resp.status();
    let text = resp.text().await.context("reading Linear API response")?;
    if !status.is_success() {
        bail!(
            "Linear API returned {status}: {}",
            text.chars().take(300).collect::<String>()
        );
    }
    let env: GqlEnvelope<T> = serde_json::from_str(&text).context("parsing Linear response")?;
    if let Some(errors) = env.errors {
        let msg = errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ");
        bail!("Linear API error: {msg}");
    }
    env.data
        .ok_or_else(|| anyhow!("Linear response had no data"))
}

async fn linear_query<T: for<'de> Deserialize<'de>>(body: &serde_json::Value) -> Result<T> {
    let key = keychain_read().ok_or_else(|| anyhow!("Linear is not connected"))?;
    linear_query_with_key::<T>(&key, body).await
}

#[derive(Deserialize)]
struct LinearViewer {
    viewer: LinearUser,
}

#[derive(Deserialize)]
struct LinearUser {
    email: String,
    organization: Option<LinearOrg>,
}

#[derive(Deserialize)]
struct LinearOrg {
    name: String,
}

/// Validate an API key and return the account's identity.
pub async fn linear_identity(key: &str) -> Result<(String, String)> {
    let data: LinearViewer = linear_query_with_key(
        key,
        &serde_json::json!({ "query": "{ viewer { email organization { name } } }" }),
    )
    .await?;
    Ok((
        data.viewer.email,
        data.viewer.organization.map(|o| o.name).unwrap_or_default(),
    ))
}

#[derive(Deserialize)]
struct CreateIssueData {
    #[serde(rename = "issueCreate")]
    issue_create: Option<LinearCreatedIssue>,
}

#[derive(Deserialize)]
struct LinearCreatedIssue {
    issue: Option<LinearIssue>,
}

#[derive(Deserialize)]
struct LinearIssue {
    id: String,
    identifier: String,
    url: String,
}

/// Create a Linear issue in the project's mapped team, falling back to the first
/// team the key can see when nothing is mapped. Returns the identifier and URL.
pub async fn linear_create_issue(
    title: &str,
    body: &str,
    team_id: Option<&str>,
) -> Result<(String, String)> {
    let team_id = match team_id {
        Some(id) => id.to_string(),
        None => first_team_id().await?,
    };
    // GraphQL variables, not string interpolation: title/description are user
    // text and must not be able to break out of the query.
    let req = serde_json::json!({
        "query": "mutation CreateIssue($input: IssueCreateInput!) { \
                  issueCreate(input: $input) { issue { id identifier url } } }",
        "variables": {
            "input": {
                "teamId": team_id,
                "title": title,
                "description": body.trim(),
            }
        }
    });
    let data: CreateIssueData = linear_query(&req).await?;
    let issue = data
        .issue_create
        .and_then(|c| c.issue)
        .ok_or_else(|| anyhow!("Linear issue creation returned no issue"))?;
    Ok((issue.identifier, issue.url))
}

#[derive(Deserialize)]
struct TeamListData {
    organization: Option<LinearOrgTeams>,
}

#[derive(Deserialize)]
struct LinearOrgTeams {
    teams: LinearTeamsPage,
}

#[derive(Deserialize)]
struct LinearTeamsPage {
    nodes: Vec<LinearTeam>,
}

#[derive(Deserialize)]
struct LinearTeam {
    id: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

async fn first_team_id() -> Result<String> {
    let data: TeamListData = linear_query(&serde_json::json!({
        "query": "{ organization { teams(first: 1) { nodes { id } } } }"
    }))
    .await?;
    data.organization
        .and_then(|o| o.teams.nodes.into_iter().next())
        .map(|t| t.id)
        .ok_or_else(|| anyhow!("No Linear team found for this account"))
}

/// Every team the API key can see, so the desktop can offer them for a project
/// instead of making anyone paste an id.
pub async fn linear_teams() -> Result<Vec<wire::LinearTeam>> {
    let data: TeamListData = linear_query(&serde_json::json!({
        "query": "{ organization { teams(first: 100) { nodes { id key name } } } }"
    }))
    .await?;
    let mut teams: Vec<wire::LinearTeam> = data
        .organization
        .map(|o| o.teams.nodes)
        .unwrap_or_default()
        .into_iter()
        .map(|team| wire::LinearTeam {
            key: team.key.clone().unwrap_or_default(),
            name: team.name.unwrap_or_else(|| team.key.unwrap_or_default()),
            id: team.id,
        })
        .collect();
    teams.sort_by_key(|team| team.name.to_lowercase());
    Ok(teams)
}

/// Map a Linear state name to the normalized warpforge status.
fn linear_status_name(state: &str) -> String {
    let low = state.to_lowercase();
    if low.contains("done") || low.contains("cancel") || low.contains("closed") {
        if low.contains("cancel") {
            "cancelled".into()
        } else {
            "done".into()
        }
    } else if low.contains("in progress") || low.contains("started") {
        "in_progress".into()
    } else if low.contains("wait") || low.contains("block") {
        "waiting".into()
    } else {
        "todo".into()
    }
}

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
    pub updated_at: u64,
}

#[derive(Deserialize)]
struct TeamIssuesData {
    team: Option<LinearTeamIssues>,
}

#[derive(Deserialize)]
struct LinearTeamIssues {
    issues: LinearIssuesPage,
}

#[derive(Deserialize)]
struct LinearIssuesPage {
    nodes: Vec<LinearIssueNode>,
    #[serde(rename = "pageInfo")]
    page_info: Option<LinearPageInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearIssueNode {
    identifier: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    url: String,
    #[serde(default)]
    updated_at: Option<String>,
    state: Option<LinearState>,
    #[serde(default)]
    assignee: Option<LinearAssignee>,
}

#[derive(Deserialize)]
struct LinearAssignee {
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct LinearState {
    name: String,
}

/// List the account's first team's issues. One call serves both import and
/// sync: per-issue lookups turned a twenty-item board into forty round trips.
async fn linear_list_issues(team_id: &str) -> Result<Vec<RemoteIssue>> {
    let req = serde_json::json!({
        "query": "query TeamIssues($teamId: String!, $first: Int!) { \
                  team(id: $teamId) { issues(first: $first) { nodes { \
                  identifier title description url updatedAt state { name } } } } }",
        "variables": { "teamId": team_id, "first": IMPORT_LIMIT as i64 }
    });
    let data: TeamIssuesData = linear_query(&req).await?;
    let nodes = data
        .team
        .map(|t| t.issues.nodes)
        .ok_or_else(|| anyhow!("Linear returned no team"))?;
    Ok(nodes
        .into_iter()
        .map(|node| {
            let state = node.state.map(|s| s.name).unwrap_or_default();
            RemoteIssue {
                external_id: node.identifier,
                title: node.title,
                body: node.description.unwrap_or_default(),
                url: node.url,
                status: linear_status_name(&state),
                remote_status: state,
                assignee: node.assignee.and_then(|a| a.display_name.or(a.name)),
                updated_at: node.updated_at.as_deref().map(rfc3339_secs).unwrap_or(0),
            }
        })
        .collect())
}

/// Cursor-based Linear pagination. We advance cursors until requested page;
/// Linear does not support numeric offsets, so this is the provider-correct
/// equivalent of `page=N`.
async fn linear_list_issues_page(page: u32, page_size: u32) -> Result<(Vec<RemoteIssue>, bool)> {
    let team_id = first_team_id().await?;
    let mut cursor: Option<String> = None;
    let mut current = Vec::new();
    let mut has_next = false;
    for _ in 0..=page {
        let req = serde_json::json!({
            "query": "query TeamIssues($teamId: String!, $first: Int!, $after: String) { team(id: $teamId) { issues(first: $first, after: $after) { nodes { identifier title description url updatedAt state { name } assignee { name displayName } } pageInfo { hasNextPage endCursor } } } }",
            "variables": { "teamId": team_id, "first": page_size as i64, "after": cursor }
        });
        let data: TeamIssuesData = linear_query(&req).await?;
        let Some(team) = data.team else {
            bail!("Linear returned no team");
        };
        let page_info = team.issues.page_info.unwrap_or(LinearPageInfo {
            has_next_page: false,
            end_cursor: None,
        });
        current = team
            .issues
            .nodes
            .into_iter()
            .map(|node| {
                let state = node.state.map(|s| s.name).unwrap_or_default();
                RemoteIssue {
                    external_id: node.identifier,
                    title: node.title,
                    body: node.description.unwrap_or_default(),
                    url: node.url,
                    status: linear_status_name(&state),
                    remote_status: state,
                    assignee: node.assignee.and_then(|a| a.display_name.or(a.name)),
                    updated_at: node.updated_at.as_deref().map(rfc3339_secs).unwrap_or(0),
                }
            })
            .collect();
        has_next = page_info.has_next_page;
        cursor = page_info.end_cursor;
        if !has_next || cursor.is_none() {
            break;
        }
    }
    Ok((current, has_next))
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

// ── GitHub (via `gh` CLI) ────────────────────────────────────────────────────

/// Run `gh` with args in the given repo dir (None = anywhere / current dir).
///
/// Bounded: a network call that never returns must not be able to hold a
/// request open, and `gh` can hang on a stalled connection.
async fn gh(repo: Option<&str>, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("gh");
    if let Some(dir) = repo {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    cmd.kill_on_drop(true);
    let run = cmd.output();
    match tokio::time::timeout(NETWORK_TIMEOUT, run).await {
        Err(_) => bail!("`gh {}` timed out", args.first().copied().unwrap_or("")),
        Ok(result) => result.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow!("GitHub CLI (`gh`) is not installed. Install it (`brew install gh`).")
            } else {
                anyhow!(e)
            }
        }),
    }
}

/// The `gh` login the API will act as. Returns None when unauthenticated.
pub async fn github_login() -> Option<String> {
    let out = gh(None, &["api", "user", "--jq", ".login"]).await.ok()?;
    if !out.status.success() {
        return None;
    }
    let login = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!login.is_empty()).then_some(login)
}

/// Resolve `owner/repo` from the given git directory's origin remote.
async fn github_owner_repo(repo_dir: &str) -> Result<(String, String)> {
    let out = gh(
        Some(repo_dir),
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
        ],
    )
    .await?;
    if !out.status.success() {
        bail!(
            "could not determine GitHub repo here: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (owner, repo) = name
        .split_once('/')
        .ok_or_else(|| anyhow!("unexpected repo name: {name}"))?;
    Ok((owner.to_string(), repo.to_string()))
}

/// List the repo's issues. Pull requests are excluded: `gh issue list` already
/// filters them out, unlike the REST issues endpoint.
///
/// `state` is `open` for import (a closed issue is not backlog) and `all` for
/// sync (an item on the board may since have been closed).
async fn github_list_issues(repo_dir: &str, state: &str) -> Result<Vec<RemoteIssue>> {
    let limit = IMPORT_LIMIT.to_string();
    let out = gh(
        Some(repo_dir),
        &[
            "issue",
            "list",
            "--state",
            state,
            "--limit",
            &limit,
            "--json",
            "number,title,body,state,updatedAt,url,assignees",
        ],
    )
    .await?;
    if !out.status.success() {
        bail!(
            "GitHub issue list failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let parsed: Vec<serde_json::Value> =
        serde_json::from_slice(&out.stdout).context("parsing GitHub issue list")?;
    Ok(parsed
        .into_iter()
        .filter_map(|issue| {
            let number = issue.get("number")?.as_u64()?;
            let state = issue
                .get("state")
                .and_then(|s| s.as_str())
                .unwrap_or("OPEN");
            Some(RemoteIssue {
                external_id: format!("#{number}"),
                title: issue
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string(),
                body: issue
                    .get("body")
                    .and_then(|b| b.as_str())
                    .unwrap_or_default()
                    .to_string(),
                url: issue
                    .get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or_default()
                    .to_string(),
                // GitHub has no status vocabulary beyond open/closed; the
                // native label is surfaced as-is and never written back.
                status: if state.eq_ignore_ascii_case("closed") {
                    "done".into()
                } else {
                    "todo".into()
                },
                remote_status: state.to_string(),
                assignee: assignee_login(issue.get("assignees"), issue.get("assignee")),
                updated_at: issue
                    .get("updatedAt")
                    .and_then(|u| u.as_str())
                    .map(rfc3339_secs)
                    .unwrap_or(0),
            })
        })
        .collect())
}

/// First assignee login from a GitHub item. Prefers the plural `assignees`
/// array (what `gh issue list --json assignees` and the Search API emit);
/// falls back to the deprecated singular `assignee` object.
fn assignee_login(
    assignees: Option<&serde_json::Value>,
    assignee: Option<&serde_json::Value>,
) -> Option<String> {
    if let Some(array) = assignees.and_then(|v| v.as_array()) {
        if let Some(first) = array.first() {
            if let Some(login) = first.get("login").and_then(|v| v.as_str()) {
                return Some(login.to_string());
            }
        }
    }
    assignee
        .and_then(|a| a.get("login"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Fetch one GitHub Search API page. Unlike `gh issue list --limit`, this asks
/// GitHub for exactly one page and gives us `total_count` for the pager.
async fn github_search_issues_page(
    repo_dir: &str,
    page: u32,
    page_size: u32,
    sort_by: &str,
    sort_desc: bool,
    search: &str,
    status: Option<&str>,
) -> Result<(Vec<RemoteIssue>, Option<u64>)> {
    let (owner, repo) = github_owner_repo(repo_dir).await?;
    let state = match status {
        Some("done") | Some("cancelled") => "closed",
        Some("todo") => "open",
        _ => "all",
    };
    let mut query = format!("repo:{owner}/{repo} is:issue state:{state}");
    if !search.trim().is_empty() {
        query.push(' ');
        query.push_str(search.trim());
    }
    let query_arg = format!("q={query}");
    let page_arg = format!("page={}", page.saturating_add(1));
    let per_page_arg = format!("per_page={}", page_size.min(100));
    let sort_arg = format!(
        "sort={}",
        if matches!(sort_by, "title" | "number") {
            "created"
        } else {
            "updated"
        }
    );
    let direction_arg = format!("order={}", if sort_desc { "desc" } else { "asc" });
    let endpoint = "search/issues";
    let args = [
        "api",
        endpoint,
        "-X",
        "GET",
        "-f",
        &query_arg,
        "-f",
        &page_arg,
        "-f",
        &per_page_arg,
        "-f",
        &sort_arg,
        "-f",
        &direction_arg,
    ];
    let out = gh(Some(repo_dir), &args).await?;
    if !out.status.success() {
        bail!(
            "GitHub issue search failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let payload: serde_json::Value =
        serde_json::from_slice(&out.stdout).context("parsing GitHub issue search")?;
    let total = payload.get("total_count").and_then(|v| v.as_u64());
    let parsed = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let issues = parsed
        .into_iter()
        .filter_map(|issue| {
            let number = issue.get("number")?.as_u64()?;
            let native_state = issue
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open");
            Some(RemoteIssue {
                external_id: format!("#{number}"),
                title: issue
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .into(),
                body: issue
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .into(),
                url: issue
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .into(),
                status: if native_state.eq_ignore_ascii_case("closed") {
                    "done"
                } else {
                    "todo"
                }
                .into(),
                remote_status: native_state.into(),
                assignee: assignee_login(issue.get("assignees"), issue.get("assignee")),
                updated_at: issue
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .map(rfc3339_secs)
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok((issues, total))
}

/// Create a GitHub issue in the repo at `repo_dir`. Returns (issue number,
/// html URL).
pub async fn github_create_issue(
    repo_dir: &str,
    title: &str,
    body: &str,
) -> Result<(String, String)> {
    let (owner, repo) = github_owner_repo(repo_dir).await?;
    let api_path = format!("repos/{owner}/{repo}/issues");
    let title_arg = format!("title={title}");
    let body = body.trim();
    let body_arg = if body.is_empty() {
        None
    } else {
        Some(format!("body={body}"))
    };
    let mut args: Vec<String> = vec![
        "api".into(),
        "-X".into(),
        "POST".into(),
        api_path,
        "--raw-field".into(),
        title_arg,
    ];
    if let Some(body_arg) = body_arg {
        args.push("--raw-field".into());
        args.push(body_arg);
    }
    let args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = gh(Some(repo_dir), &args).await?;
    if !out.status.success() {
        bail!(
            "GitHub issue creation failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&out.stdout).context("parsing GitHub issue response")?;
    let number = parsed
        .get("number")
        .and_then(|n| n.as_u64())
        .ok_or_else(|| anyhow!("GitHub issue response had no number"))?;
    let url = parsed
        .get("html_url")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    Ok((format!("#{number}"), url))
}

// ── Connection state ─────────────────────────────────────────────────────────

/// Current tracker status for the wire protocol.
pub async fn status() -> wire::TrackerStatus {
    let linear = keychain_read().map(|_| wire::TrackerLinearStatus {
        connected: true,
        email: None,
        organization: None,
    });
    let github = github_login().await.map(|login| wire::TrackerGithubStatus {
        connected: true,
        login: Some(login),
    });
    wire::TrackerStatus { linear, github }
}

/// Connect (or refresh) the Linear API key: validate it, then store it.
pub async fn connect_linear(api_key: &str) -> Result<()> {
    let (email, org) = linear_identity(api_key).await?;
    keychain_write(api_key)?;
    // Surface the freshly-validated identity to callers.
    let _ = (email, org);
    Ok(())
}

/// Disconnect Linear by deleting the stored key.
pub async fn disconnect_linear() -> Result<()> {
    keychain_delete()
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
        "linear" => linear_create_issue(title, body, linear_team_id).await,
        "github" => {
            let dir = repo_dir.ok_or_else(|| anyhow!("github provider needs a git repository"))?;
            github_create_issue(dir, title, body).await
        }
        other => bail!("unknown tracker provider: {other}"),
    }
}

/// Fetch a tracker's issues. Pure network: the caller decides which of them are
/// new, because `Store` must not be borrowed across an `.await`.
///
/// Providers that are not connected are skipped rather than failing the import:
/// a project with only GitHub should not error because Linear is absent.
/// `linear_team_id` is the team this project was pointed at. Without it there is
/// nothing to import: a Linear API key sees the whole account, so an unscoped
/// pull adopts the same issues into *every* project the user opens. Skipped and
/// logged, not an error — a GitHub-only project must still import (invariant 8).
pub async fn fetch_importable(
    provider: Option<&str>,
    repo_dir: Option<&str>,
    linear_team_id: Option<&str>,
) -> Result<Vec<(String, Vec<RemoteIssue>)>> {
    let wants = |name: &str| provider.is_none_or(|p| p == name);
    let mut out = Vec::new();

    if wants("github") {
        let dir =
            repo_dir.ok_or_else(|| anyhow!("GitHub import needs a registered git repository"))?;
        let issues = github_list_issues(dir, "open")
            .await
            .context("GitHub import failed")?;
        out.push(("github".to_string(), issues));
    }
    if wants("linear") && keychain_read().is_some() {
        match linear_team_id {
            Some(team_id) => {
                let issues = linear_list_issues(team_id)
                    .await
                    .context("Linear import failed")?;
                out.push(("linear".to_string(), issues));
            }
            None => eprintln!("[tracker] skipping Linear import: no team mapped to project"),
        }
    }
    Ok(out)
}

/// Read one page for the backlog table. The provider fetch is intentionally
/// kept separate from import: import only wants open issues, while the table
/// must be able to show closed/done issues too.
/// Only `search` and `status` of the query reach a provider; the remaining
/// backlog filters have no remote equivalent and are the local table's job.
pub async fn fetch_page(
    provider: &str,
    project: &str,
    repo_dir: Option<&str>,
    query: &super::backlog::Query,
) -> Result<wire::ExternalWorkItemPage> {
    let page_size = query.page_size.clamp(1, 100);
    let (issues, total, provider_has_next) = match provider {
        "github" => github_search_issues_page(
            repo_dir.ok_or_else(|| anyhow!("GitHub needs a git repository"))?,
            query.page,
            page_size,
            &query.sort_by,
            query.sort_desc,
            &query.search,
            query.status.as_deref(),
        )
        .await
        .map(|(issues, total)| (issues, total, false))?,
        "linear" => {
            let (issues, has_next) = linear_list_issues_page(query.page, page_size).await?;
            (issues, None, has_next)
        }
        other => bail!("unknown tracker provider: {other}"),
    };
    Ok(build_external_page(
        issues,
        provider,
        project,
        total,
        provider_has_next,
        query,
    ))
}

/// Pure post-processing shared by every provider's `fetch_page`.
///
/// The caller's provider function is responsible for *server-side*
/// pagination — GitHub's numeric `page=`/`per_page=` and Linear's cursor
/// advance — and hands back exactly the rows for `page`. This step must only
/// filter, sort, and shape them, and MUST NOT slice by `page * page_size`
/// again: that double-counted the offset for `page > 0`.
fn build_external_page(
    issues: Vec<RemoteIssue>,
    provider: &str,
    project: &str,
    total: Option<u64>,
    provider_has_next: bool,
    query: &super::backlog::Query,
) -> wire::ExternalWorkItemPage {
    let page = query.page;
    let page_size = query.page_size.clamp(1, 100);
    let search = query.search.trim().to_lowercase();
    let status = query.status.as_deref().map(str::to_lowercase);
    let mut issues: Vec<RemoteIssue> = issues
        .into_iter()
        .filter(|issue| {
            (search.is_empty()
                || issue.title.to_lowercase().contains(&search)
                || issue.body.to_lowercase().contains(&search))
                && status
                    .as_deref()
                    .is_none_or(|wanted| issue.status == wanted)
        })
        .collect();
    issues.sort_by(|a, b| {
        let ordering = match query.sort_by.as_str() {
            "title" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
            "status" => a.status.cmp(&b.status),
            "number" => a.external_id.cmp(&b.external_id),
            _ => a.updated_at.cmp(&b.updated_at),
        };
        if query.sort_desc {
            ordering.reverse()
        } else {
            ordering
        }
    });
    // `issues` is already exactly this page (see doc comment above), so no
    // `skip(page * page_size)` is applied here.
    let items = issues
        .into_iter()
        .enumerate()
        .map(|(index, issue)| wire::ImportedWorkItem {
            item_id: format!("external:{provider}:{project}:{}", issue.external_id),
            number: (page as u64 * page_size as u64) + index as u64 + 1,
            provider: provider.to_string(),
            project: project.to_string(),
            external_id: issue.external_id,
            url: issue.url,
            title: issue.title,
            body: issue.body,
            status: issue.status,
            remote_status: Some(issue.remote_status),
            assignee: issue.assignee.clone(),
            updated_at: issue.updated_at.max(index as u64),
        })
        .take(page_size as usize)
        .collect::<Vec<_>>();
    let total = total.unwrap_or(items.len() as u64);
    let offset = (page as u64).saturating_mul(page_size as u64);
    let has_next_page = provider_has_next || offset.saturating_add(items.len() as u64) < total;
    wire::ExternalWorkItemPage {
        items,
        page,
        page_size,
        total: Some(total),
        has_next_page,
    }
}

/// Turn freshly-fetched issues into backlog items, skipping any whose external
/// id is already linked for *this project*.
///
/// Deduplication is scoped by `(provider, project, external_id)`: the same
/// GitHub issue number exists in two different repos a user tracks, and one
/// project's imported issue must never be suppressed because a *different*
/// project already linked the same external id.
///
/// `yaml_project_path` is the project's checkout directory when the configured
/// backlog backend is YAML files. Backlog item rows then land in
/// `…/.workforge/backlog/*.yaml` (project-local) instead of the SQLite
/// `backlog_items` table; tracker links always live in SQLite because they are
/// daemon-owned. Passing `None` persists to SQLite.
pub fn adopt_imported(
    store: &Store,
    project: &str,
    yaml_project_path: Option<&str>,
    fetched: Vec<(String, Vec<RemoteIssue>)>,
) -> Result<(Vec<wire::ImportedWorkItem>, Vec<wire::SyncedExternalItem>)> {
    // The same listing answers both questions, so one pass does both: an issue
    // we have never seen becomes a new item, and one we already track has its
    // status refreshed. Running import and sync as separate fetches doubled the
    // network work on every project open for no extra information.
    let known: std::collections::HashMap<(String, String, String), TrackerLink> = store
        .load_all_tracker_links()?
        .into_iter()
        .map(|link| {
            (
                (
                    link.provider.clone(),
                    link.project.clone(),
                    link.external_id.clone(),
                ),
                link,
            )
        })
        .collect();

    // A project-local item check that respects the configured backend so a YAML
    // mode never reads (or writes) the SQLite `backlog_items` shadow rows.
    let item_exists = |item_id: &str| -> Result<bool> {
        if let Some(dir) = yaml_project_path {
            Ok(super::backlog::item_exists(dir, project, item_id)?)
        } else {
            Ok(store.get_backlog_item(item_id)?.is_some())
        }
    };
    let write_item = |item: &wire::BacklogItem| -> Result<()> {
        if let Some(dir) = yaml_project_path {
            super::backlog::write(dir, item)
        } else {
            store.upsert_backlog_item(item)
        }
    };
    let update_remote = |item_id: &str, status: &str, remote_status: Option<&str>, url: &str| {
        if let Some(dir) = yaml_project_path {
            super::backlog::update(dir, project, item_id, |item| {
                item.status = status.to_string();
                item.remote_status = remote_status.map(str::to_string);
                item.url = Some(url.to_string());
                item.updated_at = crate::daemon::task::now_secs();
            })
        } else {
            store.update_backlog_remote(item_id, status, remote_status, url)
        }
    };

    let now = crate::daemon::task::now_secs();
    let mut imported = Vec::new();
    let mut next_number = store.next_backlog_number(project)?;
    let mut synced = Vec::new();
    for (provider, issues) in fetched {
        for issue in issues {
            let key = (
                provider.clone(),
                project.to_string(),
                issue.external_id.clone(),
            );
            if let Some(existing) = known.get(&key) {
                if !item_exists(&existing.item_id)? {
                    let item = wire::BacklogItem {
                        id: existing.item_id.clone(),
                        number: next_number,
                        project: project.to_string(),
                        title: issue.title.clone(),
                        body: issue.body.clone(),
                        status: issue.status.clone(),
                        priority: "none".into(),
                        source: provider.clone(),
                        external_id: Some(issue.external_id.clone()),
                        url: Some(issue.url.clone()),
                        remote_status: Some(issue.remote_status.clone()),
                        assignee: issue.assignee.clone(),
                        created_at: issue.updated_at,
                        updated_at: issue.updated_at,
                        task_id: existing.task_id.clone(),
                    };
                    write_item(&item)?;
                    imported.push(wire::ImportedWorkItem {
                        item_id: item.id,
                        number: item.number,
                        provider: provider.clone(),
                        project: item.project,
                        external_id: issue.external_id,
                        url: issue.url,
                        title: issue.title,
                        body: issue.body,
                        status: issue.status,
                        remote_status: Some(issue.remote_status),
                        assignee: issue.assignee,
                        updated_at: issue.updated_at,
                    });
                    next_number += 1;
                    continue;
                }
                if existing.status == issue.status
                    && existing.remote_status.as_deref() == Some(issue.remote_status.as_str())
                {
                    continue;
                }
                let mut link = existing.clone();
                link.status = issue.status.clone();
                link.remote_status = Some(issue.remote_status.clone());
                link.last_synced_at = now;
                store.upsert_tracker_link(&link)?;
                update_remote(
                    &link.item_id,
                    &link.status,
                    link.remote_status.as_deref(),
                    &link.url,
                )?;
                synced.push(wire::SyncedExternalItem {
                    id: link.item_id,
                    url: link.url,
                    status: issue.status,
                    remote_status: link.remote_status,
                });
                continue;
            }
            let item_id = uuid::Uuid::new_v4().to_string();
            let mut link = make_link(
                &item_id,
                &provider,
                project,
                &issue.external_id,
                &issue.url,
                true,
            );
            link.status = issue.status.clone();
            link.remote_status = Some(issue.remote_status.clone());
            link.last_synced_at = now;
            store.upsert_tracker_link(&link)?;
            write_item(&wire::BacklogItem {
                id: item_id.clone(),
                number: next_number,
                project: project.to_string(),
                title: issue.title.clone(),
                body: issue.body.clone(),
                status: issue.status.clone(),
                priority: "none".into(),
                source: provider.clone(),
                external_id: Some(issue.external_id.clone()),
                url: Some(issue.url.clone()),
                remote_status: Some(issue.remote_status.clone()),
                assignee: issue.assignee.clone(),
                created_at: issue.updated_at,
                updated_at: issue.updated_at,
                task_id: None,
            })?;
            imported.push(wire::ImportedWorkItem {
                item_id,
                number: next_number,
                provider: provider.clone(),
                project: project.to_string(),
                external_id: issue.external_id,
                url: issue.url,
                title: issue.title,
                body: issue.body,
                status: issue.status,
                remote_status: Some(issue.remote_status),
                assignee: issue.assignee.clone(),
                updated_at: issue.updated_at,
            });
            next_number += 1;
        }
    }
    Ok((imported, synced))
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

/// Pull the latest status for a set of links. Returns the updated links (with
/// fresh status) plus their wire items. Network calls run here with no store
/// borrow; the caller persists the results afterwards so the non-`Send`
/// rusqlite connection never crosses an `.await`.
///
/// `repo_dir_for` resolves a project name to its git dir (used by github links
/// only).
pub async fn fetch_links_status(
    links: &[TrackerLink],
    repo_dirs: &std::collections::HashMap<String, String>,
    linear_teams: &std::collections::HashMap<String, String>,
) -> Vec<(TrackerLink, wire::SyncedExternalItem)> {
    use std::collections::HashMap;

    // One listing per repo/team, not one lookup per item. The per-item path
    // cost two `gh` spawns each (resolve owner/repo, then read the issue), so a
    // twenty-item board meant forty subprocesses in a row.
    let mut states: HashMap<(String, String, String), (String, String)> = HashMap::new();

    let github_projects: std::collections::BTreeSet<&String> = links
        .iter()
        .filter(|link| link.provider == "github")
        .map(|link| &link.project)
        .collect();
    for project in github_projects {
        let Some(dir) = repo_dirs.get(project) else {
            continue;
        };
        match github_list_issues(dir, "all").await {
            Ok(issues) => {
                for issue in issues {
                    states.insert(
                        ("github".to_string(), project.clone(), issue.external_id),
                        (issue.status, issue.remote_status),
                    );
                }
            }
            Err(e) => eprintln!("[tracker] github sync skipped for {project}: {e:#}"),
        }
    }

    if links.iter().any(|link| link.provider == "linear") {
        // One listing per mapped team, not per link. Projects sharing a team
        // share its listing; a project with no team mapped has no Linear rows to
        // refresh, so it is simply absent here.
        let mut teams: std::collections::BTreeMap<&String, Vec<&String>> =
            std::collections::BTreeMap::new();
        for link in links.iter().filter(|link| link.provider == "linear") {
            if let Some(team_id) = linear_teams.get(&link.project) {
                teams.entry(team_id).or_default().push(&link.project);
            }
        }
        for (team_id, projects) in teams {
            match linear_list_issues(team_id).await {
                Ok(issues) => {
                    for issue in issues {
                        for project in &projects {
                            states.insert(
                                (
                                    "linear".to_string(),
                                    (*project).clone(),
                                    issue.external_id.clone(),
                                ),
                                (issue.status.clone(), issue.remote_status.clone()),
                            );
                        }
                    }
                }
                Err(e) => eprintln!("[tracker] linear sync skipped for team {team_id}: {e:#}"),
            }
        }
    }

    let now = crate::daemon::task::now_secs();
    let mut out = Vec::new();
    for link in links {
        // An issue outside the listing window (archived, or beyond the limit)
        // keeps its last-known status rather than being reported as changed.
        let Some((status, remote_status)) = states.get(&(
            link.provider.clone(),
            link.project.clone(),
            link.external_id.clone(),
        )) else {
            continue;
        };
        let mut updated = link.clone();
        updated.status = status.clone();
        updated.remote_status = Some(remote_status.clone());
        updated.last_synced_at = now;
        let item = wire::SyncedExternalItem {
            id: updated.item_id.clone(),
            url: updated.url.clone(),
            status: updated.status.clone(),
            remote_status: updated.remote_status.clone(),
        };
        out.push((updated, item));
    }
    out
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

    #[test]
    fn linear_status_mapping() {
        assert_eq!(linear_status_name("Done"), "done");
        assert_eq!(linear_status_name("Canceled"), "cancelled");
        assert_eq!(linear_status_name("In Progress"), "in_progress");
        assert_eq!(linear_status_name("Started"), "in_progress");
        assert_eq!(linear_status_name("Waiting on me"), "waiting");
        assert_eq!(linear_status_name("Todo"), "todo");
        assert_eq!(linear_status_name("Backlog"), "todo");
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

    #[test]
    fn missing_backlog_rows_can_be_recovered_from_tracker_links() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let link = make_link(
            "item-1",
            "github",
            "demo",
            "#1",
            "https://github.com/demo/1",
            true,
        );
        store.upsert_tracker_link(&link).unwrap();
        let issue = RemoteIssue {
            external_id: "#1".into(),
            title: "Recovered issue".into(),
            body: "body".into(),
            url: "https://github.com/demo/1".into(),
            status: "todo".into(),
            remote_status: "OPEN".into(),
            assignee: None,
            updated_at: 1,
        };
        let (imported, _) =
            adopt_imported(&store, "demo", None, vec![("github".into(), vec![issue])]).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(
            store.get_backlog_item("item-1").unwrap().unwrap().title,
            "Recovered issue"
        );
    }

    #[test]
    fn imported_rows_are_recovered_into_yaml_backend_not_sqlite() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let project_path = dir.path().join("checkout");
        let link = make_link(
            "item-1",
            "github",
            "demo",
            "#1",
            "https://github.com/demo/1",
            true,
        );
        store.upsert_tracker_link(&link).unwrap();
        let issue = RemoteIssue {
            external_id: "#1".into(),
            title: "Recovered in YAML".into(),
            body: "body".into(),
            url: "https://github.com/demo/1".into(),
            status: "todo".into(),
            remote_status: "OPEN".into(),
            assignee: None,
            updated_at: 1,
        };
        let (imported, _) = adopt_imported(
            &store,
            "demo",
            Some(project_path.to_str().unwrap()),
            vec![("github".into(), vec![issue])],
        )
        .unwrap();
        assert_eq!(imported.len(), 1);
        // Item is project-locally in YAML, NOT a SQLite shadow row.
        let yaml_items =
            crate::daemon::backlog::list(project_path.to_str().unwrap(), "demo").unwrap();
        assert_eq!(yaml_items.len(), 1);
        assert_eq!(yaml_items[0].title, "Recovered in YAML");
        assert!(store.get_backlog_item("item-1").unwrap().is_none());
    }

    #[test]
    fn linear_team_mapping_round_trips_and_defaults_to_unmapped() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let unmapped = store.tracker_project_settings("alpha").unwrap();
        assert_eq!(unmapped.linear_team_id, None);

        let mapped = store
            .set_tracker_project_linear_team("alpha", Some("team-1"), Some("Engineering"))
            .unwrap();
        assert_eq!(mapped.linear_team_id.as_deref(), Some("team-1"));
        assert_eq!(mapped.linear_team_name.as_deref(), Some("Engineering"));
        assert_eq!(
            store.tracker_project_settings("alpha").unwrap(),
            mapped,
            "the mapping must survive a reread"
        );
        // Another project is untouched — that is the whole point of the mapping.
        assert_eq!(
            store
                .tracker_project_settings("beta")
                .unwrap()
                .linear_team_id,
            None
        );
    }

    #[test]
    fn unmapping_linear_drops_imported_rows_but_keeps_locally_written_ones() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        let item = |id: &str, title: &str| wire::BacklogItem {
            id: id.into(),
            number: 1,
            project: "alpha".into(),
            title: title.into(),
            body: String::new(),
            status: "todo".into(),
            priority: "none".into(),
            source: "linear".into(),
            external_id: Some("ENG-1".into()),
            url: None,
            remote_status: None,
            assignee: None,
            created_at: 0,
            updated_at: 0,
            task_id: None,
        };
        for (id, title, imported) in [("mirror", "From Linear", true), ("mine", "Wrote it", false)]
        {
            store.upsert_backlog_item(&item(id, title)).unwrap();
            store
                .upsert_tracker_link(&make_link(
                    id,
                    "linear",
                    "alpha",
                    "ENG-1",
                    "https://linear.app/x",
                    imported,
                ))
                .unwrap();
        }

        assert_eq!(store.delete_imported_linear_items("alpha").unwrap(), 1);
        assert!(store.get_backlog_item("mirror").unwrap().is_none());
        assert!(
            store.get_backlog_item("mine").unwrap().is_some(),
            "an item written here and pushed to Linear is local work, not a mirror"
        );
        assert!(store.load_tracker_link("mirror").unwrap().is_none());
        assert!(store.load_tracker_link("mine").unwrap().is_some());
    }

    #[test]
    fn import_dedupe_is_project_scoped() {
        let store = Store::open_at(std::path::Path::new(":memory:")).unwrap();
        // Project "alpha" already imported github issue #1.
        let existing = TrackerLink {
            item_id: "alpha-1".into(),
            provider: "github".into(),
            project: "alpha".into(),
            external_id: "#1".into(),
            url: "https://github.com/a/r/issues/1".into(),
            status: "todo".into(),
            remote_status: Some("OPEN".into()),
            last_synced_at: 0,
            task_id: None,
            imported: true,
        };
        store.upsert_tracker_link(&existing).unwrap();
        store
            .upsert_backlog_item(&wire::BacklogItem {
                id: "alpha-1".into(),
                number: 1,
                project: "alpha".into(),
                title: "alpha issue".into(),
                body: String::new(),
                status: "todo".into(),
                priority: "none".into(),
                source: "github".into(),
                external_id: Some("#1".into()),
                url: Some("https://github.com/a/r/issues/1".into()),
                remote_status: Some("OPEN".into()),
                assignee: None,
                created_at: 1,
                updated_at: 1,
                task_id: None,
            })
            .unwrap();

        // Same provider + external_id imported into a *different* project must
        // NOT be treated as known: it is a different repo's issue #1.
        let issue = RemoteIssue {
            external_id: "#1".into(),
            title: "beta issue".into(),
            body: String::new(),
            url: "https://github.com/b/r/issues/1".into(),
            status: "todo".into(),
            remote_status: "OPEN".into(),
            assignee: None,
            updated_at: 1,
        };
        let (imported, _) =
            adopt_imported(&store, "beta", None, vec![("github".into(), vec![issue])]).unwrap();
        assert_eq!(
            imported.len(),
            1,
            "cross-project external id must not dedupe"
        );
        assert_eq!(imported[0].project, "beta");
        // And a reimport of the *same* project stays a no-op.
        let again = RemoteIssue {
            external_id: "#1".into(),
            title: "beta again".into(),
            body: String::new(),
            url: "https://github.com/b/r/issues/1".into(),
            status: "todo".into(),
            remote_status: "OPEN".into(),
            assignee: None,
            updated_at: 1,
        };
        let (second, _) =
            adopt_imported(&store, "beta", None, vec![("github".into(), vec![again])]).unwrap();
        assert_eq!(second.len(), 0, "same-project reimport must dedupe");
    }

    #[test]
    fn paginated_page_construction_offsets_once() {
        // The provider (github search / linear cursor) already returns exactly
        // this page's rows. Building the page must NOT slice again — that is
        // the double-offset bug for `page > 0`. Feed page two's server rows and
        // assert they come out verbatim, not skipped past to an empty page.
        let issues = vec![
            RemoteIssue {
                external_id: "#7".into(),
                title: "Seven".into(),
                body: String::new(),
                url: "u/7".into(),
                status: "todo".into(),
                remote_status: "open".into(),
                assignee: None,
                updated_at: 7,
            },
            RemoteIssue {
                external_id: "#8".into(),
                title: "Eight".into(),
                body: String::new(),
                url: "u/8".into(),
                status: "todo".into(),
                remote_status: "open".into(),
                assignee: None,
                updated_at: 8,
            },
        ];
        let page = build_external_page(
            issues,
            "github",
            "proj",
            Some(12), // total across all pages
            false,    // provider_has_next
            &super::super::backlog::Query {
                page: 2, // page N (0-indexed)
                page_size: 3,
                sort_by: "updated_at".into(),
                ..Default::default()
            },
        );
        assert_eq!(page.page, 2);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].external_id, "#7");
        assert_eq!(page.items[1].external_id, "#8");
        // 2*3 + 2 = 8 < 12 → more rows remain.
        assert!(page.has_next_page);
    }
}
