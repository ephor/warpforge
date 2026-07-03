//! Git-backed diff/review for a task. `working_diff` computes the project's
//! working-tree changes vs `HEAD` (plus untracked files as additions) into the
//! wire `FileDiff`/`Hunk` shape; `reject_hunk` reverts a single hunk in place.
//!
//! "Accept" is a no-op on the tree (the change stays); only "reject" touches
//! files, so review is non-destructive until you deliberately reject.

use std::process::Stdio;

use anyhow::{anyhow, bail, Result};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use warpforge_protocol as wire;

/// Working-tree diff for a git repo. Returns empty (Ok) if it isn't a repo.
pub async fn working_diff(repo: &str) -> Result<Vec<wire::FileDiff>> {
    let out = Command::new("git")
        .args(["-C", repo, "diff", "HEAD", "--no-color", "--no-ext-diff"])
        .output()
        .await?;
    let mut files = if out.status.success() {
        parse_unified(&String::from_utf8_lossy(&out.stdout))
    } else {
        Vec::new()
    };

    // Untracked files show as whole-file additions.
    let untracked = Command::new("git")
        .args(["-C", repo, "ls-files", "--others", "--exclude-standard"])
        .output()
        .await?;
    for name in String::from_utf8_lossy(&untracked.stdout).lines() {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(std::path::Path::new(repo).join(name)) else {
            continue;
        };
        let lines: Vec<String> = content.lines().map(|l| format!("+{l}")).collect();
        let new_lines = lines.len() as u32;
        files.push(wire::FileDiff {
            path: name.to_string(),
            old_path: None,
            status: wire::FileDiffStatus::Added,
            hunks: vec![wire::Hunk {
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines,
                lines,
                resolution: None,
            }],
        });
    }
    Ok(files)
}

/// Revert exactly one hunk of one file in the working tree.
pub async fn reject_hunk(repo: &str, file: &str, hunk_index: u32) -> Result<()> {
    let files = working_diff(repo).await?;
    let f = files
        .iter()
        .find(|f| f.path == file)
        .ok_or_else(|| anyhow!("file not in diff: {file}"))?;

    // Rejecting an added file means removing it.
    if f.status == wire::FileDiffStatus::Added {
        std::fs::remove_file(std::path::Path::new(repo).join(file))?;
        return Ok(());
    }

    let hunk = f
        .hunks
        .get(hunk_index as usize)
        .ok_or_else(|| anyhow!("hunk {hunk_index} out of range for {file}"))?;

    let patch = build_patch(f, hunk);
    let mut child = Command::new("git")
        .args(["-C", repo, "apply", "-R", "--recount", "--unidiff-zero", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).await?;
        stdin.flush().await?;
        drop(stdin);
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        bail!("git apply -R failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

fn build_patch(f: &wire::FileDiff, h: &wire::Hunk) -> String {
    let old = f.old_path.as_deref().unwrap_or(&f.path);
    let mut s = String::new();
    s.push_str(&format!("--- a/{old}\n+++ b/{}\n", f.path));
    s.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        h.old_start, h.old_lines, h.new_start, h.new_lines
    ));
    for line in &h.lines {
        s.push_str(line);
        s.push('\n');
    }
    s
}

fn parse_unified(text: &str) -> Vec<wire::FileDiff> {
    let mut files: Vec<wire::FileDiff> = Vec::new();
    let mut cur: Option<wire::FileDiff> = None;
    let mut hunk: Option<wire::Hunk> = None;

    fn flush_hunk(cur: &mut Option<wire::FileDiff>, hunk: &mut Option<wire::Hunk>) {
        if let (Some(f), Some(h)) = (cur.as_mut(), hunk.take()) {
            f.hunks.push(h);
        }
    }

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush_hunk(&mut cur, &mut hunk);
            if let Some(f) = cur.take() {
                files.push(f);
            }
            let (a, b) = header_paths(rest);
            cur = Some(wire::FileDiff {
                path: b.unwrap_or_default(),
                old_path: a,
                status: wire::FileDiffStatus::Modified,
                hunks: Vec::new(),
            });
            continue;
        }

        if line.starts_with("@@") {
            flush_hunk(&mut cur, &mut hunk);
            hunk = parse_hunk_header(line);
            continue;
        }

        // Inside a hunk body, prefixed lines are content (disambiguates "-x"
        // removals from the "--- a/…" header, which only appears before @@).
        if let Some(h) = hunk.as_mut() {
            if line.starts_with('\\') {
                continue; // "\ No newline at end of file"
            }
            if line.starts_with(' ') || line.starts_with('+') || line.starts_with('-') {
                h.lines.push(line.to_string());
            }
            continue;
        }

        let Some(f) = cur.as_mut() else { continue };
        if line.starts_with("new file mode") {
            f.status = wire::FileDiffStatus::Added;
        } else if line.starts_with("deleted file mode") {
            f.status = wire::FileDiffStatus::Deleted;
        } else if let Some(x) = line.strip_prefix("rename from ") {
            f.old_path = Some(x.to_string());
            f.status = wire::FileDiffStatus::Renamed;
        } else if let Some(x) = line.strip_prefix("rename to ") {
            f.path = x.to_string();
            f.status = wire::FileDiffStatus::Renamed;
        } else if let Some(x) = line.strip_prefix("--- ") {
            if let Some(p) = x.strip_prefix("a/") {
                f.old_path = Some(p.to_string());
            }
        } else if let Some(x) = line.strip_prefix("+++ ") {
            if let Some(p) = x.strip_prefix("b/") {
                f.path = p.to_string();
            }
        }
    }

    flush_hunk(&mut cur, &mut hunk);
    if let Some(f) = cur.take() {
        files.push(f);
    }
    files
}

