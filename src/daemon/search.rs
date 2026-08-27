//! Project-wide plain-text search — the ⌘⇧F panel and the quick-open palette's
//! "Text" hits. It runs while someone is still typing, so the cost of a miss
//! matters more than the cost of a hit: the candidate list comes from git (the
//! only listing that honours .gitignore), every file is rejected by one cheap
//! pass before its lines are ever split, and the files are scanned in parallel.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::Result;
use warpforge_protocol as wire;

use super::diff::{is_ignored_path, HEAVY_DIRS};

/// Above this a file is a lockfile, a bundle or a fixture — never what someone
/// greps for by hand, and enough of the scan time to be worth skipping.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Scanning is IO- and memory-bound; more threads than this stop helping.
const MAX_THREADS: usize = 8;
/// Result lines are shown truncated anyway, and a minified file's "line" can be
/// a megabyte on its own.
const MAX_LINE_CHARS: usize = 400;

/// Case-sensitive exact-word search for Go-to-Definition. Matches `\bquery\b`
/// (word boundary = `is_word_char` flip) so `Sidebar` hits `<Sidebar` but not
/// `SIDEBAR_WIDTH_MAX`. Case-sensitive.
pub fn search_symbols(repo: &str, query: &str, limit: u32) -> Result<Vec<wire::SymbolMatch>> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    search_with(repo, query, limit, true, true)
}

/// Case-insensitive substring search across the project working tree. Stops
/// once `limit` matches accumulate. Returns path + 1-based line/column + the
/// matched line.
pub fn search_files(repo: &str, query: &str, limit: u32) -> Result<Vec<wire::SymbolMatch>> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();
    let root = Path::new(repo);
    let files = candidates(root)?;
    if files.is_empty() {
        return Ok(Vec::new());
    }

    search_with_inner(repo, &needle, limit, false, false)
}

fn search_with(
    repo: &str,
    query: &str,
    limit: u32,
    case_sensitive: bool,
    word: bool,
) -> Result<Vec<wire::SymbolMatch>> {
    search_with_inner(repo, query, limit, case_sensitive, word)
}

fn search_with_inner(
    repo: &str,
    needle: &str,
    limit: u32,
    case_sensitive: bool,
    word: bool,
) -> Result<Vec<wire::SymbolMatch>> {
    let root = Path::new(repo);
    let files = candidates(root)?;
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let found = AtomicU32::new(0);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(MAX_THREADS)
        .min(files.len());
    let chunk = files.len().div_ceil(threads);
    let mut out: Vec<wire::SymbolMatch> = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|slice| {
                let needle = needle.to_string();
                let found = &found;
                scope.spawn(move || {
                    let mut local = Vec::new();
                    for rel in slice {
                        if found.load(Ordering::Relaxed) >= limit {
                            break;
                        }
                        if word || case_sensitive {
                            scan_file_exact(
                                root,
                                rel,
                                &needle,
                                limit,
                                found,
                                &mut local,
                                case_sensitive,
                                word,
                            );
                        } else {
                            scan_file(root, rel, &needle, limit, found, &mut local);
                        }
                    }
                    local
                })
            })
            .collect();
        for handle in handles {
            if let Ok(mut local) = handle.join() {
                out.append(&mut local);
            }
        }
    });
    // Heuristic ranking: definitions first, usages second, comments last;
    // filename matching query ranks highest.
    let needle_lower = needle.to_lowercase();
    out.sort_by(|a, b| score_match(b, &needle_lower).cmp(&score_match(a, &needle_lower)));
    out.truncate(limit as usize);
    Ok(out)
}

