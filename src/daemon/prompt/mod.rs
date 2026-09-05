use std::path::Path;

use serde_json::{json, Value};
use warpforge_protocol::{PromptAttachment, PromptAttachmentSummary};

mod blobs;
mod files;
#[cfg(test)]
mod tests;

/// Path references (`@src/main.rs`) resolved against the task worktree.
const MAX_FILES: usize = 20;
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Shared ceiling for every text block: path references *and* uploaded
/// documents accumulate into the same budget.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// Uploaded text files. Kept in step with `MAX_DOCUMENTS` in
/// `desktop/src/lib/fileAttachments.ts`.
const MAX_DOCUMENTS: usize = 10;
const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
/// Kept in step with `MAX_IMAGES` in `desktop/src/lib/imageAttachments.ts`.
const MAX_IMAGES: usize = 10;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
pub enum PromptContent {
    Text(String),
    Resource {
        uri: String,
        text: String,
    },
    Image {
        mime_type: String,
        data: String,
    },
    Document {
        name: String,
        mime_type: String,
        text: String,
    },
}

impl PromptContent {
    pub fn to_acp(&self, embedded_context: bool) -> Value {
        match self {
            Self::Text(text) => json!({ "type": "text", "text": text }),
            Self::Resource { uri, text } if embedded_context => json!({
                "type": "resource",
                "resource": { "uri": uri, "mimeType": "text/plain", "text": text }
            }),
            Self::Resource { uri, text } => json!({
                "type": "text",
                "text": format!("\n--- Attached file: {uri} ---\n{text}\n--- End attached file ---")
            }),
            Self::Image { mime_type, data } => {
                json!({ "type": "image", "mimeType": mime_type, "data": data })
            }
            Self::Document {
                name,
                mime_type,
                text,
            } if embedded_context => json!({
                "type": "resource",
                "resource": {
                    "uri": format!("attachment://{name}"),
                    "mimeType": mime_type,
                    "text": text
                }
            }),
            Self::Document { name, text, .. } => json!({
                "type": "text",
                "text": format!("\n--- Attached file: {name} ---\n{text}\n--- End attached file ---")
            }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedPrompt {
    pub content: Vec<PromptContent>,
    pub summaries: Vec<PromptAttachmentSummary>,
    pub has_images: bool,
}

/// Running totals shared by the per-attachment preparers, so one budget
/// governs all text (path references plus uploaded documents) and one governs
/// all image bytes.
#[derive(Default)]
pub(super) struct Budget {
    text: usize,
    image: usize,
}

/// Add `len` bytes to the shared text budget, failing once the combined
/// context would no longer fit in a single prompt.
fn charge_text(budget: &mut Budget, len: usize) -> Result<(), String> {
    budget.text = budget
        .text
        .checked_add(len)
        .ok_or("file context is too large")?;
    if budget.text > MAX_TEXT_BYTES {
        return Err("combined file context exceeds 2 MiB".into());
    }
    Ok(())
}

pub fn prepare_prompt(
    root: &Path,
    text: String,
    attachments: &[PromptAttachment],
) -> Result<PreparedPrompt, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve task worktree: {e}"))?;
    let count =
        |matcher: fn(&PromptAttachment) -> bool| attachments.iter().filter(|a| matcher(a)).count();
    let file_count = count(|a| matches!(a, PromptAttachment::File { .. }));
    let image_count = count(|a| matches!(a, PromptAttachment::Image { .. }));
    let document_count = count(|a| matches!(a, PromptAttachment::Document { .. }));
    if file_count > MAX_FILES {
        return Err(format!("at most {MAX_FILES} file references are allowed"));
    }
    if image_count > MAX_IMAGES {
        return Err(format!("at most {MAX_IMAGES} images are allowed"));
    }
    if document_count > MAX_DOCUMENTS {
        return Err(format!(
            "at most {MAX_DOCUMENTS} attached files are allowed"
        ));
    }

    let mut content = if text.is_empty() {
        Vec::new()
    } else {
        vec![PromptContent::Text(text)]
    };
    let mut summaries = Vec::with_capacity(attachments.len());
    let mut budget = Budget::default();

    for attachment in attachments {
        let (block, summary) = match attachment {
            PromptAttachment::File { path, range } => {
                files::prepare_file(&root, path, range.as_ref(), &mut budget)?
            }
            PromptAttachment::Image {
                name,
                mime_type,
                data,
            } => blobs::prepare_image(name, mime_type, data, &mut budget)?,
            PromptAttachment::Document {
                name,
                mime_type,
                text,
            } => blobs::prepare_document(name, mime_type, text, &mut budget)?,
        };
        content.push(block);
        summaries.push(summary);
    }
    Ok(PreparedPrompt {
        content,
        summaries,
        has_images: image_count > 0,
    })
}
