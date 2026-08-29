use warpforge_protocol::AgentAccountLimits;

/// A 429 from a usage endpoint means *we polled too fast*, not that the user's
/// quota is spent. The two look alike and were conflated once: a throttled
/// poll rendered as "quota exhausted" on an account that had 47% left, with a
/// reset time under a minute — no 5-hour window resets that quickly. So carry
/// no windows and never set `exhausted`; the actor keeps the last good numbers
/// and this only annotates them as stale.
pub fn throttled_account(
    agent_id: &str,
    account_id: &str,
    label: &str,
    active: bool,
    fetched_at: i64,
) -> AgentAccountLimits {
    AgentAccountLimits {
        account_id: account_id.to_string(),
        agent_id: agent_id.to_string(),
        label: label.to_string(),
        active,
        plan: None,
        windows: vec![],
        exhausted: false,
        fetched_at,
        source: "api".into(),
        error: Some("usage endpoint throttled".into()),
    }
}

pub fn parse_resets(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(n) = v.as_u64() {
        return Some(n as i64);
    }
    if let Some(n) = v.as_f64() {
        return Some(n as i64);
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return Some(n);
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.timestamp());
        }
    }
    None
}
