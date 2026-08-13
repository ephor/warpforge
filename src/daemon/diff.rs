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

/// Build/dependency directories, skipped at any depth. Keeping them costs
/// ~162k entries on this repo alone, and the editor tree never wants them —
/// but other .gitignore'd files (`.env` and friends) stay listed.
const HEAVY_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next"];

/// OS / editor junk never shown in the file tree.
const IGNORED_NAMES: &[&str] = &[
    ".DS_Store",
    "Thumbs.db",
    "Desktop.ini",
    ".AppleDouble",
    ".LSOverride",
    "._*",
    "*.swp",
    "*.swo",
    "*~",
];

/// Project files for the editor tree. Prefer git's view (tracked +
/// untracked); fall back to a small filesystem walk for non-git projects.
/// `include_ignored` keeps .gitignore'd paths in the list.
pub async fn list_files(repo: &str, include_ignored: bool) -> Result<Vec<wire::ProjectFile>> {
    let mut args = vec!["-C", repo, "ls-files", "--cached", "--others"];
    if !include_ignored {
        args.push("--exclude-standard");
    }
    let out = Command::new("git").args(&args).output().await?;

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
                (!path.is_empty() && !is_ignored_path(path)).then(|| wire::ProjectFile {
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

fn is_ignored_path(path: &str) -> bool {
    if path.split('/').any(|part| HEAVY_DIRS.contains(&part)) {
        return true;
    }
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    IGNORED_NAMES.iter().any(|pat| {
        if let Some(ext) = pat.strip_prefix("*.") {
            name.ends_with(ext)
        } else if let Some(prefix) = pat.strip_prefix(".*") {
            name == prefix || name.starts_with(&format!(".{prefix}"))
        } else if pat.ends_with('/') {
            path.starts_with(pat)
        } else {
            name == *pat
        }
    })
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
        if HEAVY_DIRS.contains(&name.as_ref()) {
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
            Some(branch.to_string()),
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
                Some(branch.to_string()),
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

/// Run `gh` in `repo`, mapping a missing binary to a friendly message.
async fn gh(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    Command::new("gh")
        .current_dir(repo)
        .args(args)
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow!(
                    "GitHub CLI (`gh`) is not installed. Install it (`brew install gh`) and run \
                     `gh auth login`."
                )
            } else {
                anyhow!(e)
            }
        })
}

fn friendly_gh_error(stderr: &str) -> String {
    let low = stderr.to_lowercase();
    if low.contains("auth") || low.contains("not logged in") || low.contains("gh auth login") {
        return format!(
            "GitHub CLI is not authenticated. Run `gh auth login` and retry. ({stderr})"
        );
    }
    if stderr.trim().is_empty() {
        "gh pr create failed".to_string()
    } else {
        format!("gh pr create failed: {}", stderr.trim())
    }
}

/// `git.createPr`: open a GitHub pull request for the current branch via `gh`.
/// Requires `gh` on PATH and authenticated. Returns the PR URL. If a PR for the
/// branch already exists, returns its URL instead of erroring.
pub async fn create_pr(repo: &str, title: &str, body: &str, base: Option<&str>) -> Result<String> {
    let branch = current_branch(repo)
        .await
        .ok_or_else(|| anyhow!("not on a branch (detached HEAD or not a git repo)"))?;

    let mut args: Vec<&str> = vec!["pr", "create", "--head", &branch, "--title", title];
    if !body.trim().is_empty() {
        args.push("--body");
        args.push(body);
    } else {
        args.push("--body");
        args.push("");
    }
    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(base) = base {
        args.push("--base");
        args.push(base);
    }

    let out = gh(repo, &args).await?;
    if out.status.success() {
        // gh prints the PR URL as the last line of stdout.
        let stdout = String::from_utf8_lossy(&out.stdout);
        let url = stdout
            .lines()
            .rev()
            .find(|l| l.contains("://"))
            .unwrap_or("");
        return Ok(url.trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&out.stderr);
    // A branch that already has a PR: surface the existing one instead of failing.
    if stderr.to_lowercase().contains("already exists") {
        if let Ok(view) = gh(repo, &["pr", "view", "--json", "url", "--jq", ".url"]).await {
            if view.status.success() {
                let url = String::from_utf8_lossy(&view.stdout).trim().to_string();
                if !url.is_empty() {
                    return Ok(url);
                }
            }
        }
    }
    Err(anyhow!(friendly_gh_error(&stderr)))
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
    let remote_out = git(repo, &["branch", "-r", "--format=%(refname:short)"]).await?;
    let remotes = if remote_out.status.success() {
        String::from_utf8_lossy(&remote_out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && l.contains('/'))
            .collect()
    } else {
        Vec::new()
    };
    Ok(wire::GitBranchList {
        current: current_branch(repo).await,
        branches,
        remotes,
    })
}

/// Build the lightweight push preview used by the desktop dialog. This reads
/// only local refs; opening the dialog never performs network I/O.
pub async fn push_info(repo: &str) -> Result<wire::GitPushInfo> {
    let branch = current_branch(repo)
        .await
        .ok_or_else(|| anyhow!("not on a branch (detached HEAD or not a git repo)"))?;

    let configured_upstream = git(
        repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await?;
    let upstream = configured_upstream
        .status
        .success()
        .then(|| {
            String::from_utf8_lossy(&configured_upstream.stdout)
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty());

    let remote = if let Some(upstream) = &upstream {
        upstream.split('/').next().unwrap_or("origin").to_string()
    } else {
        let configured = git(
            repo,
            &["config", "--get", &format!("branch.{branch}.remote")],
        )
        .await?;
        let value = String::from_utf8_lossy(&configured.stdout)
            .trim()
            .to_string();
        if configured.status.success() && !value.is_empty() && value != "." {
            value
        } else {
            let origin = git(repo, &["remote", "get-url", "origin"]).await?;
            if origin.status.success() {
                "origin".to_string()
            } else {
                let remotes = git(repo, &["remote"]).await?;
                String::from_utf8_lossy(&remotes.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|name| !name.is_empty())
                    .ok_or_else(|| anyhow!("no git remote configured"))?
                    .to_string()
            }
        }
    };
    let remote_branch = upstream
        .as_deref()
        .and_then(|value| value.strip_prefix(&format!("{remote}/")))
        .unwrap_or(&branch)
        .to_string();
    let target = upstream
        .clone()
        .unwrap_or_else(|| format!("{remote}/{remote_branch}"));

    // Prefer the exact upstream/same-name remote branch. For a brand-new
    // branch, list only commits unreachable from every branch on that remote.
    // This also works when the remote has no symbolic `origin/HEAD` ref.
    let target_exists = git(repo, &["rev-parse", "--verify", "-q", &target]).await?;
    let log = if target_exists.status.success() {
        let range = format!("{target}..HEAD");
        git(
            repo,
            &["log", "--reverse", "--format=%H%x1f%h%x1f%s%x1f%an", &range],
        )
        .await?
    } else {
        let remote_refs = format!("--remotes={remote}");
        git(
            repo,
            &[
                "log",
                "--reverse",
                "--format=%H%x1f%h%x1f%s%x1f%an",
                "HEAD",
                "--not",
                &remote_refs,
            ],
        )
        .await?
    };
    if !log.status.success() {
        bail!("git log failed: {}", errline(&log));
    }
    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&log.stdout).lines() {
        let mut fields = line.splitn(4, '\u{1f}');
        let Some(hash) = fields.next().filter(|value| !value.is_empty()) else {
            continue;
        };
        let short_hash = fields.next().unwrap_or(hash).to_string();
        let subject = fields.next().unwrap_or_default().to_string();
        let author = fields.next().unwrap_or_default().to_string();
        let changed = git(
            repo,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "-M",
                hash,
            ],
        )
        .await?;
        let files = String::from_utf8_lossy(&changed.stdout)
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let raw_status = parts.next()?.trim();
                let first_path = parts.next()?.trim();
                let path = if raw_status.starts_with('R') || raw_status.starts_with('C') {
                    parts.next().unwrap_or(first_path).trim()
                } else {
                    first_path
                };
                (!path.is_empty()).then(|| wire::GitPushFile {
                    path: path.to_string(),
                    status: raw_status.chars().next().unwrap_or('M').to_string(),
                })
            })
            .collect();
        commits.push(wire::GitPushCommit {
            hash: hash.to_string(),
            short_hash,
            subject,
            author,
            files,
        });
    }

    Ok(wire::GitPushInfo {
        branch,
        remote,
        remote_branch,
        upstream: target,
        has_upstream: upstream.is_some(),
        commits,
    })
}

/// Push the current branch, creating its upstream when necessary. Force push
/// deliberately means `--force-with-lease`: the modal should not overwrite
/// remote work that appeared since the last fetch.
pub async fn push(repo: &str, force: bool) -> Result<wire::GitOpResult> {
    let info = push_info(repo).await?;
    if info.commits.is_empty() {
        return Ok(wire::GitOpResult {
            status: wire::GitOpStatus::UpToDate,
            message: format!("'{}' is already up to date", info.branch),
            conflicts: Vec::new(),
            branch: Some(info.branch),
        });
    }

    let mut args = vec!["push"];
    if force {
        args.push("--force-with-lease");
    }
    if !info.has_upstream {
        args.extend(["--set-upstream", info.remote.as_str(), info.branch.as_str()]);
    }
    let out = git(repo, &args).await?;
    if !out.status.success() {
        return Ok(op_error(format!("git push failed: {}", errline(&out))));
    }
    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: format!(
            "pushed '{}' to '{}'{}",
            info.branch,
            info.upstream,
            if force { " with force-with-lease" } else { "" }
        ),
        conflicts: Vec::new(),
        branch: Some(info.branch),
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

/// `git.branchRename`: rename a local branch to `new_name` (works on the branch
/// you're on or any other). Errors if `new_name` already exists.
pub async fn rename_branch(repo: &str, branch: &str, new_name: &str) -> Result<wire::GitOpResult> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Ok(op_error("new branch name is empty"));
    }
    if new_name == branch {
        return Ok(wire::GitOpResult {
            status: wire::GitOpStatus::UpToDate,
            message: "branch name already matches".to_string(),
            conflicts: Vec::new(),
            branch: Some(branch.to_string()),
        });
    }
    if new_name.contains(" ") {
        return Ok(op_error("branch name must not contain spaces"));
    }
    let exists = git(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{new_name}"),
        ],
    )
    .await?;
    if exists.status.success() {
        return Ok(op_error(format!(
            "a branch named '{new_name}' already exists"
        )));
    }

    let out = git(repo, &["branch", "-m", branch, new_name]).await?;
    if !out.status.success() {
        return Ok(op_error(format!("git branch -m failed: {}", errline(&out))));
    }
    let is_current = current_branch(repo).await.as_deref() == Some(branch);
    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: format!("renamed '{branch}' to '{new_name}'"),
        conflicts: Vec::new(),
        // The active branch's name changed — reflect it so clients can update.
        branch: is_current.then(|| new_name.to_string()),
    })
}

