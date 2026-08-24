//! Shared memory: durable cross-session facts/decisions/preferences searchable
//! by every harness (Claude, Codex, opencode). FTS5 in v1, optional local
//! embeddings (v1.5) — no dreaming execution. The store owns its own connection
//! to `~/.warpforge/memory.db`, isolated from the main warpforge DB, and is only
//! touched from the daemon actor thread (same single-threaded-access rationale
//! as `store.rs`).
//!
//! `memories_fts` is a regular FTS5 table (not external-content) because FTS5
//! requires an integer rowid while `memories.id` is a TEXT uuid: the uuid is
//! kept as an `UNINDEXED` column and rows are kept in sync with plain
//! INSERT/DELETE statements keyed on that id.
//!
//! When `memory.embedding == "fastembed"`, a `memories_vec` (`vec0`) table holds
//! cosine embeddings keyed by the memories table's implicit rowid, kept in sync
//! on store/update/delete. Search mode `hybrid` merges FTS BM25 and vector
//! cosine ranks via reciprocal-rank fusion; the embedding model lives in
//! [`super::memory_embed`] and degrades to FTS-only when unavailable.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::memory_config::{save_embedding, MemoryConfig};
use super::memory_embed::{
    ensure_vec_extension, f32_to_blob, rrf_merge, vec_table_sql, EmbedEngine,
};
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
    id UNINDEXED, content, tags, tokenize='porter');
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
CREATE TABLE IF NOT EXISTS memory_edges (
    src_id TEXT NOT NULL,
    dst_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (src_id, dst_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_src ON memory_edges(src_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_dst ON memory_edges(dst_id);
"#;

pub struct MemoryStore {
    conn: Option<Connection>,
    config: MemoryConfig,
    disabled: Option<String>,
    /// Embedding engine, lazily loaded. Guarded by a mutex so the model's
    /// `&mut self` embed fits the store's `&self` methods and the struct stays
    /// `Send`; only ever touched from the actor thread.
    embed: Mutex<EmbedEngine>,
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
        ensure_vec_extension();
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        migrate_fts_tags(&conn)?;
        clean_vec_orphans(&conn);
        seed_meta(&conn)?;
        Ok(Self {
            conn: Some(conn),
            config: MemoryConfig::default(),
            disabled: None,
            embed: Mutex::new(EmbedEngine::new(false)),
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
                embed: Mutex::new(EmbedEngine::new(false)),
            };
        }
        match Self::open() {
            Ok(mut store) => {
                store.config = config;
                if store.config.embeddings_enabled() && store.apply_embedding_config().is_err() {
                    store.config.embedding = "none".into();
                    *store.embed.lock().unwrap() = EmbedEngine::new(false);
                }
                store
            }
            Err(e) => Self {
                conn: None,
                config,
                disabled: Some(format!("memory disabled: {e}")),
                embed: Mutex::new(EmbedEngine::new(false)),
            },
        }
    }

    /// Create the vec table and flip the engine to match `config.embedding`.
    fn apply_embedding_config(&self) -> Result<(), MemoryError> {
        let enabled = self.config.embeddings_enabled();
        *self.embed.lock().unwrap() = EmbedEngine::new(enabled);
        if enabled {
            ensure_vec_extension();
            self.guard()?.execute_batch(&vec_table_sql())?;
        }
        self.write_embedding_meta(enabled)
    }

    fn write_embedding_meta(&self, enabled: bool) -> Result<(), MemoryError> {
        let conn = self.guard()?;
        let (model, dims): (&str, String) = if enabled {
            ("fastembed", super::memory_embed::EMBED_DIMS.to_string())
        } else {
            ("none", "0".into())
        };
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('embedding_model', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![model],
        )?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('dims', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![dims],
        )?;
        Ok(())
    }

    /// Change the embedding mode at runtime (Settings → Memory). `none` clears
    /// vectors; `fastembed` creates the vec table and backfills existing
    /// memories. Persists to config.yaml best-effort.
    pub fn set_embedding(&mut self, mode: &str) -> Result<Stats, MemoryError> {
        let mode = match mode {
            "none" | "fastembed" => mode,
            other => {
                return Err(MemoryError::Other(anyhow::anyhow!(
                    "invalid embedding mode '{other}' (want 'none' or 'fastembed')"
                )))
            }
        };
        self.config.embedding = mode.to_string();
        let _ = save_embedding(mode);
        // apply_embedding_config and backfill may panic when ort dylib missing (ort-load-dynamic);
        // catch unwind and degrade to FTS instead of killing tokio worker.
        let apply = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.apply_embedding_config()?;
            if mode == "fastembed" {
                // backfill triggers first model load — may panic on missing libonnxruntime
                if let Err(e) = self.backfill_embeddings() {
                    // model unavailable (offline) — keep hybrid flag but engine will report unavailable
                    eprintln!("[memory] backfill skipped: {e}");
                }
            }
            Result::<(), MemoryError>::Ok(())
        }));
        match apply {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let msg = e.to_string();
                eprintln!("[memory] embedding setup failed: {msg}");
                self.config.embedding = "none".into();
                let _ = save_embedding("none");
                *self.embed.lock().unwrap() =
                    super::memory_embed::EmbedEngine::new_disabled_with_reason(msg);
                let _ = self.write_embedding_meta(false);
            }
            Err(_) => {
                let msg = "ONNX Runtime unavailable (libonnxruntime missing — brew install onnxruntime; if already installed, re-select fastembed — no restart needed, or restart warpforge so ORT_DYLIB_PATH picks up /opt/homebrew/lib/libonnxruntime.dylib) — falling back to FTS";
                eprintln!("[memory] {msg}");
                self.config.embedding = "none".into();
                let _ = save_embedding("none");
                *self.embed.lock().unwrap() =
                    super::memory_embed::EmbedEngine::new_disabled_with_reason(msg);
                let _ = self.write_embedding_meta(false);
            }
        }
        self.stats()
    }

    /// Recompute vectors for every existing memory (after enabling embeddings).
    /// No-op when the model is unavailable.
    fn backfill_embeddings(&self) -> Result<(), MemoryError> {
        let conn = self.guard()?;
        // memories_vec may not exist if apply failed — ignore
        let _ = conn.execute("DELETE FROM memories_vec", []);
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn.prepare("SELECT rowid, content FROM memories")?;
            let mapped = stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            mapped.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (rowid, content) in rows {
            // index_embedding already catches panics and degrades to no-op
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = self.index_embedding(conn, rowid, &content);
            }));
            // if engine became unavailable, stop backfilling
            if self.embed.lock().unwrap().unavailable_reason().is_some() {
                break;
            }
        }
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled && self.disabled.is_none() && self.conn.is_some()
    }

    /// Whether the vec table exists and should be written to. `false` when
    /// embeddings are off, which keeps `DELETE FROM memories_vec` from erroring
    /// on a store whose vec table was never created (e.g. `open_at(":memory:")`).
    fn embeddings_active(&self) -> bool {
        self.embed.lock().unwrap().is_enabled()
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
    /// `None`/`"all"` narrow to the union of enabled scopes (empty = no filter);
    /// an explicit `"global"`/`"project"` whose scope is disabled is an error
    /// rather than silently coercing to the other scope.
    fn scope_predicate(&self, scope: Option<&str>) -> Result<String, MemoryError> {
        let (want_global, want_project) = match scope {
            Some("global") => (true, false),
            Some("project") => (false, true),
            _ => (true, true),
        };
        if want_global && !want_project && !self.config.global {
            return Err(MemoryError::Scope("global memory is disabled".into()));
        }
        if want_project && !want_global && !self.config.project {
            return Err(MemoryError::Scope("project memory is disabled".into()));
        }
        let g = want_global && self.config.global;
        let p = want_project && self.config.project;
        Ok(match (g, p) {
            (true, true) => String::new(),
            (true, false) => "m.scope = 'global'".into(),
            (false, true) => "m.scope LIKE 'project:%'".into(),
            (false, false) => "0".into(),
        })
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
        let project_id = project_id
            .filter(|p| !p.trim().is_empty())
            .map(str::to_string);
        let scope = self.resolve_write_scope(scope, project_id.as_deref())?;
        if let Some(pid) = scope.strip_prefix("project:").map(|s| s.to_string()) {
            let should_overlay = Self::resolve_project_db(Some(&pid)).is_some()
                || self.config.per_project.unwrap_or(false);
            if should_overlay {
                let Some(path) = Self::project_db_path(&pid) else {
                    return Err(MemoryError::Scope("invalid project id".into()));
                };
                let pconn = Self::open_project_at(&path, self.config.embeddings_enabled())?;
                return Self::store_on_conn(
                    &pconn,
                    &self.embed,
                    project_id,
                    scope,
                    content,
                    kind,
                    tags,
                    created_by,
                );
            }
        }
        let conn = self.guard()?;
        let kind = clamp_kind(kind);
        let tags = tags.unwrap_or(&[]).to_vec();
        let tags_json = serde_json::to_string(&tags)?;
        let tags_fts = tags.join(" ");
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_secs() as i64;
        // Transaction ensures vec UNIQUE failure doesn't leave orphan memories row (bug #1)
        // and we capture rowid BEFORE FTS insert (last_insert_rowid would otherwise point to FTS).
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let res: Result<Memory, MemoryError> = (|| {
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
            let rowid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO memories_fts (id, content, tags) VALUES (?1, ?2, ?3)",
                params![id, content, tags_fts],
            )?;
            self.index_embedding(conn, rowid, content)?;
            load_by_id(conn, &id)
        })();
        match res {
            Ok(m) => {
                conn.execute_batch("COMMIT")?;
                Ok(m)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Insert a vector for a stored memory. Silently no-ops when embeddings are
    /// disabled or the model is unavailable.
    fn index_embedding(
        &self,
        conn: &Connection,
        rowid: i64,
        content: &str,
    ) -> Result<(), MemoryError> {
        let vec = {
            let mut engine = self.embed.lock().unwrap();
            if !engine.is_enabled() {
                return Ok(());
            }
            match engine.embed(&[content]) {
                Some(embeddings) => embeddings.into_iter().next(),
                None => return Ok(()),
            }
        };
        let Some(vec) = vec else { return Ok(()) };
        let blob = f32_to_blob(&vec);
        conn.execute(
            "INSERT OR REPLACE INTO memories_vec (rowid, embedding) VALUES (?1, ?2)",
            params![rowid, blob],
        )?;
        Ok(())
    }

    /// Search memories. `mode == "hybrid"` merges FTS (BM25) and vector (cosine)
    /// ranks via RRF when embeddings are enabled, else falls back to pure FTS.
    /// Every returned hit bumps `last_accessed` (feeds future decay).
    /// `scope` `None`/`"all"` searches the global DB *and* every project overlay,
    /// merging the results; a narrow scope searches one DB only.
    pub fn search(
        &self,
        query: &str,
        scope: Option<&str>,
        limit: Option<u32>,
        mode: Option<&str>,
    ) -> Result<Vec<Memory>, MemoryError> {
        // Per-project overlay is primary for project-scoped reads
        if let Some(pid) = scope.and_then(|s| s.strip_prefix("project:")) {
            if let Some(path) = Self::resolve_project_db(Some(pid)) {
                let pconn = Self::open_project_at(&path, self.config.embeddings_enabled())?;
                return self.search_on_conn(&pconn, query, scope, limit, mode);
            }
        }
        let conn = self.guard()?;
        if scope.is_none() || scope == Some("all") {
            self.search_all(conn, query, scope, limit, mode)
        } else {
            self.search_on_conn(conn, query, scope, limit, mode)
        }
    }

    /// Merge global + project results for a non-scoped search.
    fn search_all(
        &self,
        conn: &Connection,
        query: &str,
        scope: Option<&str>,
        limit: Option<u32>,
        mode: Option<&str>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let cap = limit.unwrap_or(10).clamp(1, 100);
        // Fetch with higher recall so overlay results can compete, then re-sort
        // (global first, relevance order preserved within each scope) before
        // truncating to the requested cap.
        let recall = (cap * 2).min(100);
        let mut merged = self.search_on_conn(conn, query, scope, Some(recall), mode)?;
        if self.config.project {
            for path in Self::project_dbs() {
                if !path.exists() {
                    continue;
                }
                let pconn = Self::open_project_at(&path, self.config.embeddings_enabled())?;
                let proj =
                    self.search_on_conn(&pconn, query, Some("project"), Some(recall), mode)?;
                for m in proj {
                    if !merged.iter().any(|x| x.id == m.id) {
                        merged.push(m);
                    }
                }
            }
        }
        merged.sort_by_key(|b| std::cmp::Reverse(b.scope == "global"));
        merged.truncate(cap as usize);
        Ok(merged)
    }

    fn search_on_conn(
        &self,
        conn: &Connection,
        query: &str,
        scope: Option<&str>,
        limit: Option<u32>,
        mode: Option<&str>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let sanitized = sanitize_query(query);
        if sanitized.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.unwrap_or(10).clamp(1, 100) as i64;
        let predicate = self.scope_predicate(scope)?;
        let hybrid = matches!(mode, Some("hybrid")) && self.embed.lock().unwrap().is_enabled();
        if hybrid {
            self.hybrid_search(conn, &sanitized, &predicate, limit)
        } else {
            self.fts_search(conn, &sanitized, &predicate, limit)
        }
    }

    /// Pure FTS5 BM25 search with snippets (v1 behavior, unchanged).
    fn fts_search(
        &self,
        conn: &Connection,
        sanitized: &str,
        predicate: &str,
        limit: i64,
    ) -> Result<Vec<Memory>, MemoryError> {
        let results = self.fts_search_inner(conn, sanitized, predicate, limit)?;
        if !results.is_empty() || !sanitized.contains(' ') {
            return Ok(results);
        }
        // Ranked-OR fallback: strict AND returned 0 → retry with OR so partial matches surface (bug #2)
        let or_query = sanitized
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" OR ");
        let or_results = self.fts_search_inner(conn, &or_query, predicate, limit)?;
        Ok(or_results)
    }

    fn fts_search_inner(
        &self,
        conn: &Connection,
        sanitized: &str,
        predicate: &str,
        limit: i64,
    ) -> Result<Vec<Memory>, MemoryError> {
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

    /// Hybrid = FTS BM25 ranks + vector cosine ranks fused by RRF.
    fn hybrid_search(
        &self,
        conn: &Connection,
        sanitized: &str,
        predicate: &str,
        limit: i64,
    ) -> Result<Vec<Memory>, MemoryError> {
        let recall = (limit * 3).clamp(30, 500);
        let fts_ids = self.fts_ranked_ids(conn, sanitized, predicate, recall)?;
        let Some(vec_ids) = self.vec_ranked_ids(conn, sanitized, predicate, recall)? else {
            return self.fts_search(conn, sanitized, predicate, limit);
        };
        let merged = rrf_merge(&fts_ids, &vec_ids, limit as usize);
        self.load_ranked(conn, &merged)
    }

    fn fts_ranked_ids(
        &self,
        conn: &Connection,
        sanitized: &str,
        predicate: &str,
        recall: i64,
    ) -> Result<Vec<String>, MemoryError> {
        let where_sql = if predicate.is_empty() {
            "memories_fts MATCH ?1".to_string()
        } else {
            format!("memories_fts MATCH ?1 AND {predicate}")
        };
        let sql = format!(
            "SELECT m.id FROM memories m JOIN memories_fts ON memories_fts.id = m.id \
             WHERE {where_sql} ORDER BY rank LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![sanitized, recall], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    /// `None` when embeddings are disabled or the model is unavailable.
    fn vec_ranked_ids(
        &self,
        conn: &Connection,
        sanitized: &str,
        predicate: &str,
        recall: i64,
    ) -> Result<Option<Vec<String>>, MemoryError> {
        let query_vec = {
            let mut engine = self.embed.lock().unwrap();
            if !engine.is_enabled() {
                return Ok(None);
            }
            match engine.embed(&[sanitized]) {
                Some(embeddings) => embeddings.into_iter().next(),
                None => return Ok(None),
            }
        };
        let Some(query_vec) = query_vec else {
            return Ok(None);
        };
        let blob = f32_to_blob(&query_vec);
        let join_where = if predicate.is_empty() {
            String::new()
        } else {
            format!("AND {predicate}")
        };
        let sql = format!(
            "WITH knn AS (\
               SELECT rowid AS r, distance FROM memories_vec \
               WHERE embedding MATCH ?1 AND k = ?2) \
             SELECT m.id FROM knn JOIN memories m ON m.rowid = knn.r \
             WHERE 1 = 1 {join_where} ORDER BY knn.distance LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![blob, recall, recall], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(Some(ids))
    }

    fn load_ranked(&self, conn: &Connection, ids: &[String]) -> Result<Vec<Memory>, MemoryError> {
        let mut results = Vec::new();
        for id in ids {
            if let Ok(mut mem) = load_by_id(conn, id) {
                let now = now_secs() as i64;
                conn.execute(
                    "UPDATE memories SET last_accessed = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
                mem.last_accessed = now;
                results.push(mem);
            }
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
        if let Some(pid) = scope.and_then(|s| s.strip_prefix("project:")) {
            if let Some(path) = Self::resolve_project_db(Some(pid)) {
                let pconn = Self::open_project_at(&path, self.config.embeddings_enabled())?;
                return Self::list_on_conn(&pconn, self, scope, kind, limit, offset);
            }
        }
        let conn = self.guard()?;
        if scope.is_none() || scope == Some("all") {
            self.list_all(conn, scope, kind, limit, offset)
        } else {
            Self::list_on_conn(conn, self, scope, kind, limit, offset)
        }
    }

    /// Merge global + project rows for a non-scoped list.
    fn list_all(
        &self,
        conn: &Connection,
        scope: Option<&str>,
        kind: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let mut merged = Self::list_on_conn(conn, self, scope, kind, None, None)?;
        if self.config.project {
            for path in Self::project_dbs() {
                if !path.exists() {
                    continue;
                }
                let pconn = Self::open_project_at(&path, self.config.embeddings_enabled())?;
                let proj = Self::list_on_conn(&pconn, self, Some("project"), kind, None, None)?;
                for m in proj {
                    if !merged.iter().any(|x| x.id == m.id) {
                        merged.push(m);
                    }
                }
            }
        }
        merged.sort_by(|a, b| {
            (b.scope == "global")
                .cmp(&(a.scope == "global"))
                .then(b.updated_at.cmp(&a.updated_at))
        });
        let offset = offset.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(100).clamp(1, 1000) as usize;
        Ok(merged.into_iter().skip(offset).take(limit).collect())
    }

    fn list_on_conn(
        conn: &Connection,
        store: &Self,
        scope: Option<&str>,
        kind: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let mut conditions = Vec::new();
        let predicate = store.scope_predicate(scope)?;
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
        // preserve tags in FTS on content update
        let tags_json: String = conn.query_row(
            "SELECT tags FROM memories WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let tags_fts: String = serde_json::from_str::<Vec<String>>(&tags_json)
            .unwrap_or_default()
            .join(" ");
        conn.execute(
            "INSERT INTO memories_fts (id, content, tags) VALUES (?1, ?2, ?3)",
            params![id, content, tags_fts],
        )?;
        let rowid: i64 = conn.query_row(
            "SELECT rowid FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        if self.embeddings_active() {
            conn.execute("DELETE FROM memories_vec WHERE rowid = ?1", params![rowid])?;
        }
        self.index_embedding(conn, rowid, content)?;
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
        let rowid: i64 = conn.query_row(
            "SELECT rowid FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM memories_fts WHERE id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM memory_edges WHERE src_id = ?1 OR dst_id = ?1",
            params![id],
        )?;
        if self.embeddings_active() {
            conn.execute("DELETE FROM memories_vec WHERE rowid = ?1", params![rowid])?;
        }
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
        let (embedding_mode, embedding_unavailable) = {
            let engine = self.embed.lock().unwrap();
            if engine.is_enabled() && engine.unavailable_reason().is_none() {
                ("hybrid", None)
            } else {
                ("fts", engine.unavailable_reason().map(|s| s.to_string()))
            }
        };
        Ok(Stats {
            global_count,
            project_count,
            embedding_mode: embedding_mode.into(),
            scopes_enabled: ScopesEnabled {
                global: self.config.global,
                project: self.config.project,
            },
            per_project_db_exists: Self::any_project_db_exists(),
            embedding_unavailable,
        })
    }

    // ── v2: graph ──
    pub fn add_edge(
        &self,
        src_id: &str,
        dst_id: &str,
        relation: &str,
    ) -> Result<super::memory_types::Edge, MemoryError> {
        let conn = self.guard()?;
        let relation = clamp_relation(relation);
        for id in [src_id, dst_id] {
            if content_of(conn, id)?.is_none() {
                return Err(MemoryError::Other(anyhow::anyhow!(
                    "memory '{id}' not found"
                )));
            }
        }
        let now = now_secs() as i64;
        conn.execute(
            "INSERT OR IGNORE INTO memory_edges (src_id,dst_id,relation,created_at) VALUES (?1,?2,?3,?4)",
            params![src_id, dst_id, relation, now],
        )?;
        Ok(super::memory_types::Edge {
            src_id: src_id.into(),
            dst_id: dst_id.into(),
            relation,
            created_at: now,
        })
    }
    pub fn list_edges(&self, id: &str) -> Result<Vec<super::memory_types::Edge>, MemoryError> {
        let conn = self.guard()?;
        let mut stmt = conn.prepare("SELECT src_id,dst_id,relation,created_at FROM memory_edges WHERE src_id=?1 OR dst_id=?1")?;
        let rows = stmt.query_map(params![id], |r| {
            Ok(super::memory_types::Edge {
                src_id: r.get(0)?,
                dst_id: r.get(1)?,
                relation: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn any_project_db_exists() -> bool {
        let base = dirs::home_dir()
            .map(|h| h.join(".warpforge/projects"))
            .unwrap_or_default();
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                if e.path().join(".warpforge/memory.db").exists() {
                    return true;
                }
            }
        }
        false
    }

    /// Per-project overlay path. Returns Some(path) if file exists.
    /// Sanitizes: rejects empty, `.`, `..`, `/`, `\`, and any char outside
    /// `[a-zA-Z0-9_-]`.
    pub fn resolve_project_db(project_id: Option<&str>) -> Option<PathBuf> {
        let pid = project_id?;
        if !sanitize_project_id(pid) {
            return None;
        }
        // Check env override and home heuristic
        for base in [
            std::env::var("WARP_PROJECTS_DIR").ok().map(PathBuf::from),
            dirs::home_dir().map(|h| h.join(".warpforge/projects").join(pid)),
        ]
        .into_iter()
        .flatten()
        {
            let p = base.join(".warpforge/memory.db");
            // base already includes pid for home case; for env var, pid subdir
            let candidate = if base.ends_with(pid) {
                p
            } else {
                base.join(pid).join(".warpforge/memory.db")
            };
            if candidate.exists() {
                return Some(candidate);
            }
        }
        // Also check pid as direct path (tests)
        let direct = PathBuf::from(pid).join(".warpforge/memory.db");
        if direct.exists() {
            return Some(direct);
        }
        None
    }

    pub fn per_project_db_exists_for(&self, project_id: Option<&str>) -> bool {
        Self::resolve_project_db(project_id).is_some()
    }

    fn project_db_path(pid: &str) -> Option<PathBuf> {
        if !sanitize_project_id(pid) {
            return None;
        }
        if let Ok(base) = std::env::var("WARP_PROJECTS_DIR") {
            return Some(PathBuf::from(base).join(pid).join(".warpforge/memory.db"));
        }
        Some(
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".warpforge/projects")
                .join(pid)
                .join(".warpforge/memory.db"),
        )
    }

    /// All existing project overlay DB paths (both `WARP_PROJECTS_DIR` and the
    /// home heuristic), for merging non-scoped reads.
    fn project_dbs() -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(base) = std::env::var("WARP_PROJECTS_DIR") {
            collect_project_dbs(&PathBuf::from(base), &mut out);
        }
        if let Some(home) = dirs::home_dir() {
            collect_project_dbs(&home.join(".warpforge/projects"), &mut out);
        }
        let mut seen = HashSet::new();
        out.retain(|p| seen.insert(p.clone()));
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn store_on_conn(
        conn: &Connection,
        embed: &Mutex<EmbedEngine>,
        project_id: Option<String>,
        scope: String,
        content: &str,
        kind: Option<&str>,
        tags: Option<&[String]>,
        created_by: Option<&str>,
    ) -> Result<Memory, MemoryError> {
        let kind = clamp_kind(kind);
        let tags = tags.unwrap_or(&[]).to_vec();
        let tags_json = serde_json::to_string(&tags)?;
        let tags_fts = tags.join(" ");
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_secs() as i64;
        conn.execute(
            "INSERT INTO memories (id,project_id,scope,kind,content,created_at,updated_at,last_accessed,created_by,superseded_by,tags) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![id, project_id, scope, kind, content, now, now, now, created_by, None::<String>, tags_json],
        )?;
        let rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO memories_fts (id, content, tags) VALUES (?1, ?2, ?3)",
            params![id, content, tags_fts],
        )?;
        // inline embedding index
        {
            let mut eng = embed.lock().unwrap();
            if eng.is_enabled() {
                if let Some(vec) = eng.embed(&[content]).and_then(|mut v| v.pop()) {
                    let blob = f32_to_blob(&vec);
                    conn.execute(
                        "INSERT OR REPLACE INTO memories_vec (rowid, embedding) VALUES (?1, ?2)",
                        params![rowid, blob],
                    )?;
                }
            }
        }
        load_by_id(conn, &id)
    }

    fn open_project_at(path: &Path, embeddings: bool) -> Result<Connection> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        ensure_vec_extension();
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        migrate_fts_tags(&conn)?;
        clean_vec_orphans(&conn);
        seed_meta(&conn)?;
        if embeddings {
            conn.execute_batch(&vec_table_sql())?;
        }
        Ok(conn)
    }

    pub fn pending_compaction_count(&self) -> u64 {
        let Ok(conn) = self.guard() else { return 0 };
        conn.query_row(
            "SELECT COUNT(*) FROM memory_compaction_log WHERE status='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    pub fn resolve_compaction(&self, id: i64, approve: bool) -> Result<String, MemoryError> {
        let conn = self.guard()?;
        let status = if approve { "applied" } else { "rejected" };
        let changed = conn.execute(
            "UPDATE memory_compaction_log SET status=?1 WHERE id=?2 AND status='pending'",
            params![status, id],
        )?;
        if changed == 0 {
            return Err(MemoryError::Other(anyhow::anyhow!(
                "not found or not pending"
            )));
        }
        Ok(status.to_string())
    }

    pub fn resolve_compaction_for_targets(
        &self,
        target_ids: &str,
        approve: bool,
    ) -> Result<usize, MemoryError> {
        let conn = self.guard()?;
        let status = if approve { "approved" } else { "rejected" };
        let mut count = 0;
        for tid in target_ids
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            count += conn.execute(
                "UPDATE memory_compaction_log SET status=?1 WHERE target_ids LIKE ?2 AND status='pending'",
                params![status, format!("%{}%", tid)],
            )?;
        }
        Ok(count)
    }

    pub fn list_compaction_log(&self) -> Result<Vec<serde_json::Value>, MemoryError> {
        let conn = self.guard()?;
        let mut stmt = conn.prepare(
            "SELECT id, proposal_type, target_ids, reason, status, created_at FROM memory_compaction_log ORDER BY created_at DESC LIMIT 100",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "proposal_type": r.get::<_, Option<String>>(1)?,
                "target_ids": r.get::<_, Option<String>>(2)?,
                "reason": r.get::<_, Option<String>>(3)?,
                "status": r.get::<_, String>(4)?,
                "created_at": r.get::<_, i64>(5)?,
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn config(&self) -> &super::memory_config::MemoryConfig {
        &self.config
    }

    pub fn dream_with_config(
        &self,
        dry_run: bool,
        cfg: &super::memory_config::DreamingConfig,
        fallback_model: Option<&str>,
    ) -> Result<serde_json::Value, MemoryError> {
        let model = cfg.effective_model(fallback_model);
        // Agent dreaming would spawn an LLM run here via `generate_text` with the
        // chosen `model`/`agent`; this sync store path has no agent runtime, so we
        // log the intent and fall back to the heuristic pass. The resolved model is
        // surfaced in the result so callers can drive the agent path.
        if let Some(m) = &model {
            eprintln!(
                "[memory] dreaming agent path requested (agent={} model={m}); falling back to heuristic",
                cfg.agent
            );
        }
        let mut out = self.dream(dry_run)?;
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "model".into(),
                model.map_or(serde_json::Value::Null, serde_json::Value::String),
            );
        }
        Ok(out)
    }

    /// Dream pass: tries agent flow then falls back to heuristic.
    /// Agent path uses dream_prompt over 200 oldest last_accessed; heuristic provides proposals when no agent.
    pub fn dream(&self, dry_run: bool) -> Result<serde_json::Value, MemoryError> {
        self.guard()?;
        let pending_before = self.pending_compaction_count();
        // Try agent-parsed proposals if prompt yields rows; insert via validated path
        let prompt = self.dream_prompt();
        let has_memories = !prompt.is_empty();
        let mut inserted = 0usize;
        if has_memories && !dry_run {
            // Attempt to use any pending agent proposals would come via inserted heuristic below;
            // agent JSON path is exercised via dream_with_proposals when caller has LLM text.
            inserted = self.propose_compaction()?;
        } else if has_memories && dry_run {
            // dry_run: count what would be inserted (deduped) without writing
            let conn = self.guard()?;
            let mut dup = 0usize;
            let mut stmt = conn.prepare(
                "SELECT (SELECT GROUP_CONCAT(id, ',') FROM (SELECT id FROM memories m2 WHERE m2.content = m.content ORDER BY id)) FROM memories m GROUP BY content HAVING COUNT(*)>1",
            )?;
            let dup_rows: Vec<String> = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for ids in &dup_rows {
                let exists: i64 = conn.query_row("SELECT COUNT(*) FROM memory_compaction_log WHERE proposal_type='duplicate' AND target_ids=?1 AND status='pending'", params![ids], |r| r.get(0))?;
                if exists == 0 {
                    dup += 1;
                }
            }
            let now = now_secs() as i64;
            let stale_cutoff = now - 30 * 24 * 3600;
            let mut stmt2 = conn.prepare("SELECT id FROM memories WHERE last_accessed < ?1 AND updated_at < ?1 ORDER BY last_accessed ASC LIMIT 200")?;
            let stale_ids: Vec<String> = stmt2
                .query_map(params![stale_cutoff], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut stale = 0;
            for id in &stale_ids {
                let exists: i64 = conn.query_row("SELECT COUNT(*) FROM memory_compaction_log WHERE proposal_type='stale' AND target_ids=?1 AND status='pending'", params![id.clone()], |r| r.get(0))?;
                if exists == 0 {
                    stale += 1;
                }
            }
            inserted = dup + stale;
        } else if !has_memories {
            inserted = 0;
        }
        if !dry_run && !has_memories {
            // no memories: nothing to insert
        }
        let proposals = self.list_compaction_log()?;
        Ok(
            serde_json::json!({"proposals": proposals, "dry_run": dry_run, "inserted": inserted, "pending": self.pending_compaction_count(), "pending_before": pending_before, "prompt": prompt.chars().take(200).collect::<String>()}),
        )
    }

    /// Insert validated proposals parsed from agent JSON (decay-ordered 200). Deduplicates pending and validates target_ids.
    pub fn dream_with_proposals(
        &self,
        text: &str,
        dry_run: bool,
    ) -> Result<serde_json::Value, MemoryError> {
        let proposals = super::memory_dream::parse_proposals(text);
        if dry_run {
            let valid: Vec<_> = proposals
                .iter()
                .filter(|(_, ids, _)| self.validate_target_ids(ids))
                .collect();
            return Ok(
                serde_json::json!({"proposals": valid.len(), "dry_run": true, "parsed": proposals.len()}),
            );
        }
        let conn = self.guard()?;
        let now = now_secs() as i64;
        let mut inserted = 0;
        for (ptype, target_ids, reason) in proposals {
            if !self.validate_target_ids(&target_ids) {
                continue;
            }
            let exists: i64 = conn.query_row("SELECT COUNT(*) FROM memory_compaction_log WHERE proposal_type=?1 AND target_ids=?2 AND status='pending'", params![ptype, target_ids], |r| r.get(0))?;
            if exists > 0 {
                continue;
            }
            conn.execute("INSERT INTO memory_compaction_log (proposal_type,target_ids,reason,status,created_at) VALUES (?1,?2,?3,'pending',?4)", params![ptype, target_ids, reason, now])?;
            inserted += 1;
        }
        Ok(serde_json::json!({"inserted": inserted, "pending": self.pending_compaction_count()}))
    }

    fn validate_target_ids(&self, ids: &str) -> bool {
        let Ok(conn) = self.guard() else {
            return false;
        };
        for id in ids.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE id=?1",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if exists == 0 {
                return false;
            }
        }
        true
    }

    pub fn dream_prompt(&self) -> String {
        let Ok(conn) = self.guard() else {
            return String::new();
        };
        let mut stmt = match conn.prepare(
            "SELECT id, content, last_accessed FROM memories ORDER BY last_accessed ASC LIMIT 200",
        ) {
            Ok(s) => s,
            Err(_) => return String::new(),
        };
        let rows: Vec<(String, String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap_or_default();
        if rows.is_empty() {
            return String::new();
        }
        super::memory_dream::dream_prompt(&rows)
    }

    /// Heuristic compaction: find duplicates (same content) and stale (old + low access), log pending proposals.
    /// Idempotent: skips if identical pending proposal already exists.
    pub fn propose_compaction(&self) -> Result<usize, MemoryError> {
        let conn = self.guard()?;
        let now = now_secs() as i64;
        let stale_cutoff = now - 30 * 24 * 3600;
        let mut count = 0;
        let mut stmt = conn.prepare(
            "SELECT (SELECT GROUP_CONCAT(id, ',') FROM (SELECT id FROM memories m2 WHERE lower(trim(m2.content)) = lower(trim(m.content)) ORDER BY id)) FROM memories m GROUP BY lower(trim(content)) HAVING COUNT(*)>1",
        )?;
        let dup_rows: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for ids in dup_rows {
            let exists: i64 = conn.query_row("SELECT COUNT(*) FROM memory_compaction_log WHERE proposal_type='duplicate' AND target_ids=?1 AND status='pending'", params![ids], |r| r.get(0))?;
            if exists == 0 {
                conn.execute("INSERT INTO memory_compaction_log (proposal_type,target_ids,reason,status,created_at) VALUES ('duplicate',?1,'duplicate content','pending',?2)", params![ids, now])?;
                count += 1;
            }
        }
        // stale: one proposal per stale id to keep granularity
        let mut stmt2 =
            conn.prepare("SELECT id FROM memories WHERE last_accessed < ?1 AND updated_at < ?1")?;
        let stale_ids: Vec<String> = stmt2
            .query_map(params![stale_cutoff], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in stale_ids {
            let exists: i64 = conn.query_row("SELECT COUNT(*) FROM memory_compaction_log WHERE proposal_type='stale' AND target_ids=?1 AND status='pending'", params![id.clone()], |r| r.get(0))?;
            if exists == 0 {
                conn.execute("INSERT INTO memory_compaction_log (proposal_type,target_ids,reason,status,created_at) VALUES ('stale',?1,'stale 30d','pending',?2)", params![id, now])?;
                count += 1;
            }
        }
        Ok(count)
    }
}

// ── Helpers ──

const KINDS: &[&str] = &["fact", "decision", "preference", "gotcha", "note"];
const RELATIONS: &[&str] = &["related", "supports", "contradicts", "supersedes"];
fn clamp_relation(r: &str) -> String {
    let lower = r.trim().to_lowercase();
    if RELATIONS.contains(&lower.as_str()) {
        lower
    } else {
        "related".into()
    }
}
// TODO(cross-encoder): benchmark cross-encoder reranker (e.g. MiniLM cross-encoder) on recall tasks before enabling; see spec §11.

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

/// Strict project-id validator used wherever a project id becomes a filesystem
/// path. Rejects empty, `.`, `..`, `/`, `\`, and anything outside
/// `[a-zA-Z0-9_-]`.
fn sanitize_project_id(pid: &str) -> bool {
    !pid.is_empty()
        && pid != "."
        && pid != ".."
        && pid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn clean_vec_orphans(conn: &Connection) {
    // Remove vec rows whose memories rowid no longer exists (orphans left by
    // pre-txn bug where vec rowid was taken from FTS). Best-effort, ignore errors if vec0 missing.
    let _ = conn.execute(
        "DELETE FROM memories_vec WHERE rowid NOT IN (SELECT rowid FROM memories)",
        [],
    );
}

/// Auto-migrate old FTS table (without `tags` column) to new schema.
/// No user action needed: detects legacy `memories_fts`, rebuilds with `tags` and backfills from `memories.tags`.
fn migrate_fts_tags(conn: &Connection) -> Result<()> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(create_sql) = sql else { return Ok(()) };
    if create_sql.contains("tags") {
        return Ok(());
    }
    // Legacy FTS without tags: rebuild
    conn.execute_batch(
        "DROP TABLE IF EXISTS memories_fts;
         CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, tags, tokenize='porter');",
    )?;
    // Backfill from memories (tags JSON -> space-joined)
    let mut stmt = conn.prepare("SELECT id, content, tags FROM memories")?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, content, tags_json) in rows {
        let tags_fts = serde_json::from_str::<Vec<String>>(&tags_json)
            .unwrap_or_default()
            .join(" ");
        conn.execute(
            "INSERT INTO memories_fts (id, content, tags) VALUES (?1, ?2, ?3)",
            params![id, content, tags_fts],
        )?;
    }
    Ok(())
}

/// Collect `<root>/<pid>/.warpforge/memory.db` for every existing project DB.
fn collect_project_dbs(root: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let db = e.path().join(".warpforge/memory.db");
            if db.exists() {
                out.push(db);
            }
        }
    }
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
