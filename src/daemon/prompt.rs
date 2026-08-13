use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};
use warpforge_protocol::{LineRange, PromptAttachment, PromptAttachmentSummary};

const MAX_FILES: usize = 20;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
pub enum PromptContent {
    Text(String),
    Resource { uri: String, text: String },
    Image { mime_type: String, data: String },
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
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedPrompt {
    pub content: Vec<PromptContent>,
    pub summaries: Vec<PromptAttachmentSummary>,
    pub has_images: bool,
}

pub fn prepare_prompt(
    root: &Path,
    text: String,
    attachments: &[PromptAttachment],
) -> Result<PreparedPrompt, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve task worktree: {e}"))?;
    let file_count = attachments
        .iter()
        .filter(|a| matches!(a, PromptAttachment::File { .. }))
        .count();
    let image_count = attachments
        .iter()
        .filter(|a| matches!(a, PromptAttachment::Image { .. }))
        .count();
    if file_count > MAX_FILES {
        return Err(format!("at most {MAX_FILES} file references are allowed"));
    }
    if image_count > MAX_IMAGES {
        return Err(format!("at most {MAX_IMAGES} images are allowed"));
    }

    let mut content = if text.is_empty() {
        Vec::new()
    } else {
        vec![PromptContent::Text(text)]
    };
    let mut summaries = Vec::with_capacity(attachments.len());
    let mut text_total = 0usize;
    let mut image_total = 0usize;

    for attachment in attachments {
        match attachment {
            PromptAttachment::File { path, range } => {
                let (canonical, display) = secure_file(&root, path)?;
                let meta =
                    fs::metadata(&canonical).map_err(|e| format!("cannot read {path}: {e}"))?;
                if !meta.is_file() {
                    return Err(format!("attachment is not a file: {path}"));
                }
                let bytes = fs::read(&canonical).map_err(|e| format!("cannot read {path}: {e}"))?;
                let whole_text =
                    String::from_utf8(bytes).map_err(|_| format!("file is not UTF-8: {path}"))?;
                let file_text = match range {
                    Some(r) => slice_lines(&whole_text, r)?,
                    None => whole_text,
                };
                if (file_text.len() as u64) > MAX_FILE_BYTES {
                    return Err(format!("file exceeds 512 KiB: {path}"));
                }
                text_total = text_total
                    .checked_add(file_text.len())
                    .ok_or("file context is too large")?;
                if text_total > MAX_TEXT_BYTES {
                    return Err("combined file context exceeds 2 MiB".into());
                }
                content.push(PromptContent::Resource {
                    uri: file_uri(&canonical),
                    text: file_text,
                });
                let summary_path = match range {
                    Some(r) => {
                        let (s, e) = if r.start == r.end {
                            (r.start, 0)
                        } else {
                            (r.start, r.end)
                        };
                        if e == 0 {
                            format!("{display}#L{}", s)
                        } else {
                            format!("{display}#L{s}-{e}")
                        }
                    }
                    None => display.clone(),
                };
                summaries.push(PromptAttachmentSummary::File { path: summary_path });
            }
            PromptAttachment::Image {
                name,
                mime_type,
                data,
            } => {
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
                image_total = image_total
                    .checked_add(decoded.len())
                    .ok_or("image data is too large")?;
                if image_total > MAX_IMAGE_TOTAL {
                    return Err("combined images exceed 10 MiB".into());
                }
                let valid = match mime_type.as_str() {
                    "image/png" => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
                    "image/jpeg" => decoded.starts_with(&[0xff, 0xd8, 0xff]),
                    _ => false,
                };
                if !valid {
                    return Err(format!("image data does not match {mime_type}: {name}"));
                }
                content.push(PromptContent::Image {
                    mime_type: mime_type.clone(),
                    data: data.clone(),
                });
                summaries.push(PromptAttachmentSummary::Image { name: name.clone() });
            }
        }
    }
    Ok(PreparedPrompt {
        content,
        summaries,
        has_images: image_count > 0,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn prepares_valid_file_and_rejects_unsafe_or_binary_files() {
        let dir = root();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.rs"), "fn main() {}").unwrap();
        let ok = prepare_prompt(
            dir.path(),
            "review".into(),
            &[PromptAttachment::File {
                path: "src/a.rs".into(),
                range: None,
            }],
        )
        .unwrap();
        assert_eq!(ok.content.len(), 2);
        for path in ["/etc/passwd", "../outside", "missing", "src"] {
            assert!(
                prepare_prompt(
                    dir.path(),
                    String::new(),
                    &[PromptAttachment::File {
                        path: path.into(),
                        range: None
                    }]
                )
                .is_err(),
                "{path}"
            );
        }
        fs::write(dir.path().join("bad"), [0xff, 0xfe]).unwrap();
        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[PromptAttachment::File {
                path: "bad".into(),
                range: None
            }]
        )
        .unwrap_err()
        .contains("UTF-8"));
    }

