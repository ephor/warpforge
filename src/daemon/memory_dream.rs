use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RawProposal {
    proposal_type: String,
    target_ids: String,
    reason: Option<String>,
}

const ALLOWED: &[&str] = &[
    "duplicate",
    "contradiction",
    "stale",
    "merge",
    "superseded_by",
    "delete",
];

pub fn parse_proposals(text: &str) -> Vec<(String, String, String)> {
    let slice = extract_array(text).unwrap_or(text);
    let raws: Vec<RawProposal> = serde_json::from_str(slice).unwrap_or_default();
    raws.into_iter()
        .filter_map(|r| {
            let t = r.proposal_type.to_lowercase();
            if !ALLOWED.contains(&t.as_str()) {
                return None;
            }
            if r.target_ids.trim().is_empty() {
                return None;
            }
            Some((t, r.target_ids, r.reason.unwrap_or_default()))
        })
        .collect()
}

fn extract_array(s: &str) -> Option<&str> {
    let a = s.find('[')?;
    // balanced scan from first '[' to matching ']'
    let mut depth = 0usize;
    for (i, c) in s[a..].char_indices() {
        if c == '[' {
            depth += 1;
        } else if c == ']' {
            depth -= 1;
            if depth == 0 {
                return Some(&s[a..a + i + 1]);
            }
        }
    }
    None
}

pub fn dream_prompt(rows: &[(String, String, i64)]) -> String {
    let mut p = String::from("find duplicates, contradictions, stale facts; propose superseded_by/merge/delete. Return JSON array of {proposal_type in [duplicate,contradiction,stale,merge,superseded_by,delete], target_ids: comma-separated ids, reason}. Decay heuristic: older last_accessed = staler. Memories:\n");
    for (id, content, la) in rows {
        p.push_str(&format!("- {id} (last_accessed={la}): {content}\n"));
    }
    p
}

pub fn parse_idle_after(s: &str) -> std::time::Duration {
    // minimal parser: "30m", "1h", "30s" — fallback 30m
    if let Some(n) = s.strip_suffix('m') {
        if let Ok(v) = n.parse::<u64>() {
            return std::time::Duration::from_secs(v * 60);
        }
    }
    if let Some(n) = s.strip_suffix('h') {
        if let Ok(v) = n.parse::<u64>() {
            return std::time::Duration::from_secs(v * 3600);
        }
    }
    if let Some(n) = s.strip_suffix('s') {
        if let Ok(v) = n.parse::<u64>() {
            return std::time::Duration::from_secs(v);
        }
    }
    std::time::Duration::from_secs(1800)
}
