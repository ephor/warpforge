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

/// Project files for the editor tree. Prefer git's view (tracked +
/// untracked, honoring .gitignore); fall back to a small filesystem walk for
/// non-git projects.
pub async fn list_files(repo: &str) -> Result<Vec<wire::ProjectFile>> {
    let out = Command::new("git")
        .args([
            "-C",
            repo,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await?;

    if out.status.success() {
        let changed = working_diff(repo)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.path)
            .collect::<std::collections::HashSet<_>>();
        let mut files = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let path = line.trim();
                (!path.is_empty()).then(|| wire::ProjectFile {
                    path: path.to_string(),
                    changed: changed.contains(path),
                })
            })
            .collect::<Vec<_>>();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        return Ok(files);
    }

    let mut files = Vec::new();
    walk_files(
        std::path::Path::new(repo),
        std::path::Path::new(repo),
        &mut files,
    )?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn walk_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<wire::ProjectFile>,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(
            name.as_ref(),
            ".git" | "node_modules" | "target" | "dist" | ".next"
        ) {
            continue;
        }
        if path.is_dir() {
            walk_files(root, &path, out)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(wire::ProjectFile {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    changed: false,
                });
            }
        }
    }
    Ok(())
}

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

/// Current branch of a git repo (`HEAD` short name), or None if not a repo or
/// detached.
pub async fn current_branch(repo: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

// ── Update Project / branch switch (autostash + atomic rollback) ────────────
//
// Both ops treat the working tree as sacred: if anything conflicts, we restore
// the exact prior state (branch, HEAD, and uncommitted changes) and report the
// blocking files, rather than leaving a half-merged tree an agent might commit.

async fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    Ok(Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await?)
}

