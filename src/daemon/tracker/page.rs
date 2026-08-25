//! The paged external listing (`workItem.list`): one provider's issues, read
//! straight from the tracker rather than from the local backlog.

use anyhow::{anyhow, bail, Result};

use warpforge_protocol as wire;

use super::{github, linear, RemoteIssue};

/// Read one page for the backlog table. The provider fetch is intentionally
/// kept separate from import: import only wants open issues, while the table
/// must be able to show closed/done issues too.
/// Only `search` and `status` of the query reach a provider; the remaining
/// backlog filters have no remote equivalent and are the local table's job.
pub async fn fetch_page(
    provider: &str,
    project: &str,
    repo_dir: Option<&str>,
    query: &crate::daemon::backlog::Query,
) -> Result<wire::ExternalWorkItemPage> {
    let page_size = query.page_size.clamp(1, 100);
    let (issues, total, provider_has_next) = match provider {
        "github" => github::github_search_issues_page(
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
            let (issues, has_next) = linear::linear_list_issues_page(query.page, page_size).await?;
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
    query: &crate::daemon::backlog::Query,
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

#[cfg(test)]
mod tests {
    use super::*;

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
                created_at: 7,
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
                created_at: 8,
                updated_at: 8,
            },
        ];
        let page = build_external_page(
            issues,
            "github",
            "proj",
            Some(12), // total across all pages
            false,    // provider_has_next
            &crate::daemon::backlog::Query {
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