    #[test]
    fn slices_files_to_a_line_range() {
        let dir = root();
        fs::write(dir.path().join("f.txt"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        for (range, expected, summary) in [
            (LineRange { start: 2, end: 4 }, "l2\nl3\nl4", "f.txt#L2-4"),
            (LineRange { start: 3, end: 3 }, "l3", "f.txt#L3"),
            (LineRange { start: 4, end: 99 }, "l4\nl5", "f.txt#L4-99"),
            (LineRange { start: 6, end: 8 }, "", "f.txt#L6-8"),
        ] {
            let ok = prepare_prompt(
                dir.path(),
                String::new(),
                &[PromptAttachment::File {
                    path: "f.txt".into(),
                    range: Some(range),
                }],
            )
            .unwrap_or_else(|e| panic!("{summary}: {e}"));
            match ok
                .content
                .iter()
                .find(|c| matches!(c, PromptContent::Resource { .. }))
            {
                Some(PromptContent::Resource { text, .. }) => {
                    assert_eq!(text, &expected, "{summary}")
                }
                _ => unreachable!("{summary}"),
            }
            assert_eq!(
                ok.summaries[0],
                PromptAttachmentSummary::File {
                    path: summary.into()
                }
            );
        }

        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[PromptAttachment::File {
                path: "f.txt".into(),
                range: Some(LineRange { start: 0, end: 2 }),
            }]
        )
        .is_err());
    }

    #[test]
    fn validates_images_and_limits() {
        let dir = root();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        let image = PromptAttachment::Image {
            name: "a.png".into(),
            mime_type: "image/png".into(),
            data: png,
        };
        assert!(prepare_prompt(dir.path(), String::new(), std::slice::from_ref(&image)).is_ok());
        let bad = PromptAttachment::Image {
            name: "a.png".into(),
            mime_type: "image/png".into(),
            data: "%%%".into(),
        };
        assert!(prepare_prompt(dir.path(), String::new(), &[bad]).is_err());
        let mismatch = PromptAttachment::Image {
            name: "a.png".into(),
            mime_type: "image/jpeg".into(),
            data: match &image {
                PromptAttachment::Image { data, .. } => data.clone(),
                _ => unreachable!(),
            },
        };
        assert!(prepare_prompt(dir.path(), String::new(), &[mismatch]).is_err());
        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[
                image.clone(),
                image.clone(),
                image.clone(),
                image.clone(),
                image
            ]
        )
        .is_err());
        let make_png = |size: usize, name: &str| {
            let mut bytes = vec![0u8; size];
            bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            PromptAttachment::Image {
                name: name.into(),
                mime_type: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            }
        };
        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[make_png(MAX_IMAGE_BYTES + 1, "large.png")]
        )
        .is_err());
        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[
                make_png(4 * 1024 * 1024, "1.png"),
                make_png(4 * 1024 * 1024, "2.png"),
                make_png(4 * 1024 * 1024, "3.png")
            ]
        )
        .unwrap_err()
        .contains("10 MiB"));
    }

    #[test]
    fn enforces_file_size_and_total() {
        let dir = root();
        let mut f = fs::File::create(dir.path().join("large")).unwrap();
        f.write_all(&vec![b'a'; MAX_FILE_BYTES as usize + 1])
            .unwrap();
        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[PromptAttachment::File {
                path: "large".into(),
                range: None,
            }]
        )
        .is_err());
        let mut many = Vec::new();
        for index in 0..5 {
            let name = format!("part-{index}");
            fs::write(dir.path().join(&name), vec![b'a'; 500 * 1024]).unwrap();
            many.push(PromptAttachment::File {
                path: name,
                range: None,
            });
        }
        assert!(prepare_prompt(dir.path(), String::new(), &many)
            .unwrap_err()
            .contains("2 MiB"));
        let repeated = (0..21)
            .map(|_| PromptAttachment::File {
                path: "part-0".into(),
                range: None,
            })
            .collect::<Vec<_>>();
        assert!(prepare_prompt(dir.path(), String::new(), &repeated)
            .unwrap_err()
            .contains("20"));
    }

    #[test]
    fn serializes_resources_with_capability_fallback_and_images_as_acp_blocks() {
        let resource = PromptContent::Resource {
            uri: "file:///tmp/a.rs".into(),
            text: "hello".into(),
        };
        assert_eq!(resource.to_acp(true)["type"], "resource");
        assert_eq!(resource.to_acp(false)["type"], "text");
        assert!(resource.to_acp(false)["text"]
            .as_str()
            .unwrap()
            .contains("Attached file"));
        let image = PromptContent::Image {
            mime_type: "image/png".into(),
            data: "abc".into(),
        };
        assert_eq!(image.to_acp(true)["mimeType"], "image/png");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let dir = root();
        symlink("/etc/passwd", dir.path().join("link")).unwrap();
        assert!(prepare_prompt(
            dir.path(),
            String::new(),
            &[PromptAttachment::File {
                path: "link".into(),
                range: None,
            }]
        )
        .is_err());
    }
}