fn errline(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

async fn rev_parse_head(repo: &str) -> Result<String> {
    let out = git(repo, &["rev-parse", "HEAD"]).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// True if the working tree has any tracked or untracked changes.
async fn is_dirty(repo: &str) -> Result<bool> {
    let out = git(repo, &["status", "--porcelain"]).await?;
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// Files left unmerged (conflict markers) after a failed rebase/stash-pop.
async fn unmerged_files(repo: &str) -> Vec<String> {
    match git(repo, &["diff", "--name-only", "--diff-filter=U"]).await {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn op_error(msg: impl Into<String>) -> wire::GitOpResult {
    wire::GitOpResult {
        status: wire::GitOpStatus::Error,
        message: msg.into(),
        conflicts: Vec::new(),
        branch: None,
    }
}

fn op_conflict(
    msg: impl Into<String>,
    conflicts: Vec<String>,
    branch: Option<String>,
) -> wire::GitOpResult {
    wire::GitOpResult {
        status: wire::GitOpStatus::Conflict,
        message: msg.into(),
        conflicts,
        branch,
    }
}

/// `git.update`: fetch + rebase the current branch onto its upstream, stashing
/// and restoring uncommitted changes around it. Any conflict rolls back.
pub async fn update_project(repo: &str) -> Result<wire::GitOpResult> {
    let branch = match current_branch(repo).await {
        Some(b) => b,
        None => {
            return Ok(op_error(
                "not on a branch (detached HEAD or not a git repo)",
            ))
        }
    };

    // Need an upstream to update from.
    let upstream = git(
        repo,
        &["rev-parse", "--abbrev-ref", "--verify", "-q", "@{u}"],
    )
    .await?;
    if !upstream.status.success() {
        return Ok(op_error(format!("no upstream configured for '{branch}'")));
    }

    let fetch = git(repo, &["fetch"]).await?;
    if !fetch.status.success() {
        return Ok(op_error(format!("git fetch failed: {}", errline(&fetch))));
    }

    let start = rev_parse_head(repo).await?;
    let dirty = is_dirty(repo).await?;
    if dirty {
        let st = git(repo, &["stash", "push", "-u", "-m", "warpforge-update"]).await?;
        if !st.status.success() {
            return Ok(op_error(format!("git stash failed: {}", errline(&st))));
        }
    }

    // Rebase onto the freshly-fetched upstream.
    let rebase = git(repo, &["rebase", "@{u}"]).await?;
    if !rebase.status.success() {
        // Local commits conflict with the incoming ones. Capture before abort
        // (abort clears the unmerged state), then restore the prior tree.
        let conflicts = unmerged_files(repo).await;
        let _ = git(repo, &["rebase", "--abort"]).await; // HEAD + tree back to `start`
        if dirty {
            let _ = git(repo, &["stash", "pop"]).await; // clean reapply onto `start`
        }
        return Ok(op_conflict(
            format!("update rolled back — '{branch}' and its upstream have conflicting commits"),
            conflicts,
            Some(branch),
        ));
    }

    // Rebase clean; put uncommitted changes back on top.
    if dirty {
        let pop = git(repo, &["stash", "pop"]).await?;
        if !pop.status.success() {
            // Uncommitted changes clash with the pulled update → full rollback:
            // discard the pulled commits + conflict markers, reapply the stash
            // onto the original HEAD (where it was taken, so it's always clean).
            let conflicts = unmerged_files(repo).await;
            let _ = git(repo, &["reset", "--hard", &start]).await;
            let _ = git(repo, &["stash", "pop"]).await;
            return Ok(op_conflict(
                format!("update rolled back — your uncommitted changes conflict with the incoming update on '{branch}'"),
                conflicts,
                Some(branch),
            ));
        }
    }

    let head = rev_parse_head(repo).await?;
    if head == start {
        Ok(wire::GitOpResult {
            status: wire::GitOpStatus::UpToDate,
            message: format!("already up to date on '{branch}'"),
            conflicts: Vec::new(),
            branch: Some(branch),
        })
    } else {
        Ok(wire::GitOpResult {
            status: wire::GitOpStatus::Ok,
            message: format!("updated '{branch}' from upstream"),
            conflicts: Vec::new(),
            branch: Some(branch),
        })
    }
}

/// `git.branches`: local branch names + the current one.
pub async fn list_branches(repo: &str) -> Result<wire::GitBranchList> {
    let out = git(repo, &["branch", "--format=%(refname:short)"]).await?;
    if !out.status.success() {
        bail!("git branch failed: {}", errline(&out));
    }
    let branches = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(wire::GitBranchList {
        current: current_branch(repo).await,
        branches,
    })
}

/// `git.switchBranch`: smart checkout — stash uncommitted changes, switch, then
/// reapply them on the target. A conflict rolls back to the original branch
/// with the changes intact (nothing is ever discarded).
pub async fn switch_branch(repo: &str, target: &str) -> Result<wire::GitOpResult> {
    let from = match current_branch(repo).await {
        Some(b) => b,
        None => {
            return Ok(op_error(
                "not on a branch (detached HEAD or not a git repo)",
            ))
        }
    };
    if target == from {
        return Ok(wire::GitOpResult {
            status: wire::GitOpStatus::UpToDate,
            message: format!("already on '{target}'"),
            conflicts: Vec::new(),
            branch: Some(from),
        });
    }
    let verify = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/heads/{target}"),
        ],
    )
    .await?;
    if !verify.status.success() {
        return Ok(op_error(format!("no local branch '{target}'")));
    }

    let dirty = is_dirty(repo).await?;
    if dirty {
        let st = git(repo, &["stash", "push", "-u", "-m", "warpforge-switch"]).await?;
        if !st.status.success() {
            return Ok(op_error(format!("git stash failed: {}", errline(&st))));
        }
    }

    let checkout = git(repo, &["checkout", target]).await?;
    if !checkout.status.success() {
        if dirty {
            let _ = git(repo, &["stash", "pop"]).await; // still on `from`, reapply
        }
        return Ok(op_error(format!(
            "git checkout failed: {}",
            errline(&checkout)
        )));
    }

    if dirty {
        let pop = git(repo, &["stash", "pop"]).await?;
        if !pop.status.success() {
            // Changes conflict with the target branch → go back to `from`,
            // discard the conflicted partial apply, reapply the stash cleanly.
            let conflicts = unmerged_files(repo).await;
            let _ = git(repo, &["checkout", "-f", &from]).await;
            let _ = git(repo, &["stash", "pop"]).await;
            return Ok(op_conflict(
                format!("stayed on '{from}' — your uncommitted changes conflict with '{target}'"),
                conflicts,
                Some(from),
            ));
        }
    }

    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: format!("switched to '{target}'"),
        conflicts: Vec::new(),
        branch: Some(target.to_string()),
    })
}

/// A file's old (HEAD) and new (working-tree) text, for the editable review.
pub async fn file_doc(repo: &str, path: &str) -> Result<wire::FileDoc> {
    if path.contains("..") {
        bail!("refusing path with ..: {path}");
    }
    let show = Command::new("git")
        .args(["-C", repo, "show", &format!("HEAD:{path}")])
        .output()
        .await?;
    let in_head = show.status.success();
    let old_text = if in_head {
        String::from_utf8_lossy(&show.stdout).to_string()
    } else {
        String::new()
    };

    let full = std::path::Path::new(repo).join(path);
    let in_tree = full.is_file();
    let new_text = if in_tree {
        std::fs::read_to_string(&full).unwrap_or_default()
    } else {
        String::new()
    };

    let status = match (in_head, in_tree) {
        (true, true) => wire::FileDiffStatus::Modified,
        (false, true) => wire::FileDiffStatus::Added,
        (true, false) => wire::FileDiffStatus::Deleted,
        (false, false) => wire::FileDiffStatus::Modified,
    };
    Ok(wire::FileDoc {
        path: path.to_string(),
        status,
        old_text,
        new_text,
    })
}

/// Write new contents to a file in the working tree (an in-review edit).
pub fn save_file(repo: &str, path: &str, content: &str) -> Result<()> {
    if path.contains("..") {
        bail!("refusing path with ..: {path}");
    }
    let full = std::path::Path::new(repo).join(path);
    if let Some(dir) = full.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(full, content)?;
    Ok(())
}

/// Stage files (all changes if `files` is None, else exactly those paths) and
/// commit them. `amend` rewrites the previous commit instead of creating a new
/// one. Returns git's stderr on failure.
pub async fn commit(
    repo: &str,
    message: &str,
    files: Option<&[String]>,
    amend: bool,
) -> Result<()> {
    // Stage.
    let mut add = Command::new("git");
    add.args(["-C", repo, "add", "--"]);
    match files {
        Some(paths) if !paths.is_empty() => {
            for p in paths {
                if p.contains("..") {
                    bail!("refusing path with ..: {p}");
                }
                add.arg(p);
            }
        }
        _ => {
            add.arg(".");
        }
    }
    let out = add.output().await?;
    if !out.status.success() {
        bail!(
            "git add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }

    // Commit.
    let mut ci = Command::new("git");
    ci.args(["-C", repo, "commit", "-m", message]);
    if amend {
        ci.arg("--amend");
    }
    let out = ci.output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        bail!("git commit failed: {}", msg.trim());
    }
    Ok(())
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
        .args([
            "-C",
            repo,
            "apply",
            "-R",
            "--recount",
            "--unidiff-zero",
            "-",
        ])
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
        bail!(
            "git apply -R failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
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
    let a = it
        .next()
        .map(|s| s.strip_prefix("a/").unwrap_or(s).to_string());
    let b = it
        .next()
        .map(|s| s.strip_prefix("b/").unwrap_or(s).to_string());
    (a, b)
}

fn parse_hunk_header(line: &str) -> Option<wire::Hunk> {
    let core = line.strip_prefix("@@ ")?;
    let end = core.find(" @@")?;
    let mut parts = core[..end].split_whitespace();
    let (old_start, old_lines) = parse_range(parts.next()?.strip_prefix('-')?);
    let (new_start, new_lines) = parse_range(parts.next()?.strip_prefix('+')?);
    Some(wire::Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: Vec::new(),
        resolution: None,
    })
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
        assert!(
            status.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&status.stderr)
        );
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
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one\ntwo\nthree\n"
        );
        assert!(
            working_diff(repo).await.unwrap().is_empty(),
            "no changes after reject"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    async fn init_repo(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]).await;
        git(dir, &["config", "user.email", "t@t"]).await;
        git(dir, &["config", "user.name", "t"]).await;
    }

    #[tokio::test]
    async fn switch_branch_carries_dirty_changes() {
        let dir = std::env::temp_dir().join(format!("wf-sw-{}", uuid::Uuid::new_v4()));
        let repo = dir.to_str().unwrap();
        init_repo(&dir).await;
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]).await;
        git(&dir, &["commit", "-q", "-m", "init"]).await;
        git(&dir, &["branch", "feature"]).await;

        // Uncommitted (non-conflicting) change, then switch.
        std::fs::write(dir.join("a.txt"), "base\ndirty\n").unwrap();
        let r = switch_branch(repo, "feature").await.unwrap();

        assert_eq!(r.status, wire::GitOpStatus::Ok, "{}", r.message);
        assert_eq!(current_branch(repo).await.as_deref(), Some("feature"));
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "base\ndirty\n",
            "uncommitted change carried onto feature"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn switch_branch_conflict_rolls_back() {
        let dir = std::env::temp_dir().join(format!("wf-swc-{}", uuid::Uuid::new_v4()));
        let repo = dir.to_str().unwrap();
        init_repo(&dir).await;
        std::fs::write(dir.join("a.txt"), "line\n").unwrap();
        git(&dir, &["add", "."]).await;
        git(&dir, &["commit", "-q", "-m", "init"]).await;
        let base = current_branch(repo).await.unwrap();

        // feature diverges on the same line.
        git(&dir, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(dir.join("a.txt"), "feature-change\n").unwrap();
        git(&dir, &["commit", "-qam", "feature"]).await;
        git(&dir, &["checkout", "-q", &base]).await;

        // Uncommitted change on the same line → conflicts with feature.
        std::fs::write(dir.join("a.txt"), "local-uncommitted\n").unwrap();
        let r = switch_branch(repo, "feature").await.unwrap();

        assert_eq!(r.status, wire::GitOpStatus::Conflict, "{}", r.message);
        assert_eq!(
            current_branch(repo).await.as_deref(),
            Some(base.as_str()),
            "rolled back to the original branch"
        );
        let content = std::fs::read_to_string(dir.join("a.txt")).unwrap();
        assert_eq!(
            content, "local-uncommitted\n",
            "dirty change restored intact"
        );
        assert!(
            !content.contains("<<<<<<<"),
            "no conflict markers left behind"
        );
        assert!(
            unmerged_files(repo).await.is_empty(),
            "tree is not left in a half-merged state"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn update_project_rebases_and_keeps_dirty() {
        let root = std::env::temp_dir().join(format!("wf-upd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let origin_url = origin.to_str().unwrap();

        // Bare origin + two clones (one advances upstream).
        git(&root, &["init", "--bare", "-q", origin_url]).await;
        git(&root, &["clone", "-q", origin_url, "work"]).await;
        let work = root.join("work");
        let workp = work.to_str().unwrap();
        git(&work, &["config", "user.email", "t@t"]).await;
        git(&work, &["config", "user.name", "t"]).await;
        std::fs::write(work.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "."]).await;
        git(&work, &["commit", "-q", "-m", "init"]).await;
        git(&work, &["push", "-q", "-u", "origin", "HEAD"]).await;

        git(&root, &["clone", "-q", origin_url, "other"]).await;
        let other = root.join("other");
        git(&other, &["config", "user.email", "t@t"]).await;
        git(&other, &["config", "user.name", "t"]).await;
        std::fs::write(other.join("b.txt"), "upstream\n").unwrap();
        git(&other, &["add", "."]).await;
        git(&other, &["commit", "-q", "-m", "upstream"]).await;
        git(&other, &["push", "-q", "origin", "HEAD"]).await;

        // work has a dirty (untracked) file; update should pull + preserve it.
        std::fs::write(work.join("dirty.txt"), "wip\n").unwrap();
        let r = update_project(workp).await.unwrap();

        assert_eq!(r.status, wire::GitOpStatus::Ok, "{}", r.message);
        assert!(work.join("b.txt").is_file(), "upstream commit pulled in");
        assert_eq!(
            std::fs::read_to_string(work.join("dirty.txt")).unwrap(),
            "wip\n",
            "uncommitted change preserved across update"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
