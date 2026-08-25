//! YAML-backed backlog storage.
//!
//! One file per item keeps writes small and makes `.workforge/backlog` useful
//! in git without merge conflicts between unrelated items.

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

use warpforge_protocol as wire;

fn dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".workforge").join("backlog")
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn list(project_path: &str, project: &str) -> Result<Vec<wire::BacklogItem>> {
    let root = dir(project_path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&root).with_context(|| format!("reading {}", root.display()))? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
            continue;
        }
        let text = fs::read_to_string(&path)?;
        let item: wire::BacklogItem =
            serde_yaml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        if item.project == project {
            items.push(item);
        }
    }
    Ok(items)
}

pub fn write(project_path: &str, item: &wire::BacklogItem) -> Result<()> {
    let root = dir(project_path);
    fs::create_dir_all(&root)?;
    let path = root.join(format!("{}.yaml", safe_id(&item.id)));
    let text = serde_yaml::to_string(item)?;
    fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// One item by id, read from its own file rather than by scanning the whole
/// directory: a sync touches every imported row, and a scan per row turns that
/// into a quadratic pile of reads.
pub fn read(project_path: &str, project: &str, item_id: &str) -> Result<Option<wire::BacklogItem>> {
    let path = dir(project_path).join(format!("{}.yaml", safe_id(item_id)));
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let item: wire::BacklogItem =
        serde_yaml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    // `safe_id` is not injective, so the file that answers to a name still has
    // to claim the id (and the project) before it is that item.
    Ok((item.id == item_id && item.project == project).then_some(item))
}

/// Whether an item with the given id exists in this project's YAML backlog.
pub fn item_exists(project_path: &str, project: &str, item_id: &str) -> Result<bool> {
    Ok(read(project_path, project, item_id)?.is_some())
}

pub fn update<F>(project_path: &str, project: &str, item_id: &str, mutate: F) -> Result<()>
where
    F: FnOnce(&mut wire::BacklogItem),
{
    let mut item = read(project_path, project, item_id)?
        .with_context(|| format!("backlog item not found: {item_id}"))?;
    mutate(&mut item);
    write(project_path, &item)
}

/// Delete an item's YAML file. Returns `false` when no such file existed (an
/// idempotent rollback helper).
pub fn remove(project_path: &str, project: &str, item_id: &str) -> Result<bool> {
    let root = dir(project_path);
    if !list(project_path, project)?
        .into_iter()
        .any(|i| i.id == item_id)
    {
        return Ok(false);
    }
    let path = root.join(format!("{}.yaml", safe_id(item_id)));
    if path.exists() {
        fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn next_number(items: &[wire::BacklogItem]) -> u64 {
    items.iter().map(|item| item.number).max().unwrap_or(0) + 1
}

/// Rank of a priority word, ascending from `none`. Sorting on the word itself
/// gives alphabetical order ("high" < "low" < "urgent"), which reads as broken.
pub fn priority_rank(priority: &str) -> u8 {
    match priority {
        "urgent" => 4,
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    }
}

/// Rank of a status word, in workflow order rather than alphabetical.
pub fn status_rank(status: &str) -> u8 {
    match status {
        "todo" => 0,
        "in_progress" => 1,
        "waiting" => 2,
        "done" => 3,
        "cancelled" => 4,
        _ => 5,
    }
}

/// The SQLite equivalents of [`priority_rank`] / [`status_rank`], so both
/// storage backends order a column the same way.
pub const PRIORITY_RANK_SQL: &str =
    "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";
pub const STATUS_RANK_SQL: &str =
    "CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 WHEN 'done' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END";

/// A locally-authored backlog item, before it gets an id and a number.
#[derive(Debug, Clone, Default)]
pub struct NewItem {
    pub project: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub priority: String,
    pub source: String,
    pub assignee: Option<String>,
}

/// An edit to an existing item. `None` means "leave this field alone", so a
/// caller that only wants to change a priority sends only that.
#[derive(Debug, Clone, Default)]
pub struct ItemPatch {
    pub item_id: String,
    pub project: String,
    pub title: Option<String>,
    pub body: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
}

impl ItemPatch {
    /// Apply the set fields to an item. The caller owns `updated_at`.
    pub fn apply(&self, item: &mut wire::BacklogItem) {
        if let Some(title) = &self.title {
            item.title = title.clone();
        }
        if let Some(body) = &self.body {
            item.body = body.clone();
        }
        if let Some(status) = &self.status {
            item.status = status.clone();
        }
        if let Some(priority) = &self.priority {
            item.priority = priority.clone();
        }
        if let Some(assignee) = &self.assignee {
            item.assignee = Some(assignee.clone());
        }
    }
}

/// One backlog listing request. Paging, ordering and every filter travel
/// together so both storage backends take — and answer — the same shape.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub page: u32,
    pub page_size: u32,
    pub sort_by: String,
    pub sort_desc: bool,
    pub search: String,
    pub status: Option<String>,
    pub source: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
}

pub fn page(mut items: Vec<wire::BacklogItem>, query: &Query) -> wire::BacklogPage {
    let search = query.search.to_lowercase();
    let assignee_needle = query
        .assignee
        .as_deref()
        .map(|value| value.trim().to_lowercase());
    items.retain(|item| {
        (search.is_empty()
            || item.title.to_lowercase().contains(&search)
            || item.body.to_lowercase().contains(&search))
            && query
                .status
                .as_deref()
                .is_none_or(|value| item.status == value)
            && query
                .source
                .as_deref()
                .is_none_or(|value| item.source == value)
            && query
                .priority
                .as_deref()
                .is_none_or(|value| item.priority == value)
            && assignee_needle.as_ref().is_none_or(|needle| {
                item.assignee
                    .as_deref()
                    .is_some_and(|value| value.to_lowercase().contains(needle))
            })
    });
    items.sort_by(|a, b| {
        let order = match query.sort_by.as_str() {
            "title" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
            "status" => status_rank(&a.status).cmp(&status_rank(&b.status)),
            "priority" => priority_rank(&a.priority).cmp(&priority_rank(&b.priority)),
            "source" => a.source.cmp(&b.source),
            "assignee" => a.assignee.cmp(&b.assignee),
            "number" => a.number.cmp(&b.number),
            _ => a.updated_at.cmp(&b.updated_at),
        };
        // Ties must break on a stable key or two pages can repeat or drop a
        // row. `id ASC` regardless of direction, matching the SQL backend.
        let order = if query.sort_desc {
            order.reverse()
        } else {
            order
        };
        order.then_with(|| a.id.cmp(&b.id))
    });
    let page = query.page;
    let page_size = query.page_size.clamp(1, 100);
    let total = items.len() as u64;
    let offset = page as usize * page_size as usize;
    let page_items = items
        .into_iter()
        .skip(offset)
        .take(page_size as usize)
        .collect::<Vec<_>>();
    wire::BacklogPage {
        items: page_items,
        page,
        page_size,
        total,
        has_next_page: offset + (page_size as usize) < total as usize,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, priority: &str, status: &str, assignee: Option<&str>) -> wire::BacklogItem {
        wire::BacklogItem {
            id: id.into(),
            number: 1,
            project: "p".into(),
            title: id.into(),
            body: String::new(),
            status: status.into(),
            priority: priority.into(),
            source: "local".into(),
            external_id: None,
            url: None,
            remote_status: None,
            assignee: assignee.map(str::to_string),
            created_at: 0,
            updated_at: 0,
            task_id: None,
        }
    }

    fn items() -> Vec<wire::BacklogItem> {
        vec![
            item("a", "low", "done", Some("Ada Lovelace")),
            item("b", "urgent", "todo", None),
            item("c", "medium", "waiting", Some("bob")),
        ]
    }

    fn query(sort_by: &str, sort_desc: bool) -> Query {
        Query {
            page: 0,
            page_size: 10,
            sort_by: sort_by.into(),
            sort_desc,
            ..Default::default()
        }
    }

    #[test]
    fn filters_by_priority() {
        let page = page(
            items(),
            &Query {
                priority: Some("urgent".into()),
                ..query("updatedAt", true)
            },
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "b");
    }

    #[test]
    fn sorts_priority_by_rank_not_alphabetically() {
        // Alphabetically this would be low < medium < urgent.
        let page = page(items(), &query("priority", true));
        let order: Vec<&str> = page.items.iter().map(|i| i.priority.as_str()).collect();
        assert_eq!(order, ["urgent", "medium", "low"]);
    }

    #[test]
    fn sorts_status_in_workflow_order() {
        let page = page(items(), &query("status", false));
        let order: Vec<&str> = page.items.iter().map(|i| i.status.as_str()).collect();
        assert_eq!(order, ["todo", "waiting", "done"]);
    }

    #[test]
    fn matches_assignee_case_insensitively_on_a_substring() {
        let page = page(
            items(),
            &Query {
                assignee: Some("ada".into()),
                ..query("updatedAt", true)
            },
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "a");
    }
}
