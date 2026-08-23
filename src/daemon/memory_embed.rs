//! Optional local embeddings for shared memory (v1.5).
//!
//! Wraps `fastembed` (all-MiniLM-L6-v2, 384-dim ONNX via ONNX Runtime — no
//! llama.cpp, no 4 GB model). The model is fetched lazily on first use and
//! cached under the fastembed cache dir; when the fetch or load fails (offline
//! or a missing model) the engine reports unavailable and callers fall back to
//! FTS-only. State is guarded by a `Mutex` in `MemoryStore` because the model's
//! `embed` needs `&mut self` while store methods take `&self`; the store is
//! only ever touched from the daemon actor thread, so contention is impossible.

use std::sync::Once;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

/// Dimensionality of all-MiniLM-L6-v2.
pub const EMBED_DIMS: usize = 384;

/// Register the `vec0` extension with SQLite. Must run before any connection is
/// opened; the `Once` makes repeated calls a no-op.
pub fn ensure_vec_extension() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        #[allow(clippy::missing_transmute_annotations)]
        {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// `CREATE VIRTUAL TABLE` DDL for the cosine vector index over memories.
pub fn vec_table_sql() -> String {
    format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(\
         embedding float[{EMBED_DIMS}] distance_metric=cosine);"
    )
}

/// Serialize `f32`s into the little-endian BLOB `vec0` expects for MATCH/INSERT.
pub fn f32_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Lazily-loaded embedding model. `enabled` mirrors the config; the model loads
/// on first use and, on failure, `unavailable` records why so the (potentially
/// slow) download isn't retried on every operation.
pub struct EmbedEngine {
    enabled: bool,
    model: Option<TextEmbedding>,
    unavailable: Option<String>,
}

impl EmbedEngine {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            model: None,
            unavailable: None,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn unavailable_reason(&self) -> Option<&str> {
        self.unavailable.as_deref()
    }

    /// Embed `texts`, loading the model on first use. Returns `None` when
    /// embeddings are disabled or the model is unavailable (offline/missing).
    pub fn embed(&mut self, texts: &[&str]) -> Option<Vec<Vec<f32>>> {
        if !self.enabled {
            return None;
        }
        if self.model.is_none() && self.unavailable.is_none() {
            match TextEmbedding::try_new(
                TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
                    .with_show_download_progress(false),
            ) {
                Ok(model) => self.model = Some(model),
                Err(e) => {
                    self.unavailable = Some(e.to_string());
                    return None;
                }
            }
        }
        let model = self.model.as_mut()?;
        model.embed(texts, None).ok()
    }
}

/// Reciprocal-rank fusion over two ranked id lists (1-indexed ranks).
pub fn rrf_merge(fts: &[String], vec: &[String], limit: usize) -> Vec<String> {
    const K: f64 = 60.0;
    let mut scores: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
    for (i, id) in fts.iter().enumerate() {
        *scores.entry(id.as_str()).or_insert(0.0) += 1.0 / (K + i as f64 + 1.0);
    }
    for (i, id) in vec.iter().enumerate() {
        *scores.entry(id.as_str()).or_insert(0.0) += 1.0 / (K + i as f64 + 1.0);
    }
    let mut ranked: Vec<(&str, f64)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked
        .into_iter()
        .take(limit)
        .map(|(id, _)| id.to_string())
        .collect()
}
