//! Shared-memory result and error types. Kept separate from the store so
//! `memory.rs` stays focused on the SQLite mechanics.

use serde::Serialize;

use warpforge_protocol as wire;

/// A single durable memory, serialized as the JSON result of the `memory.*`
/// RPC methods.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub scope: String,
    pub kind: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_accessed: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub global_count: u64,
    pub project_count: u64,
    pub embedding_mode: String,
    pub scopes_enabled: ScopesEnabled,
    #[serde(default)]
    pub per_project_db_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub src_id: String,
    pub dst_id: String,
    pub relation: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopesEnabled {
    pub global: bool,
    pub project: bool,
}

/// Errors from memory operations. `Disabled` and `Scope` are client errors
/// (invalid request); `Other` maps to an internal failure.
#[derive(Debug)]
pub enum MemoryError {
    Disabled(String),
    Scope(String),
    Other(anyhow::Error),
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryError::Disabled(m) | MemoryError::Scope(m) => f.write_str(m),
            MemoryError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MemoryError {}

impl From<anyhow::Error> for MemoryError {
    fn from(e: anyhow::Error) -> Self {
        MemoryError::Other(e)
    }
}

impl From<rusqlite::Error> for MemoryError {
    fn from(e: rusqlite::Error) -> Self {
        MemoryError::Other(e.into())
    }
}

impl From<serde_json::Error> for MemoryError {
    fn from(e: serde_json::Error) -> Self {
        MemoryError::Other(e.into())
    }
}

impl MemoryError {
    pub fn code(&self) -> wire::ErrorCode {
        match self {
            MemoryError::Disabled(_) | MemoryError::Scope(_) => wire::ErrorCode::InvalidRequest,
            MemoryError::Other(_) => wire::ErrorCode::Internal,
        }
    }

    pub fn message(&self) -> String {
        self.to_string()
    }
}