/// `git.branchDelete`: delete a local branch. Refuses the checked-out branch;
/// without `force` also refuses unmerged branches (matches `git branch -d`).
pub async fn delete_branch(repo: &str, branch: &str, force: bool) -> Result<wire::GitOpResult> {
    if current_branch(repo).await.as_deref() == Some(branch) {
        return Ok(op_error(format!(
            "cannot delete the branch you are currently on ('{branch}'); switch first"
        )));
    }
    let flag = if force { "-D" } else { "-d" };
    let out = git(repo, &["branch", flag, branch]).await?;
    if !out.status.success() {
        return Ok(op_error(format!(
            "could not delete '{branch}': {}",
            errline(&out)
        )));
    }
    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: format!("deleted branch '{branch}'"),
        conflicts: Vec::new(),
        branch: None,
    })
}

/// `git.branchCreate`: create `name` from `from` (defaults to the current
/// HEAD) and check it out, carrying uncommitted changes across with the same
/// stash/rollback discipline as `switch_branch`.
pub async fn branch_create(
    repo: &str,
    name: &str,
    from: Option<&str>,
) -> Result<wire::GitOpResult> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(op_error("new branch name is empty"));
    }
    if name.contains(" ") {
        return Ok(op_error("branch name must not contain spaces"));
    }
    let exists = git(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )
    .await?;
    if exists.status.success() {
        return Ok(op_error(format!("a branch named '{name}' already exists")));
    }
    let original = match current_branch(repo).await {
        Some(b) => b,
        None => {
            return Ok(op_error(
                "not on a branch (detached HEAD or not a git repo)",
            ))
        }
    };
    if let Some(from) = from {
        let verify = git(repo, &["rev-parse", "--verify", "--quiet", from]).await?;
        if !verify.status.success() {
            return Ok(op_error(format!("no ref '{from}' to branch from")));
        }
    }

    let dirty = is_dirty(repo).await?;
    if dirty {
        let st = git(repo, &["stash", "push", "-u", "-m", "warpforge-branch"]).await?;
        if !st.status.success() {
            return Ok(op_error(format!("git stash failed: {}", errline(&st))));
        }
    }

    let mut args = vec!["switch", "-c", name];
    if let Some(from) = from {
        args.push(from);
    }
    let create = git(repo, &args).await?;
    if !create.status.success() {
        if dirty {
            let _ = git(repo, &["stash", "pop"]).await;
        }
        return Ok(op_error(format!(
            "git switch -c failed: {}",
            errline(&create)
        )));
    }

    if dirty {
        let pop = git(repo, &["stash", "pop"]).await?;
        if !pop.status.success() {
            let conflicts = unmerged_files(repo).await;
            let _ = git(repo, &["switch", "-f", &original]).await;
            let _ = git(repo, &["stash", "pop"]).await;
            return Ok(op_conflict(
                format!("stayed on '{original}' — your uncommitted changes conflict with '{name}'"),
                conflicts,
                Some(original),
            ));
        }
    }

    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: match from {
            Some(from) => format!("created '{name}' from '{from}'"),
            None => format!("created branch '{name}'"),
        },
        conflicts: Vec::new(),
        branch: Some(name.to_string()),
    })
}

