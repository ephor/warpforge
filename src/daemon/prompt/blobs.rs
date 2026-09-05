//! Attachments uploaded inline with the prompt: images (base64) and text
//! documents (plain UTF-8).

use base64::Engine;
use warpforge_protocol::PromptAttachmentSummary;

use super::{Budget, PromptContent, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL};

pub(super) fn prepare_image(
    name: &str,
    mime_type: &str,
    data: &str,
    budget: &mut Budget,
) -> Result<(PromptContent, PromptAttachmentSummary), String> {
    if mime_type != "image/png" && mime_type != "image/jpeg" {
        return Err(format!("unsupported image MIME type: {mime_type}"));
    }
    if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err(format!("image exceeds 5 MiB: {name}"));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| format!("invalid base64 image: {name}"))?;
    if decoded.len() > MAX_IMAGE_BYTES {
        return Err(format!("image exceeds 5 MiB: {name}"));
    }
    budget.image = budget
        .image
        .checked_add(decoded.len())
        .ok_or("image data is too large")?;
    if budget.image > MAX_IMAGE_TOTAL {
        return Err("combined images exceed 10 MiB".into());
    }
    let valid = match mime_type {
        "image/png" => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => decoded.starts_with(&[0xff, 0xd8, 0xff]),
        _ => false,
    };
    if !valid {
        return Err(format!("image data does not match {mime_type}: {name}"));
    }
    Ok((
        PromptContent::Image {
            mime_type: mime_type.to_string(),
            data: data.to_string(),
        },
        PromptAttachmentSummary::Image {
            name: name.to_string(),
        },
    ))
}

/// Uploaded text files. Binary uploads are rejected rather than base64-encoded:
/// the ACP content blocks this daemon emits are `text`, `resource` and `image`
/// only, so there is nowhere for an opaque blob to go.
pub(super) fn prepare_document(
    name: &str,
    mime_type: &str,
    text: &str,
    budget: &mut Budget,
) -> Result<(PromptContent, PromptAttachmentSummary), String> {
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("attached file exceeds 512 KiB: {name}"));
    }
    if text.contains('\0') {
        return Err(format!("attached file is not text: {name}"));
    }
    super::charge_text(budget, text.len())?;
    let mime_type = if mime_type.is_empty() {
        "text/plain"
    } else {
        mime_type
    };
    Ok((
        PromptContent::Document {
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            text: text.to_string(),
        },
        PromptAttachmentSummary::Document {
            name: name.to_string(),
        },
    ))
}
