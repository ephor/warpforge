//! GitHub, through the user's `gh` CLI session (already required for PRs in
//! `diff`).

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;

use super::{rfc3339_secs, RemoteIssue, IMPORT_LIMIT, NETWORK_TIMEOUT};

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

/// List the repo's issues. Pull requests are excluded: `gh issue list` already
/// filters them out, unlike the REST issues endpoint.
///
/// `state` is `open` for import (a closed issue is not backlog) and `all` for
/// sync (an item on the board may since have been closed).
pub(super) async fn github_list_issues(repo_dir: &str, state: &str) -> Result<Vec<RemoteIssue>> {
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
                // GitHub has no status vocabulary beyond open/closed; the
                // native label is surfaced as-is and never written back.
                status: if state.eq_ignore_ascii_case("closed") {
                    "done".into()
                } else {
                    "todo".into()
                },
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
                status: if native_state.eq_ignore_ascii_case("closed") {
                    "done"
                } else {
                    "todo"
                }
                .into(),
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
