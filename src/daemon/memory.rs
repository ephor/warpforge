//! Shared memory: durable cross-session facts/decisions/preferences searchable
//! by every harness (Claude, Codex, opencode). FTS5-only in v1 — no embeddings,
//! no vectors, no dreaming execution. The store owns its own connection to
//! `~/.warpforge/memory.db`, isolated from the main warpforge DB, and is only
//! touched from the daemon actor thread (same single-threaded-access rationale
//! as `store.rs`).
//!
//! `memories_fts` is a regular FTS5 table (not external-content) because FTS5
//! requires an integer rowid while `memories.id` is a TEXT uuid: the uuid is
//! kept as an `UNINDEXED` column and rows are kept in sync with plain
//! INSERT/DELETE statements keyed on that id.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::memory_config::MemoryConfig;
use super::memory_types::{Memory, ScopesEnabled, Stats};
use super::task::now_secs;

pub use super::memory_types::MemoryError;

// ── Store ──

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
    id             TEXT PRIMARY KEY,
    project_id     TEXT,
    scope          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    content        TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_accessed  INTEGER NOT NULL,
    created_by     TEXT,
    superseded_by  TEXT,
    tags           TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED, content, tokenize='porter');
CREATE TABLE IF NOT EXISTS memory_compaction_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_type  TEXT,
    target_ids     TEXT,
    reason         TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','applied','rejected')),
    created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"#;

pub struct MemoryStore {
    conn: Option<Connection>,
    config: MemoryConfig,
    disabled: Option<String>,
}