/// `git.rebase`: rebase `branch` onto `onto` without checking it out. The
/// current working tree is stashed and restored, so selecting another branch
/// never changes the user's checkout.
pub async fn rebase(repo: &str, branch: &str, onto: &str) -> Result<wire::GitOpResult> {
    let _current = match current_branch(repo).await {
        Some(b) => b,
        None => {
            return Ok(op_error(
                "not on a branch (detached HEAD or not a git repo)",
            ))
        }
    };
    if onto == branch {
        return Ok(wire::GitOpResult {
            status: wire::GitOpStatus::UpToDate,
            message: format!("'{branch}' is already on '{onto}'"),
            conflicts: Vec::new(),
            branch: Some(branch.to_string()),
        });
    }

    let verify = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .await?;
    if !verify.status.success() {
        return Ok(op_error(format!("no local branch '{branch}'")));
    }
    let base = git(repo, &["merge-base", branch, onto]).await?;
    if !base.status.success() {
        return Ok(op_error(format!(
            "could not find common base for '{branch}' and '{onto}'"
        )));
    }
    let base = String::from_utf8_lossy(&base.stdout).trim().to_string();
    let start = rev_parse_head(repo).await?;
    let dirty = is_dirty(repo).await?;
    if dirty {
        let st = git(repo, &["stash", "push", "-u", "-m", "warpforge-rebase"]).await?;
        if !st.status.success() {
            return Ok(op_error(format!("git stash failed: {}", errline(&st))));
        }
    }

    let out = git(repo, &["rebase", "--onto", onto, &base, branch]).await?;
    if !out.status.success() {
        let conflicts = unmerged_files(repo).await;
        let _ = git(repo, &["rebase", "--abort"]).await;
        if dirty {
            let _ = git(repo, &["stash", "pop"]).await;
        }
        return Ok(op_conflict(
            format!("rebase rolled back — '{branch}' conflicts with '{onto}'"),
            conflicts,
            Some(branch.to_string()),
        ));
    }

    if dirty {
        let pop = git(repo, &["stash", "pop"]).await?;
        if !pop.status.success() {
            let conflicts = unmerged_files(repo).await;
            let _ = git(repo, &["reset", "--hard", &start]).await;
            let _ = git(repo, &["stash", "pop"]).await;
            return Ok(op_conflict(
                format!("rebase rolled back — your uncommitted changes conflict with '{onto}'"),
                conflicts,
                Some(branch.to_string()),
            ));
        }
    }

    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: format!("rebased '{branch}' onto '{onto}'"),
        conflicts: Vec::new(),
        branch: Some(branch.to_string()),
    })
}