fn header_paths(rest: &str) -> (Option<String>, Option<String>) {
    let mut it = rest.split_whitespace();
    let a = it.next().map(|s| s.strip_prefix("a/").unwrap_or(s).to_string());
    let b = it.next().map(|s| s.strip_prefix("b/").unwrap_or(s).to_string());
    (a, b)
}

fn parse_hunk_header(line: &str) -> Option<wire::Hunk> {
    let core = line.strip_prefix("@@ ")?;
    let end = core.find(" @@")?;
    let mut parts = core[..end].split_whitespace();
    let (old_start, old_lines) = parse_range(parts.next()?.strip_prefix('-')?);
    let (new_start, new_lines) = parse_range(parts.next()?.strip_prefix('+')?);
    Some(wire::Hunk { old_start, old_lines, new_start, new_lines, lines: Vec::new(), resolution: None })
}

fn parse_range(s: &str) -> (u32, u32) {
    let mut it = s.split(',');
    let start = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let lines = it.next().and_then(|x| x.parse().ok()).unwrap_or(1);
    (start, lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(repo: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .await
            .unwrap();
        assert!(status.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&status.stderr));
    }

    #[tokio::test]
    async fn diff_parses_and_reject_reverts() {
        let dir = std::env::temp_dir().join(format!("wf-diff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();

        git(&dir, &["init", "-q"]).await;
        git(&dir, &["config", "user.email", "t@t"]).await;
        git(&dir, &["config", "user.name", "t"]).await;
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(&dir, &["add", "."]).await;
        git(&dir, &["commit", "-q", "-m", "init"]).await;

        // Modify a tracked line.
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();

        let files = working_diff(repo).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, wire::FileDiffStatus::Modified);
        assert_eq!(files[0].hunks.len(), 1);
        let body = files[0].hunks[0].lines.join("\n");
        assert!(body.contains("-two"), "hunk shows removal: {body}");
        assert!(body.contains("+TWO"), "hunk shows addition: {body}");

        // Reject the hunk -> file returns to its committed content.
        reject_hunk(repo, "a.txt", 0).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
        assert!(working_diff(repo).await.unwrap().is_empty(), "no changes after reject");

        std::fs::remove_dir_all(&dir).ok();
    }
}