fn seed_meta(conn: &Connection) -> Result<()> {
    for (key, value) in [
        ("embedding_model", "none"),
        ("dims", "0"),
        ("schema_version", "1"),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

impl MemoryStore {
    fn default_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".warpforge")
            .join("memory.db")
    }

    /// Open (creating if needed) the default memory database.
    pub fn open() -> Result<Self> {
        let path = Self::default_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        Self::open_at(&path)
    }

    /// Open at an explicit path (":memory:" works — used by tests).
    pub fn open_at(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        seed_meta(&conn)?;
        Ok(Self {
            conn: Some(conn),
            config: MemoryConfig::default(),
            disabled: None,
        })
    }

    /// Load config and open the store. Never fails: a disabled or unopenable
    /// store is represented as a `disabled` flag so the daemon stays up and the
    /// memory tools report "memory disabled" instead of crashing.
    pub fn load() -> Self {
        let config = MemoryConfig::load();
        if !config.enabled {
            return Self {
                conn: None,
                config,
                disabled: Some("memory disabled".into()),
            };
        }
        match Self::open() {
            Ok(mut store) => {
                store.config = config;
                store
            }
            Err(e) => Self {
                conn: None,
                config,
                disabled: Some(format!("memory disabled: {e}")),
            },
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled && self.disabled.is_none() && self.conn.is_some()
    }

    fn guard(&self) -> Result<&Connection, MemoryError> {
        if let Some(reason) = &self.disabled {
            return Err(MemoryError::Disabled(reason.clone()));
        }
        self.conn
            .as_ref()
            .ok_or_else(|| MemoryError::Disabled("memory disabled".into()))
    }

    fn resolve_write_scope(
        &self,
        scope: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<String, MemoryError> {
        if let Some(s) = scope {
            if s == "global" {
                if !self.config.global {
                    return Err(MemoryError::Scope("global memory is disabled".into()));
                }
                return Ok("global".into());
            }
            if s.starts_with("session") {
                return Err(MemoryError::Scope(
                    "session-scoped memory is not supported in v1".into(),
                ));
            }
        }
        if let Some(pid) = project_id {
            if !self.config.project {
                return Err(MemoryError::Scope(
                    "project-scoped memory is disabled; enable memory.project".into(),
                ));
            }
            return Ok(format!("project:{pid}"));
        }
        if !self.config.global {
            return Err(MemoryError::Scope("global memory is disabled".into()));
        }
        Ok("global".into())
    }

    /// SQL condition (`m.`-prefixed) narrowing a read to the enabled scope(s).
    /// "global"/"project" narrow to that scope when enabled; a disabled or
    /// unknown scope silently coerces to the enabled union. Empty = no filter.
    fn scope_predicate(&self, scope: Option<&str>) -> String {
        let (want_global, want_project) = match scope {
            Some("global") => (true, false),
            Some("project") => (false, true),
            _ => (true, true),
        };
        let mut g = want_global && self.config.global;
        let mut p = want_project && self.config.project;
        if !g && !p {
            g = self.config.global;
            p = self.config.project;
        }
        match (g, p) {
            (true, true) => String::new(),
            (true, false) => "m.scope = 'global'".into(),
            (false, true) => "m.scope LIKE 'project:%'".into(),
            (false, false) => "0".into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn store(
        &self,
        content: &str,
        scope: Option<&str>,
        kind: Option<&str>,
        tags: Option<&[String]>,
        project_id: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<Memory, MemoryError> {
        let conn = self.guard()?;
        let project_id = project_id
            .filter(|p| !p.trim().is_empty())
            .map(str::to_string);
        let scope = self.resolve_write_scope(scope, project_id.as_deref())?;
        let kind = clamp_kind(kind);
        let tags = tags.unwrap_or(&[]).to_vec();
        let tags_json = serde_json::to_string(&tags)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_secs() as i64;
        conn.execute(
            "INSERT INTO memories \
             (id, project_id, scope, kind, content, created_at, updated_at, \
              last_accessed, created_by, superseded_by, tags) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                id,
                project_id,
                scope,
                kind,
                content,
                now,
                now,
                now,
                created_by,
                None::<String>,
                tags_json
            ],
        )?;
        conn.execute(
            "INSERT INTO memories_fts (id, content) VALUES (?1, ?2)",
            params![id, content],
        )?;
        load_by_id(conn, &id)
    }

    /// Full-text search over memories, BM25-ranked. `mode` is accepted for
    /// forward compatibility but v1 is FTS-only, so "hybrid" behaves exactly
    /// like "fts". Every returned hit bumps `last_accessed` (feeds future decay).
    pub fn search(
        &self,
        query: &str,
        scope: Option<&str>,
        limit: Option<u32>,
        _mode: Option<&str>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let conn = self.guard()?;
        let sanitized = sanitize_query(query);
        if sanitized.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.unwrap_or(10).clamp(1, 100) as i64;
        let predicate = self.scope_predicate(scope);
        let where_sql = if predicate.is_empty() {
            "memories_fts MATCH ?1".to_string()
        } else {
            format!("memories_fts MATCH ?1 AND {predicate}")
        };
        let sql = format!(
            "SELECT m.id, m.project_id, m.scope, m.kind, m.content, m.created_at, \
                    m.updated_at, m.last_accessed, m.created_by, m.superseded_by, m.tags, \
                    snippet(memories_fts, 1, '<b>', '</b>', '...', 12) \
             FROM memories m JOIN memories_fts ON memories_fts.id = m.id \
             WHERE {where_sql} \
             ORDER BY (m.scope = 'global') ASC, rank LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![sanitized, limit], |row| {
            let snippet: Option<String> = row.get(11)?;
            row_to_memory(row, snippet)
        })?;
        let mut results = Vec::new();
        for row in rows {
            let mut mem = row?;
            let now = now_secs() as i64;
            conn.execute(
                "UPDATE memories SET last_accessed = ?1 WHERE id = ?2",
                params![now, mem.id],
            )?;
            mem.last_accessed = now;
            results.push(mem);
        }
        Ok(results)
    }

    pub fn list(
        &self,
        scope: Option<&str>,
        kind: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let conn = self.guard()?;
        let mut conditions = Vec::new();
        let predicate = self.scope_predicate(scope);
        if !predicate.is_empty() {
            conditions.push(predicate);
        }
        if let Some(k) = kind.and_then(valid_kind) {
            conditions.push(format!("m.kind = '{k}'"));
        }
        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let limit = limit.unwrap_or(100).clamp(1, 1000) as i64;
        let offset = offset.unwrap_or(0) as i64;
        let sql = format!(
            "SELECT id, project_id, scope, kind, content, created_at, updated_at, \
                    last_accessed, created_by, superseded_by, tags \
             FROM memories m {where_sql} \
             ORDER BY (m.scope = 'global') ASC, m.updated_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], |row| row_to_memory(row, None))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    pub fn update(&self, id: &str, content: &str) -> Result<Memory, MemoryError> {
        let conn = self.guard()?;
        let existing = content_of(conn, id)?;
        if existing.is_none() {
            return Err(MemoryError::Other(anyhow::anyhow!(
                "memory '{id}' not found"
            )));
        }
        let now = now_secs() as i64;
        conn.execute(
            "UPDATE memories SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![content, now, id],
        )?;
        conn.execute("DELETE FROM memories_fts WHERE id = ?1", params![id])?;
        conn.execute(
            "INSERT INTO memories_fts (id, content) VALUES (?1, ?2)",
            params![id, content],
        )?;
        load_by_id(conn, id)
    }

    pub fn delete(&self, id: &str) -> Result<(), MemoryError> {
        let conn = self.guard()?;
        let existing = content_of(conn, id)?;
        if existing.is_none() {
            return Err(MemoryError::Other(anyhow::anyhow!(
                "memory '{id}' not found"
            )));
        }
        conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM memories_fts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn stats(&self) -> Result<Stats, MemoryError> {
        let conn = self.guard()?;
        let global_count = conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE scope = 'global'",
            [],
            |row| row.get(0),
        )?;
        let project_count = conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE scope LIKE 'project:%'",
            [],
            |row| row.get(0),
        )?;
        Ok(Stats {
            global_count,
            project_count,
            embedding_mode: "fts".into(),
            scopes_enabled: ScopesEnabled {
                global: self.config.global,
                project: self.config.project,
            },
        })
    }
}

// ── Helpers ──

const KINDS: &[&str] = &["fact", "decision", "preference", "gotcha", "note"];

fn valid_kind(kind: &str) -> Option<&str> {
    KINDS.iter().copied().find(|k| *k == kind)
}

fn clamp_kind(kind: Option<&str>) -> String {
    kind.and_then(valid_kind).unwrap_or("note").to_string()
}

/// Strip FTS5 query metacharacters so arbitrary user text cannot throw a MATCH
/// syntax error. An empty result after sanitization means "no query".
fn sanitize_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for ch in query.chars() {
        match ch {
            '"' | '*' | ':' | '(' | ')' | '^' | '&' | '|' | '-' => out.push(' '),
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn content_of(conn: &Connection, id: &str) -> Result<Option<String>, MemoryError> {
    Ok(conn
        .query_row(
            "SELECT content FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?)
}

fn load_by_id(conn: &Connection, id: &str) -> Result<Memory, MemoryError> {
    Ok(conn.query_row(
        "SELECT id, project_id, scope, kind, content, created_at, updated_at, \
                last_accessed, created_by, superseded_by, tags \
         FROM memories WHERE id = ?1",
        params![id],
        |row| row_to_memory(row, None),
    )?)
}

fn row_to_memory(row: &rusqlite::Row<'_>, snippet: Option<String>) -> rusqlite::Result<Memory> {
    let tags_json: String = row.get(10)?;
    Ok(Memory {
        id: row.get(0)?,
        project_id: row.get(1)?,
        scope: row.get(2)?,
        kind: row.get(3)?,
        content: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        last_accessed: row.get(7)?,
        created_by: row.get(8)?,
        superseded_by: row.get(9)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        snippet,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> MemoryStore {
        MemoryStore::open_at(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn roundtrip_store_search_list_update_delete_stats() {
        let store = open();
        let m = store
            .store(
                "the api listens on port 8080",
                None,
                Some("fact"),
                Some(&["infra".to_string()]),
                None,
                None,
            )
            .unwrap();
        assert_eq!(m.scope, "global");
        assert_eq!(m.kind, "fact");
        assert_eq!(m.tags, vec!["infra".to_string()]);

        let hits = store.search("api", None, None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, m.id);

        let listed = store.list(None, Some("fact"), None, None).unwrap();
        assert_eq!(listed.len(), 1);

        let updated = store.update(&m.id, "the api listens on port 9090").unwrap();
        assert_eq!(updated.content, "the api listens on port 9090");
        assert!(store.search("8080", None, None, None).unwrap().is_empty());
        assert_eq!(store.search("9090", None, None, None).unwrap().len(), 1);

        let stats = store.stats().unwrap();
        assert_eq!(stats.global_count, 1);
        assert_eq!(stats.project_count, 0);
        assert_eq!(stats.embedding_mode, "fts");

        store.delete(&m.id).unwrap();
        assert_eq!(store.stats().unwrap().global_count, 0);
    }

    #[test]
    fn global_only_matrix() {
        let mut store = open();
        store.config.project = false;

        let err = store
            .store("x", None, None, None, Some("proj"), None)
            .unwrap_err();
        assert!(err.message().contains("memory.project"));

        store
            .store("global fact", None, None, None, None, None)
            .unwrap();
        let hits = store.search("fact", Some("all"), None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].scope, "global");
    }

    #[test]
    fn project_only_matrix() {
        let mut store = open();
        store.config.global = false;

        assert!(store.store("x", None, None, None, None, None).is_err());

        let m = store
            .store("project fact", None, None, None, Some("proj"), None)
            .unwrap();
        assert_eq!(m.scope, "project:proj");

        let stats = store.stats().unwrap();
        assert_eq!(stats.project_count, 1);
        assert_eq!(stats.global_count, 0);
        assert!(!stats.scopes_enabled.global);
        assert!(stats.scopes_enabled.project);
    }

    #[test]
    fn session_scope_is_rejected() {
        let store = open();
        let err = store
            .store("x", Some("session:abc"), None, None, None, None)
            .unwrap_err();
        assert!(err.message().contains("session"));
    }
}