/// `git.merge`: merge `target` into the current branch, stashing and restoring
/// uncommitted changes. Any conflict rolls back to the prior tree.
pub async fn merge(repo: &str, target: &str) -> Result<wire::GitOpResult> {
    let branch = match current_branch(repo).await {
        Some(b) => b,
        None => {
            return Ok(op_error(
                "not on a branch (detached HEAD or not a git repo)",
            ))
        }
    };
    if target == branch {
        return Ok(wire::GitOpResult {
            status: wire::GitOpStatus::UpToDate,
            message: format!("'{branch}' is already up to date with itself"),
            conflicts: Vec::new(),
            branch: Some(branch),
        });
    }
    let (start, dirty) = (rev_parse_head(repo).await?, is_dirty(repo).await?);
    if dirty {
        let st = git(repo, &["stash", "push", "-u", "-m", "warpforge-merge"]).await?;
        if !st.status.success() {
            return Ok(op_error(format!("git stash failed: {}", errline(&st))));
        }
    }

    let out = git(repo, &["merge", "--no-edit", target]).await?;
    if !out.status.success() {
        let conflicts = unmerged_files(repo).await;
        let _ = git(repo, &["merge", "--abort"]).await;
        if dirty {
            let _ = git(repo, &["stash", "pop"]).await;
        }
        return Ok(op_conflict(
            format!("merge rolled back — '{target}' conflicts with '{branch}'"),
            conflicts,
            Some(branch),
        ));
    }

    if dirty {
        let pop = git(repo, &["stash", "pop"]).await?;
        if !pop.status.success() {
            let conflicts = unmerged_files(repo).await;
            let _ = git(repo, &["reset", "--hard", &start]).await;
            let _ = git(repo, &["stash", "pop"]).await;
            return Ok(op_conflict(
                format!("merge rolled back — your uncommitted changes conflict with '{target}'"),
                conflicts,
                Some(branch),
            ));
        }
    }

    Ok(wire::GitOpResult {
        status: wire::GitOpStatus::Ok,
        message: format!("merged '{target}' into '{branch}'"),
        conflicts: Vec::new(),
        branch: Some(branch),
    })
}

