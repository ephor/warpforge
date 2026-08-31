//! Backlog-item to external-tracker-issue links, and the per-project tracker
//! mapping they are read through.

use anyhow::Result;
use rusqlite::OptionalExtension;

use warpforge_protocol as wire;

use super::Store;

/// A persisted backlog-item ↔ external-tracker-issue link. This is what keeps
/// the desktop's backlog table in sync with GitHub/Linear without the daemon
/// owning the items themselves (they still live in zustand/localStorage).
#[derive(Debug, Clone, PartialEq)]
pub struct TrackerLink {
    pub item_id: String,
    pub provider: String,
    pub project: String,
    pub external_id: String,
    pub url: String,
    pub status: String,
    pub remote_status: Option<String>,
    pub last_synced_at: u64,
    pub task_id: Option<String>,
    /// True when `adopt_imported` minted this link from a tracker listing, as
    /// opposed to an item written here and pushed out. Only imported rows are
    /// eligible for the purge that follows a mapping change.
    pub imported: bool,
}

impl TrackerLink {
    pub fn to_wire(&self) -> wire::TrackerLinkInfo {
        wire::TrackerLinkInfo {
            item_id: self.item_id.clone(),
            provider: self.provider.clone(),
            external_id: self.external_id.clone(),
            url: self.url.clone(),
            status: self.status.clone(),
            remote_status: self.remote_status.clone(),
            last_synced_at: self.last_synced_at,
            task_id: self.task_id.clone(),
        }
    }
}

impl Store {
    pub fn upsert_tracker_link(&self, link: &TrackerLink) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO tracker_links
                (item_id, provider, project, external_id, url, status, remote_status,
                 last_synced_at, task_id, imported)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
            ON CONFLICT(item_id) DO UPDATE SET
                provider=excluded.provider,
                project=excluded.project,
                external_id=excluded.external_id,
                url=excluded.url,
                status=excluded.status,
                remote_status=excluded.remote_status,
                last_synced_at=excluded.last_synced_at,
                task_id=excluded.task_id,
                imported=excluded.imported
            "#,
            rusqlite::params![
                link.item_id,
                link.provider,
                link.project,
                link.external_id,
                link.url,
                link.status,
                link.remote_status,
                link.last_synced_at,
                link.task_id,
                link.imported,
            ],
        )?;
        Ok(())
    }

    pub fn load_tracker_link(&self, item_id: &str) -> Result<Option<TrackerLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_id, provider, project, external_id, url, status, remote_status, \
             last_synced_at, task_id, imported FROM tracker_links WHERE item_id = ?1",
        )?;
        let mut rows = stmt.query_map(rusqlite::params![item_id], |row| {
            Ok(TrackerLink {
                item_id: row.get(0)?,
                provider: row.get(1)?,
                project: row.get(2)?,
                external_id: row.get(3)?,
                url: row.get(4)?,
                status: row.get(5)?,
                remote_status: row.get(6)?,
                last_synced_at: row.get::<_, u64>(7)?,
                task_id: row.get(8)?,
                imported: row.get::<_, i64>(9)? != 0,
            })
        })?;
        rows.next().transpose().map_err(Into::into)
    }

    pub fn load_all_tracker_links(&self) -> Result<Vec<TrackerLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_id, provider, project, external_id, url, status, remote_status, \
             last_synced_at, task_id, imported FROM tracker_links ORDER BY last_synced_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TrackerLink {
                item_id: row.get(0)?,
                provider: row.get(1)?,
                project: row.get(2)?,
                external_id: row.get(3)?,
                url: row.get(4)?,
                status: row.get(5)?,
                remote_status: row.get(6)?,
                last_synced_at: row.get::<_, u64>(7)?,
                task_id: row.get(8)?,
                imported: row.get::<_, i64>(9)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn tracker_project_settings(&self, project: &str) -> Result<wire::TrackerProjectSettings> {
        let found = self
            .conn
            .query_row(
                "SELECT linear_team_id, linear_team_name FROM tracker_project_settings \
                 WHERE project = ?1",
                rusqlite::params![project],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let (linear_team_id, linear_team_name) = found.unwrap_or((None, None));
        Ok(wire::TrackerProjectSettings {
            project: project.to_string(),
            linear_team_id,
            linear_team_name,
        })
    }

    pub fn set_tracker_project_linear_team(
        &self,
        project: &str,
        team_id: Option<&str>,
        team_name: Option<&str>,
    ) -> Result<wire::TrackerProjectSettings> {
        self.conn.execute(
            "INSERT INTO tracker_project_settings(project, linear_team_id, linear_team_name) \
             VALUES(?1, ?2, ?3) ON CONFLICT(project) DO UPDATE SET \
             linear_team_id = excluded.linear_team_id, \
             linear_team_name = excluded.linear_team_name",
            rusqlite::params![project, team_id, team_name],
        )?;
        self.tracker_project_settings(project)
    }

    /// Drop the rows a *previous* Linear mapping imported into one project, when
    /// that mapping changes or is removed: they mirror a team this project is no
    /// longer reading, so keeping them means a backlog of other people's work
    /// with nothing to say where it came from. Returns how many went.
    ///
    /// Only rows `adopt_imported` created (`imported = 1`) are eligible. An item
    /// somebody wrote here and pushed to Linear also carries a link, and its
    /// title, body and priority are local-only — deleting that would lose work.
    pub fn delete_imported_linear_items(&self, project: &str) -> Result<usize> {
        let item_ids: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT item_id FROM tracker_links \
                 WHERE provider = 'linear' AND project = ?1 AND imported = 1",
            )?;
            let rows = stmt.query_map(rusqlite::params![project], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for item_id in &item_ids {
            self.conn.execute(
                "DELETE FROM backlog_items WHERE id = ?1",
                rusqlite::params![item_id],
            )?;
            self.conn.execute(
                "DELETE FROM tracker_links WHERE item_id = ?1",
                rusqlite::params![item_id],
            )?;
        }
        Ok(item_ids.len())
    }

    pub fn delete_tracker_link(&self, item_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM tracker_links WHERE item_id = ?1",
            rusqlite::params![item_id],
        )?;
        Ok(())
    }

    /// Link a daemon task to a backlog item (also called when the item was
    /// created locally without an external tracker).
    pub fn set_tracker_link_task(&self, item_id: &str, task_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tracker_links SET task_id = ?1 WHERE item_id = ?2",
            rusqlite::params![task_id, item_id],
        )?;
        Ok(())
    }
}