/// Paths to scan, relative to `root`.
fn candidates(root: &Path) -> Result<Vec<String>> {
    if let Some(list) = git_candidates(root) {
        return Ok(list);
    }
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

/// Git's index is both the fastest listing available and the only one that
/// knows .gitignore — a bare filesystem walk spends most of its time inside
/// build output. Projects without git fall back to {@link walk}.
fn git_candidates(root: &Path) -> Option<Vec<String>> {
    let out = std::process::Command::new("git")
        .args([
            "-C",
            root.to_str()?,
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|path| !path.is_empty() && !is_ignored_path(path) && !is_heavy(path))
            .map(|path| path.to_string())
            .collect(),
    )
}

fn is_heavy(path: &str) -> bool {
    path.split('/').any(|part| HEAVY_DIRS.contains(&part))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if HEAVY_DIRS.contains(&name.as_str()) || is_ignored_path(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn scan_file(
    root: &Path,
    rel: &str,
    needle: &str,
    limit: u32,
    found: &AtomicU32,
    out: &mut Vec<wire::SymbolMatch>,
) {
    let path = root.join(rel);
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => {}
        // Unreadable, gone (a deleted-but-still-indexed file), or too big.
        _ => return,
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    // Binaries (~a NUL early on) hold no lines worth showing.
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return;
    }
    let text = String::from_utf8_lossy(&bytes);
    // One pass over the whole file first: most files hold no hit at all, and
    // this drops them before any line splitting happens.
    if find_ci(&text, needle).is_none() {
        return;
    }
    for (number, line) in (1u32..).zip(text.split('\n')) {
        if found.load(Ordering::Relaxed) >= limit {
            return;
        }
        let Some(at) = find_ci(line, needle) else {
            continue;
        };
        out.push(wire::SymbolMatch {
            path: rel.to_string(),
            line: number,
            column: at as u32 + 1,
            text: clip(line.trim_end_matches('\r')),
        });
        found.fetch_add(1, Ordering::Relaxed);
    }
}

/// Byte offset of the first case-insensitive hit of an already-lowercased
/// `needle`. ASCII needles take the allocation-free path; anything else falls
/// back to Unicode lowercasing, which is correct but allocates per line.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    if !needle.is_ascii() {
        return hay.to_lowercase().find(needle);
    }
    let (hay, needle) = (hay.as_bytes(), needle.as_bytes());
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    (0..=hay.len() - needle.len()).find(|&i| {
        hay[i].to_ascii_lowercase() == first
            && hay[i..i + needle.len()]
                .iter()
                .zip(needle)
                .all(|(h, n)| h.to_ascii_lowercase() == *n)
    })
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn find_exact(hay: &str, needle: &str, word: bool) -> Option<usize> {
    let mut start = 0;
    while let Some(pos) = hay[start..].find(needle) {
        let at = start + pos;
        if !word {
            return Some(at);
        }
        let before = at == 0
            || !hay[..at]
                .chars()
                .next_back()
                .map(is_word_char)
                .unwrap_or(false);
        let after_at = at + needle.len();
        let after = after_at >= hay.len()
            || !hay[after_at..]
                .chars()
                .next()
                .map(is_word_char)
                .unwrap_or(false);
        if before && after {
            return Some(at);
        }
        start = at + 1;
        if start >= hay.len() {
            break;
        }
    }
    None
}

fn scan_file_exact(
    root: &Path,
    rel: &str,
    needle: &str,
    limit: u32,
    found: &AtomicU32,
    out: &mut Vec<wire::SymbolMatch>,
    _case_sensitive: bool,
    word: bool,
) {
    let path = root.join(rel);
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => {}
        _ => return,
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return;
    }
    let text = String::from_utf8_lossy(&bytes);
    if find_exact(&text, needle, word).is_none() {
        return;
    }
    for (number, line) in (1u32..).zip(text.split('\n')) {
        if found.load(Ordering::Relaxed) >= limit {
            return;
        }
        let Some(at) = find_exact(line, needle, word) else {
            continue;
        };
        out.push(wire::SymbolMatch {
            path: rel.to_string(),
            line: number,
            column: at as u32 + 1,
            text: clip(line.trim_end_matches('\r')),
        });
        found.fetch_add(1, Ordering::Relaxed);
    }
}

