//! Linear: API key storage plus the GraphQL calls the backlog needs.
//!
//! The key lives in the macOS keychain (mirroring the Claude credential pattern
//! in `claude_auth`); every call goes over reqwest with it.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

use warpforge_protocol as wire;

use super::{normalize_status, rfc3339_secs, RemoteIssue, IMPORT_LIMIT, NETWORK_TIMEOUT};

const LINEAR_API: &str = "https://api.linear.app/graphql";
const KEYCHAIN_SERVICE: &str = "warpforge-linear";

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

pub(super) fn keychain_write(secret: &str) -> Result<()> {
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

pub(super) fn keychain_delete() -> Result<()> {
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
pub(super) async fn linear_identity(key: &str) -> Result<(String, String)> {
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
pub(super) async fn linear_create_issue(
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

pub(super) async fn first_team_id() -> Result<String> {
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

/// Map a Linear state name to the normalized warpforge status. A team's states
/// are freely named, so an unrecognized one reads as untouched work rather
/// than failing the import.
fn linear_status_name(state: &str) -> String {
    normalize_status(state).unwrap_or("todo").to_string()
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
    created_at: Option<String>,
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
pub(super) async fn linear_list_issues(team_id: &str) -> Result<Vec<RemoteIssue>> {
    let req = serde_json::json!({
        // `assignee` is asked for here as well as in the paged query below: the
        // mapping has always read it, so omitting it from the import query is
        // what left every imported issue unassigned.
        "query": "query TeamIssues($teamId: String!, $first: Int!) { \
                  team(id: $teamId) { issues(first: $first) { nodes { \
                  identifier title description url createdAt updatedAt state { name } \
                  assignee { name displayName } } } } }",
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
                created_at: node.created_at.as_deref().map(rfc3339_secs).unwrap_or(0),
                updated_at: node.updated_at.as_deref().map(rfc3339_secs).unwrap_or(0),
            }
        })
        .collect())
}

/// Cursor-based Linear pagination. We advance cursors until requested page;
/// Linear does not support numeric offsets, so this is the provider-correct
/// equivalent of `page=N`.
pub(super) async fn linear_list_issues_page(
    page: u32,
    page_size: u32,
) -> Result<(Vec<RemoteIssue>, bool)> {
    let team_id = first_team_id().await?;
    let mut cursor: Option<String> = None;
    let mut current = Vec::new();
    let mut has_next = false;
    for _ in 0..=page {
        let req = serde_json::json!({
            "query": "query TeamIssues($teamId: String!, $first: Int!, $after: String) { team(id: $teamId) { issues(first: $first, after: $after) { nodes { identifier title description url createdAt updatedAt state { name } assignee { name displayName } } pageInfo { hasNextPage endCursor } } } }",
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
                    created_at: node.created_at.as_deref().map(rfc3339_secs).unwrap_or(0),
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
}
