//! Path references: attachments that name a file inside the task worktree.

use std::fs;
use std::path::{Path, PathBuf};

use warpforge_protocol::{LineRange, PromptAttachmentSummary};

use super::{Budget, PromptContent, MAX_FILE_BYTES};

pub(super) fn prepare_file(
    root: &Path,
    path: &str,
    range: Option<&LineRange>,
    budget: &mut Budget,
) -> Result<(PromptContent, PromptAttachmentSummary), String> {
    let (canonical, display) = secure_file(root, path)?;
    let meta = fs::metadata(&canonical).map_err(|e| format!("cannot read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("attachment is not a file: {path}"));
    }
    let bytes = fs::read(&canonical).map_err(|e| format!("cannot read {path}: {e}"))?;
    let whole_text = String::from_utf8(bytes).map_err(|_| format!("file is not UTF-8: {path}"))?;
    let file_text = match range {
        Some(r) => slice_lines(&whole_text, r)?,
        None => whole_text,
    };
    if (file_text.len() as u64) > MAX_FILE_BYTES {
        return Err(format!("file exceeds 512 KiB: {path}"));
    }
    super::charge_text(budget, file_text.len())?;
    let summary_path = match range {
        Some(r) => {
            if r.start == r.end {
                format!("{display}#L{}", r.start)
            } else {
                format!("{display}#L{}-{}", r.start, r.end)
            }
        }
        None => display,
    };
    Ok((
        PromptContent::Resource {
            uri: file_uri(&canonical),
            text: file_text,
        },
        PromptAttachmentSummary::File { path: summary_path },
    ))
}

/// Extract an inclusive, 1-based line span from source text. Out-of-range
/// bounds are clamped to the file instead of rejected, so a selection that
/// drifted past EOF still resolves to the last real line.
fn slice_lines(text: &str, range: &LineRange) -> Result<String, String> {
    if range.start == 0 {
        return Err("line range start must be 1-based".into());
    }
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Ok(String::new());
    }
    let start = (range.start as usize).saturating_sub(1).min(lines.len());
    let end = (range.end as usize)
        .max(range.start as usize)
        .min(lines.len());
    Ok(lines[start..end].join("\n"))
}

fn secure_file(root: &Path, supplied: &str) -> Result<(PathBuf, String), String> {
    let relative = Path::new(supplied);
    if relative.is_absolute() {
        return Err("absolute file attachment paths are not allowed".into());
    }
    if supplied.is_empty() {
        return Err("file attachment path is empty".into());
    }
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("cannot resolve attachment {supplied}: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("attachment escapes the task worktree: {supplied}"));
    }
    let display = canonical
        .strip_prefix(root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    Ok((canonical, display))
}

fn file_uri(path: &Path) -> String {
    format!("file://{}", path.to_string_lossy().replace(' ', "%20"))
}
