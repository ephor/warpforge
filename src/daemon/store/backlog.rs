//! Backlog items: locally-owned work, optionally mirrored to an external
//! tracker (see [`super::tracker`] for the link rows).

use anyhow::Result;
use rusqlite::OptionalExtension;

use warpforge_protocol as wire;

use super::Store;

impl Store {
    pub fn upsert_backlog_item(&self, item: &wire::BacklogItem) -> Result<()> {
        self.conn.execute(
            r#"INSERT INTO backlog_items
               (id, number, project, title, body, status, priority, source,
                external_id, url, remote_status, assignee, created_at, updated_at, task_id)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, body=excluded.body, status=excluded.status,
                 priority=excluded.priority, source=excluded.source,
                 external_id=excluded.external_id, url=excluded.url,
                 remote_status=excluded.remote_status, assignee=excluded.assignee,
                 updated_at=excluded.updated_at, task_id=excluded.task_id"#,
            rusqlite::params![
                item.id,
                item.number,
                item.project,
                item.title,
                item.body,
                item.status,
                item.priority,
                item.source,
                item.external_id,
                item.url,
                item.remote_status,
                item.assignee,
                item.created_at,
                item.updated_at,
                item.task_id,
            ],
        )?;
        Ok(())
    }

    pub fn patch_backlog_external(
        &self,
        item_id: &str,
        external_id: &str,
        url: &str,
        source: &str,
        remote_status: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET external_id=?1, url=?2, source=?3, remote_status=?4, updated_at=?5 WHERE id=?6",
            rusqlite::params![external_id, url, source, remote_status, crate::daemon::task::now_secs(), item_id],
        )?;
        Ok(())
    }

    pub fn get_backlog_item(&self, item_id: &str) -> Result<Option<wire::BacklogItem>> {
        let mut statement = self.conn.prepare("SELECT id,number,project,title,body,status,priority,source,external_id,url,remote_status,assignee,created_at,updated_at,task_id FROM backlog_items WHERE id=?1")?;
        let mut rows = statement.query_map(rusqlite::params![item_id], backlog_row)?;
        rows.next().transpose().map_err(Into::into)
    }

    pub fn link_backlog_task(&self, item_id: &str, task_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET task_id=?1, status='in_progress', updated_at=?2 WHERE id=?3",
            rusqlite::params![task_id, crate::daemon::task::now_secs(), item_id],
        )?;
        Ok(())
    }

    /// Refresh the fields a tracker owns. `updated_at` is the caller's to pass:
    /// a mirrored row carries the *issue's* last-touched time, not the moment
    /// its sync ran, and only the import path knows the difference.
    pub fn update_backlog_remote(
        &self,
        item_id: &str,
        status: &str,
        remote_status: Option<&str>,
        url: &str,
        updated_at: u64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET status=?1, remote_status=?2, url=?3, updated_at=?4 WHERE id=?5",
            rusqlite::params![status, remote_status, url, updated_at, item_id],
        )?;
        Ok(())
    }

    /// Adopt the tracker's answer for who an issue is assigned to. Separate
    /// from the update above for the same reason as `set_backlog_created_at`:
    /// a caller without the issue in hand must not be able to clear it.
    pub fn set_backlog_assignee(&self, item_id: &str, assignee: Option<&str>) -> Result<()> {
        self.conn.execute(
            // `IS NOT` rather than `<>`, so unassigned (NULL) compares equal to
            // unassigned and the row is left alone.
            "UPDATE backlog_items SET assignee=?1 WHERE id=?2 AND assignee IS NOT ?1",
            rusqlite::params![assignee, item_id],
        )?;
        Ok(())
    }

    /// Correct an imported row's creation time. Separate from the update above
    /// because `created_at` is written once and then only ever repaired — a
    /// caller that does not know the issue's real creation time must not be
    /// able to overwrite it with the time of its own sync.
    pub fn set_backlog_created_at(&self, item_id: &str, created_at: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE backlog_items SET created_at=?1 WHERE id=?2 AND created_at<>?1",
            rusqlite::params![created_at, item_id],
        )?;
        Ok(())
    }

    pub fn next_backlog_number(&self, project: &str) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(MAX(number), 0) + 1 FROM backlog_items WHERE project = ?1",
            rusqlite::params![project],
            |row| row.get(0),
        )?)
    }

    /// Delete a backlog item row (used to roll back a failed external create).
    pub fn delete_backlog_item(&self, item_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM backlog_items WHERE id = ?1",
            rusqlite::params![item_id],
        )?;
        Ok(())
    }

    /// Number of backlog item rows across all projects. Used to refuse a switch
    /// away from SQLite storage rather than silently hiding existing rows.
    pub fn count_backlog_items(&self) -> Result<u64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM backlog_items", [], |row| row.get(0))?)
    }

    pub fn list_backlog(
        &self,
        project: &str,
        query: &crate::daemon::backlog::Query,
    ) -> Result<wire::BacklogPage> {
        // `priority` and `status` are enum-valued words, so ORDER BY on the raw
        // column sorts them alphabetically ("high" before "low" before
        // "urgent") — an order nobody asked for. Sort on their rank instead.
        let sort_column = match query.sort_by.as_str() {
            "title" => "title COLLATE NOCASE",
            "status" => crate::daemon::backlog::STATUS_RANK_SQL,
            "priority" => crate::daemon::backlog::PRIORITY_RANK_SQL,
            "source" => "source",
            "assignee" => "assignee COLLATE NOCASE",
            "number" => "number",
            _ => "updated_at",
        };
        let direction = if query.sort_desc { "DESC" } else { "ASC" };
        let page = query.page;
        let page_size = query.page_size.clamp(1, 100);
        let offset = page as u64 * page_size as u64;
        let search = query.search.trim();
        let pattern = format!("%{search}%");
        let (status, source, priority) = (
            query.status.as_deref(),
            query.source.as_deref(),
            query.priority.as_deref(),
        );
        let assignee_pattern = query
            .assignee
            .as_deref()
            .map(|value| format!("%{}%", value.trim()));
        let where_sql = "project = ?1 AND (?2 = '' OR title LIKE ?3 OR body LIKE ?3)\
                         AND (?4 IS NULL OR status = ?4)\
                         AND (?5 IS NULL OR source = ?5)\
                         AND (?6 IS NULL OR priority = ?6)\
                         AND (?7 IS NULL OR assignee LIKE ?7)";
        let count: u64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM backlog_items WHERE {where_sql}"),
            rusqlite::params![
                project,
                search,
                pattern,
                status,
                source,
                priority,
                assignee_pattern
            ],
            |row| row.get(0),
        )?;
        let sql = format!(
            "SELECT id,number,project,title,body,status,priority,source,external_id,url,remote_status,assignee,created_at,updated_at,task_id FROM backlog_items WHERE {where_sql} ORDER BY {sort_column} {direction}, id ASC LIMIT ?8 OFFSET ?9"
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(
            rusqlite::params![
                project,
                search,
                pattern,
                status,
                source,
                priority,
                assignee_pattern,
                page_size,
                offset
            ],
            backlog_row,
        )?;
        let items: Vec<wire::BacklogItem> = rows.collect::<std::result::Result<_, _>>()?;
        Ok(wire::BacklogPage {
            items,
            page,
            page_size,
            total: count,
            has_next_page: offset + (page_size as u64) < count,
        })
    }

    pub fn set_backlog_storage_mode(&self, mode: wire::BacklogStorageMode) -> Result<()> {
        let value = serde_json::to_string(&mode)?;
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS backlog_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)",
            [],
        )?;
        self.conn.execute(
            "INSERT INTO backlog_settings(id, mode) VALUES(1, ?1) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode",
            rusqlite::params![value.trim_matches('"')],
        )?;
        Ok(())
    }

    pub fn backlog_storage_mode(&self) -> Result<wire::BacklogStorageMode> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS backlog_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)",
            [],
        )?;
        let mode: Option<String> = self
            .conn
            .query_row("SELECT mode FROM backlog_settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(match mode.as_deref() {
            Some("yaml") => wire::BacklogStorageMode::Yaml,
            _ => wire::BacklogStorageMode::Sqlite,
        })
    }
}

fn backlog_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<wire::BacklogItem> {
    Ok(wire::BacklogItem {
        id: row.get(0)?,
        number: row.get(1)?,
        project: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        status: row.get(5)?,
        priority: row.get(6)?,
        source: row.get(7)?,
        external_id: row.get(8)?,
        url: row.get(9)?,
        remote_status: row.get(10)?,
        assignee: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        task_id: row.get(14)?,
    })
}
