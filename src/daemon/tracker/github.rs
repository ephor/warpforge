//! GitHub, through the user's `gh` CLI session (already required for PRs in
//! `diff`).
//!
//! Status comes from the issue's Projects V2 board column, so the listing is a
//! GraphQL query rather than `gh issue list`; the CLI listing remains as the
//! fallback for a token without the `project` scope.

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;

use super::{normalize_status, rfc3339_secs, RemoteIssue, IMPORT_LIMIT, NETWORK_TIMEOUT};

/// Run `gh` with args in the given repo dir (None = anywhere / current dir).
///
/// Bounded: a network call that never returns must not be able to hold a
/// request open, and `gh` can hang on a stalled connection.
pub(super) async fn gh(repo: Option<&str>, args: &[&str]) -> Result<std::process::Output> {
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
pub(crate) async fn github_owner_repo(repo_dir: &str) -> Result<(String, String)> {
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

/// The normalized status of a GitHub issue.
///
/// A closed issue is finished work whatever a board says, so its state decides;
/// `NOT_PLANNED` is the closest thing GitHub has to "cancelled". An open issue
/// takes the status from its Projects V2 board column, which is where GitHub
/// users actually track progress — an unrecognized column name leaves it as
/// untouched work rather than guessing.
fn github_status(state: &str, state_reason: Option<&str>, board_column: Option<&str>) -> String {
    if state.eq_ignore_ascii_case("closed") {
        return if state_reason.is_some_and(|reason| reason.eq_ignore_ascii_case("not_planned")) {
            "cancelled"
        } else {
            "done"
        }
        .to_string();
    }
    board_column
        .and_then(normalize_status)
        .unwrap_or("todo")
        .to_string()
}

/// List the repo's issues with the board column each one sits in.
///
/// GitHub's own status vocabulary is only open/closed; the status a team reads
/// off a repo lives in a Projects V2 "Status" field, and only GraphQL can
/// answer for it. A token without the `project` scope (or a host that has no
/// projects) falls back to [`github_rest_issues`], which is the same listing
/// with open/closed as the status.
pub(super) async fn github_list_issues(repo_dir: &str, state: &str) -> Result<Vec<RemoteIssue>> {
    match github_project_issues(repo_dir, state).await {
        Ok(issues) => Ok(issues),
        Err(e) => {
            eprintln!("[tracker] github board statuses unavailable ({e:#}); using open/closed");
            github_rest_issues(repo_dir, state).await
        }
    }
}

/// The issue listing query. `state` is `open` for import (a closed issue is not
/// backlog) and anything else for sync (an item on the board may since have
/// been closed).
///
/// The state filter is interpolated rather than passed as a variable: `gh`
/// sends every `-f` as a string and the field takes a list of enums. Both
/// values are ours, not a caller's, so there is nothing to inject.
fn project_issues_query(state: &str) -> String {
    let states = if state.eq_ignore_ascii_case("open") {
        "[OPEN]"
    } else {
        "[OPEN, CLOSED]"
    };
    format!(
        "query($owner: String!, $repo: String!, $first: Int!) {{ \
           repository(owner: $owner, name: $repo) {{ \
             issues(first: $first, states: {states}, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ \
               nodes {{ number title body url state stateReason createdAt updatedAt \
                 assignees(first: 1) {{ nodes {{ login }} }} \
                 projectItems(first: 5, includeArchived: false) {{ nodes {{ \
                   fieldValueByName(name: \"Status\") {{ \
                     ... on ProjectV2ItemFieldSingleSelectValue {{ name }} }} }} }} }} }} }} }}"
    )
}

/// The GraphQL listing: issues plus their Projects V2 "Status" field.
async fn github_project_issues(repo_dir: &str, state: &str) -> Result<Vec<RemoteIssue>> {
    let (owner, repo) = github_owner_repo(repo_dir).await?;
    // The state filter is interpolated rather than passed as a variable: `gh`
    // sends every `-f` as a string and the field takes a list of enums. The two
    // values are ours, not the caller's, so there is nothing to inject.
    let query_arg = format!("query={}", project_issues_query(state));
    let owner_arg = format!("owner={owner}");
    let repo_arg = format!("repo={repo}");
    let first_arg = format!("first={IMPORT_LIMIT}");
    let out = gh(
        Some(repo_dir),
        &[
            "api", "graphql", "-f", &query_arg, "-F", &owner_arg, "-F", &repo_arg, "-F", &first_arg,
        ],
    )
    .await?;
    if !out.status.success() {
        bail!(
            "GitHub issue query failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let payload: serde_json::Value =
        serde_json::from_slice(&out.stdout).context("parsing GitHub issue query")?;
    let nodes = payload
        .pointer("/data/repository/issues/nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("GitHub issue query returned no issues"))?;
    Ok(nodes
        .iter()
        .filter_map(|issue| {
            let number = issue.get("number")?.as_u64()?;
            let text = |key: &str| {
                issue
                    .get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            let state = issue
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("OPEN");
            let column = board_column(issue);
            Some(RemoteIssue {
                external_id: format!("#{number}"),
                title: text("title"),
                body: text("body"),
                url: text("url"),
                status: github_status(
                    state,
                    issue.get("stateReason").and_then(|v| v.as_str()),
                    column.as_deref(),
                ),
                // The board column is what the team sees on GitHub, so that is
                // the label to show; without one there is only open/closed.
                remote_status: column.unwrap_or_else(|| state.to_string()),
                assignee: issue
                    .pointer("/assignees/nodes")
                    .and_then(|v| v.as_array())
                    .and_then(|nodes| nodes.first())
                    .and_then(|node| node.get("login"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                created_at: rfc3339_secs(&text("createdAt")),
                updated_at: rfc3339_secs(&text("updatedAt")),
            })
        })
        .collect())
}

/// The issue's Projects V2 "Status" column. An issue can sit on several boards;
/// the first one that has a Status value answers, because a project without
/// that field says nothing about the work.
fn board_column(issue: &serde_json::Value) -> Option<String> {
    issue
        .pointer("/projectItems/nodes")?
        .as_array()?
        .iter()
        .find_map(|item| {
            item.pointer("/fieldValueByName/name")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
}

/// The `gh issue list` fallback. Pull requests are excluded: `gh issue list`
/// already filters them out, unlike the REST issues endpoint.
///
/// `state` is `open` for import (a closed issue is not backlog) and `all` for
/// sync (an item on the board may since have been closed).
async fn github_rest_issues(repo_dir: &str, state: &str) -> Result<Vec<RemoteIssue>> {
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
            "number,title,body,state,createdAt,updatedAt,url,assignees",
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
                status: github_status(
                    state,
                    issue.get("stateReason").and_then(|v| v.as_str()),
                    None,
                ),
                remote_status: state.to_string(),
                assignee: assignee_login(issue.get("assignees"), issue.get("assignee")),
                created_at: issue
                    .get("createdAt")
                    .and_then(|u| u.as_str())
                    .map(rfc3339_secs)
                    .unwrap_or(0),
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
pub(super) async fn github_search_issues_page(
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
                status: github_status(
                    native_state,
                    issue.get("state_reason").and_then(|v| v.as_str()),
                    None,
                ),
                remote_status: native_state.into(),
                assignee: assignee_login(issue.get("assignees"), issue.get("assignee")),
                created_at: issue
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .map(rfc3339_secs)
                    .unwrap_or_default(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_issue_is_finished_whatever_the_board_says() {
        assert_eq!(github_status("CLOSED", None, Some("In Progress")), "done");
        assert_eq!(github_status("CLOSED", Some("COMPLETED"), None), "done");
        assert_eq!(
            github_status("CLOSED", Some("NOT_PLANNED"), None),
            "cancelled"
        );
    }

    #[test]
    fn an_open_issue_takes_its_status_from_the_board() {
        assert_eq!(
            github_status("OPEN", None, Some("In Progress")),
            "in_progress"
        );
        assert_eq!(github_status("OPEN", None, Some("Done")), "done");
        // No board, or a column this vocabulary cannot place, reads as
        // untouched work rather than a guess.
        assert_eq!(github_status("OPEN", None, None), "todo");
        assert_eq!(github_status("OPEN", None, Some("Icebox")), "todo");
    }

    #[test]
    fn the_board_column_is_the_first_project_that_has_a_status_field() {
        let issue = serde_json::json!({
            "projectItems": { "nodes": [
                { "fieldValueByName": null },
                { "fieldValueByName": { "name": "In Test" } },
            ]}
        });
        assert_eq!(board_column(&issue).as_deref(), Some("In Test"));
        assert_eq!(board_column(&serde_json::json!({})), None);
    }

    #[test]
    fn the_issue_query_asks_for_the_status_field_and_scopes_by_state() {
        let import = project_issues_query("open");
        assert!(import.contains("states: [OPEN]"), "{import}");
        assert!(
            project_issues_query("all").contains("states: [OPEN, CLOSED]"),
            "sync must see issues that were closed since"
        );
        assert!(
            import.contains("fieldValueByName(name: \"Status\")"),
            "{import}"
        );
    }
}