fn score_match(m: &wire::SymbolMatch, needle_lower: &str) -> i32 {
    let mut score: i32 = 0;
    let path_lower = m.path.to_lowercase();
    let file_name = path_lower.rsplit('/').next().unwrap_or(&path_lower);
    // Filename contains query (e.g. Sidebar.tsx for Sidebar)
    if file_name.contains(needle_lower) {
        score += 100;
        // Exact basename without extension match is even stronger
        let stem = file_name.split('.').next().unwrap_or(file_name);
        if stem == needle_lower {
            score += 50;
        }
    } else if path_lower.contains(needle_lower) {
        score += 20;
    }
    let trimmed = m.text.trim_start();
    let is_comment = trimmed.starts_with("//")
        || trimmed.starts_with('*')
        || trimmed.starts_with("/*")
        || trimmed.starts_with('#')
        || trimmed.starts_with("<!--");
    if is_comment {
        score -= 80;
    }
    // Definition indicators
    let lower_text = m.text.to_lowercase();
    // Check for definition keywords near needle
    let needle_in_lower = needle_lower;
    // Simple heuristic: line contains export/function/class/interface/const/let/type + needle
    let has_export = lower_text.contains("export");
    let has_def_kw = lower_text.contains("function")
        || lower_text.contains("class ")
        || lower_text.contains("interface ")
        || lower_text.contains("const ")
        || lower_text.contains("let ")
        || lower_text.contains("type ")
        || lower_text.contains("struct ")
        || lower_text.contains("enum ");
    if has_export && lower_text.contains(needle_in_lower) {
        score += 60;
    } else if has_def_kw && lower_text.contains(needle_in_lower) {
        score += 40;
    }
    // JSX usage like <Sidebar
    if m.text.contains(&format!("<{}", needle_lower))
        || m.text
            .contains(&format!("<{}", capitalize_first(needle_lower)))
        || m.text.contains(&format!("<{}", needle_lower.to_string()))
    {
        // generic check: contains "<Needle" case-sensitive original is better but we have lower
        // fallback: check raw text for "<" + needle case-insensitive
        let raw_lower = m.text.to_lowercase();
        if raw_lower.contains(&format!("<{}", needle_lower)) {
            score += 10;
        }
    }
    // Prefer shorter paths / earlier definitions? slight bonus for shallower depth
    // (already covered by filename boost)
    score
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

fn clip(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        Some((at, _)) => line[..at].to_string(),
        None => line.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wf-search-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_substring_with_line_and_column() {
        let dir = temp_dir("basic");
        std::fs::write(dir.join("a.txt"), "hello world\nfn helper() {\n}\nfoo\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(
            dir.join("sub").join("b.txt"),
            "line with helper here\nanother\n",
        )
        .unwrap();
        // A heavy dir must be skipped.
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules").join("x.txt"), "helper\n").unwrap();

        let matches = search_files(dir.to_str().unwrap(), "helper", 50).unwrap();

        assert_eq!(matches.len(), 2);
        let a = matches.iter().find(|m| m.path == "a.txt").unwrap();
        assert_eq!((a.line, a.column), (2, 4));
        let b = matches.iter().find(|m| m.path == "sub/b.txt").unwrap();
        assert_eq!((b.line, b.column), (1, 11));

        // Case-insensitive.
        assert_eq!(
            search_files(dir.to_str().unwrap(), "Helper", 50)
                .unwrap()
                .len(),
            2
        );
        // Empty query yields nothing.
        assert!(search_files(dir.to_str().unwrap(), "", 50)
            .unwrap()
            .is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn honours_the_limit_and_skips_binaries() {
        let dir = temp_dir("limit");
        let many = (0..50).map(|_| "hit\n").collect::<String>();
        std::fs::write(dir.join("many.txt"), many).unwrap();
        std::fs::write(dir.join("bin.dat"), b"hit\0hit\n").unwrap();

        let matches = search_files(dir.to_str().unwrap(), "hit", 10).unwrap();

        assert_eq!(matches.len(), 10);
        assert!(matches.iter().all(|m| m.path == "many.txt"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn matches_non_ascii_case_insensitively_and_clips_long_lines() {
        let dir = temp_dir("unicode");
        std::fs::write(dir.join("u.txt"), "Привіт світ\n").unwrap();
        std::fs::write(
            dir.join("long.txt"),
            format!("needle{}\n", "x".repeat(1000)),
        )
        .unwrap();

        assert_eq!(
            search_files(dir.to_str().unwrap(), "ПРИВІТ", 10)
                .unwrap()
                .len(),
            1
        );
        let long = search_files(dir.to_str().unwrap(), "needle", 10).unwrap();
        assert_eq!(long[0].text.chars().count(), MAX_LINE_CHARS);

        std::fs::remove_dir_all(&dir).ok();
    }
}
