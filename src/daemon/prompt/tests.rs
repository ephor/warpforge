use std::fs;
use std::io::Write;

use base64::Engine;
use warpforge_protocol::{LineRange, PromptAttachment, PromptAttachmentSummary};

use super::*;

fn root() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn document(name: &str, text: impl Into<String>) -> PromptAttachment {
    PromptAttachment::Document {
        name: name.into(),
        mime_type: "text/markdown".into(),
        text: text.into(),
    }
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
    // The UI allows ten images, so ten must pass and eleven must not.
    let ten = vec![image.clone(); MAX_IMAGES];
    assert!(prepare_prompt(dir.path(), String::new(), &ten).is_ok());
    let eleven = vec![image; MAX_IMAGES + 1];
    assert!(prepare_prompt(dir.path(), String::new(), &eleven)
        .unwrap_err()
        .contains("10 images"));
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
fn accepts_documents_and_rejects_binary_or_oversized() {
    let dir = root();
    let ok = prepare_prompt(
        dir.path(),
        "read this".into(),
        &[document("notes.md", "# Notes\nbody")],
    )
    .unwrap();
    assert_eq!(ok.content.len(), 2);
    assert!(!ok.has_images);
    assert_eq!(
        ok.summaries,
        vec![PromptAttachmentSummary::Document {
            name: "notes.md".into()
        }]
    );
    match &ok.content[1] {
        PromptContent::Document {
            name,
            mime_type,
            text,
        } => {
            assert_eq!(name, "notes.md");
            assert_eq!(mime_type, "text/markdown");
            assert_eq!(text, "# Notes\nbody");
        }
        other => unreachable!("{other:?}"),
    }

    assert!(
        prepare_prompt(dir.path(), String::new(), &[document("bin", "a\0b")])
            .unwrap_err()
            .contains("is not text")
    );
    let oversized = "a".repeat(MAX_DOCUMENT_BYTES + 1);
    assert!(
        prepare_prompt(dir.path(), String::new(), &[document("big.txt", oversized)])
            .unwrap_err()
            .contains("512 KiB")
    );
    let too_many = (0..MAX_DOCUMENTS + 1)
        .map(|i| document(&format!("f{i}.md"), "x"))
        .collect::<Vec<_>>();
    assert!(prepare_prompt(dir.path(), String::new(), &too_many)
        .unwrap_err()
        .contains("at most 10 attached files"));
}

#[test]
fn documents_default_to_plain_text_when_the_mime_type_is_unknown() {
    let dir = root();
    let ok = prepare_prompt(
        dir.path(),
        String::new(),
        &[PromptAttachment::Document {
            name: "Makefile".into(),
            mime_type: String::new(),
            text: "all:\n\techo hi".into(),
        }],
    )
    .unwrap();
    match &ok.content[0] {
        PromptContent::Document { mime_type, .. } => assert_eq!(mime_type, "text/plain"),
        other => unreachable!("{other:?}"),
    }
}

#[test]
fn documents_share_the_text_budget_with_file_references() {
    let dir = root();
    fs::write(dir.path().join("part"), vec![b'a'; 500 * 1024]).unwrap();
    let mut attachments = vec![PromptAttachment::File {
        path: "part".into(),
        range: None,
    }];
    for index in 0..4 {
        attachments.push(document(&format!("d{index}.md"), "a".repeat(400 * 1024)));
    }
    assert!(prepare_prompt(dir.path(), String::new(), &attachments)
        .unwrap_err()
        .contains("2 MiB"));
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

#[test]
fn serializes_documents_as_resources_or_inline_text() {
    let doc = PromptContent::Document {
        name: "notes.md".into(),
        mime_type: "text/markdown".into(),
        text: "hello".into(),
    };
    let embedded = doc.to_acp(true);
    assert_eq!(embedded["type"], "resource");
    assert_eq!(embedded["resource"]["uri"], "attachment://notes.md");
    assert_eq!(embedded["resource"]["mimeType"], "text/markdown");
    assert_eq!(embedded["resource"]["text"], "hello");
    let inline = doc.to_acp(false);
    assert_eq!(inline["type"], "text");
    let text = inline["text"].as_str().unwrap();
    assert!(text.contains("notes.md"), "{text}");
    assert!(text.contains("hello"), "{text}");
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