/// A file's old (HEAD) and new (working-tree) text, for the editable review.
pub async fn file_doc(repo: &str, path: &str) -> Result<wire::FileDoc> {
    if path.contains("..") {
        bail!("refusing path with ..: {path}");
    }

    let is_image = is_image_path(path);

    if is_image {
        return file_doc_binary(repo, path).await;
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
        new_data_base64: None,
        old_data_base64: None,
    })
}

/// Binary file variant — returns base64-encoded content for images.
async fn file_doc_binary(repo: &str, path: &str) -> Result<wire::FileDoc> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let show = Command::new("git")
        .args(["-C", repo, "show", &format!("HEAD:{path}")])
        .output()
        .await?;
    let in_head = show.status.success();
    let old_data_base64 = if in_head {
        Some(STANDARD.encode(&show.stdout))
    } else {
        None
    };

    let full = std::path::Path::new(repo).join(path);
    let in_tree = full.is_file();
    let new_data_base64 = if in_tree {
        let bytes = std::fs::read(&full)?;
        Some(STANDARD.encode(bytes))
    } else {
        None
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
        old_text: String::new(),
        new_text: String::new(),
        new_data_base64,
        old_data_base64,
    })
}

/// Check if path is a binary image file.
fn is_image_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".ico")
        || lower.ends_with(".bmp")
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

    #[tokio::test]
    async fn push_preview_lists_outgoing_commits_and_first_push_sets_upstream() {
        let root = std::env::temp_dir().join(format!("wf-push-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let origin_url = origin.to_str().unwrap();

        git(&root, &["init", "--bare", "-q", origin_url]).await;
        git(&root, &["clone", "-q", origin_url, "work"]).await;
        let work = root.join("work");
        let repo = work.to_str().unwrap();
        git(&work, &["config", "user.email", "t@t"]).await;
        git(&work, &["config", "user.name", "Test Author"]).await;
        std::fs::write(work.join("base.txt"), "base\n").unwrap();
        git(&work, &["add", "."]).await;
        git(&work, &["commit", "-q", "-m", "initial"]).await;
        git(&work, &["push", "-q", "-u", "origin", "HEAD"]).await;

        git(&work, &["checkout", "-q", "-b", "feature/push-dialog"]).await;
        std::fs::write(work.join("first.txt"), "first\n").unwrap();
        git(&work, &["add", "."]).await;
        git(&work, &["commit", "-q", "-m", "first outgoing"]).await;
        std::fs::write(work.join("second.txt"), "second\n").unwrap();
        git(&work, &["add", "."]).await;
        git(&work, &["commit", "-q", "-m", "second outgoing"]).await;

        let preview = push_info(repo).await.unwrap();
        assert_eq!(preview.branch, "feature/push-dialog");
        assert_eq!(preview.upstream, "origin/feature/push-dialog");
        assert!(!preview.has_upstream);
        assert_eq!(preview.commits.len(), 2);
        assert_eq!(preview.commits[0].subject, "first outgoing");
        assert_eq!(preview.commits[0].author, "Test Author");
        assert_eq!(preview.commits[0].files[0].path, "first.txt");
        assert_eq!(preview.commits[1].files[0].path, "second.txt");

        let result = push(repo, false).await.unwrap();
        assert_eq!(result.status, wire::GitOpStatus::Ok, "{}", result.message);
        let after = push_info(repo).await.unwrap();
        assert!(after.has_upstream);
        assert!(after.commits.is_empty());

        std::fs::remove_dir_all(&root).ok();
    }
}
