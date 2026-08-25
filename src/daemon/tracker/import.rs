//! Import and sync: one tracker listing, adopted into the backlog.
//!
//! Import and sync are the same fetch (ADR-0002): the listing that finds issues
//! warpforge has never seen also refreshes the ones it already tracks.

use anyhow::{anyhow, Context, Result};

use warpforge_protocol as wire;

use super::super::store::{Store, TrackerLink};
use super::{github, linear, make_link, RemoteIssue};

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
        let issues = github::github_list_issues(dir, "open")
            .await
            .context("GitHub import failed")?;
        out.push(("github".to_string(), issues));
    }
    if wants("linear") && linear::keychain_read().is_some() {
        match linear_team_id {
            Some(team_id) => {
                let issues = linear::linear_list_issues(team_id)
                    .await
                    .context("Linear import failed")?;
                out.push(("linear".to_string(), issues));
            }
            None => eprintln!("[tracker] skipping Linear import: no team mapped to project"),
        }
    }
    Ok(out)
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
            Ok(crate::daemon::backlog::item_exists(dir, project, item_id)?)
        } else {
            Ok(store.get_backlog_item(item_id)?.is_some())
        }
    };
    let write_item = |item: &wire::BacklogItem| -> Result<()> {
        if let Some(dir) = yaml_project_path {
            crate::daemon::backlog::write(dir, item)
        } else {
            store.upsert_backlog_item(item)
        }
    };
    let update_remote = |item_id: &str, status: &str, remote_status: Option<&str>, url: &str| {
        if let Some(dir) = yaml_project_path {
            crate::daemon::backlog::update(dir, project, item_id, |item| {
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
        match github::github_list_issues(dir, "all").await {
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
            match linear::linear_list_issues(team_id).await {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
