//! Cron maths and precheck execution for scheduled automations.
//!
//! The schedule is a standard 5-field cron (`min hour dom month dow`) plus an
//! IANA timezone, both stored on the automation. Occurrence maths runs in that
//! timezone via `chrono-tz`, so "daily at 09:00" stays 09:00 across DST shifts
//! instead of drifting by an hour.

use anyhow::{anyhow, Result};
use chrono::{TimeZone, Utc};
use cron::Schedule;
use std::str::FromStr;

use warpforge_protocol::{AutomationPreset, AutomationTrigger};

/// Precheck commands get a hard ceiling so a hung script cannot stall the
/// scheduler or hold a run in `pending` forever.
pub const PRECHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The cron crate parses seconds-first 6/7-field expressions; the stored form
/// is the familiar 5-field one, so the second field is pinned to "0".
fn expanded(cron: &str) -> String {
    format!("0 {cron}")
}

/// Cron expression for a preset, in the stored 5-field form.
pub fn preset_cron(preset: AutomationPreset) -> &'static str {
    match preset {
        AutomationPreset::Hourly => "0 * * * *",
        AutomationPreset::Every5Minutes => "*/5 * * * *",
        AutomationPreset::Daily => "0 9 * * *",
        AutomationPreset::Weekdays => "0 9 * * MON-FRI",
        AutomationPreset::Weekly => "0 9 * * MON",
        AutomationPreset::Custom => "* * * * *",
    }
}

/// Parse a stored schedule. Rejects anything the scheduler itself would not be
/// able to fire — an unschedulable row must never be persisted.
pub fn validate_trigger(trigger: &AutomationTrigger, timezone: &str) -> Result<()> {
    Schedule::from_str(&expanded(&trigger.cron))
        .map_err(|e| anyhow!("invalid cron expression '{}': {e}", trigger.cron))?;
    if !timezone.is_empty() {
        timezone.parse::<chrono_tz::Tz>().map_err(|_| {
            anyhow!("unknown timezone '{timezone}' — expected an IANA name like America/New_York")
        })?;
    }
    Ok(())
}

/// The daemon host's IANA zone name, empty when it cannot be determined
/// (callers then fall back to UTC).
pub fn host_timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_default()
}

fn zone(timezone: &str) -> chrono_tz::Tz {
    timezone
        .parse::<chrono_tz::Tz>()
        .unwrap_or(chrono_tz::Tz::UTC)
}

/// Next occurrence strictly after `after`, epoch seconds. Automations store a
/// resolved IANA zone name (the host's own zone is written in at create time),
/// so an empty timezone here is only a portable fallback.
pub fn next_occurrence(trigger: &AutomationTrigger, timezone: &str, after: i64) -> Option<i64> {
    let schedule = Schedule::from_str(&expanded(&trigger.cron)).ok()?;
    let tz = zone(timezone);
    let after_local = tz.timestamp_opt(after, 0).single()?;
    schedule
        .after(&after_local)
        .next()
        .map(|next| next.with_timezone(&Utc).timestamp())
}

/// Run a precheck command in `dir`. Success means exit code 0; anything else
/// — spawn failure, non-zero exit, timeout — skips the run.
pub async fn run_precheck(command: &str, dir: &str) -> std::result::Result<(), String> {
    let dir = std::path::PathBuf::from(if dir.is_empty() { "." } else { dir });
    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("precheck failed to start: {e}"))?;
    let output = tokio::time::timeout(PRECHECK_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("precheck timed out after {}s", PRECHECK_TIMEOUT.as_secs()))?
        .map_err(|e| format!("precheck failed to run: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    let detail = if detail.len() > 400 {
        format!("{}…", &detail[..400])
    } else {
        detail
    };
    Err(format!(
        "precheck exited with {}: {detail}",
        output.status.code().unwrap_or(-1)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Datelike};

    fn trigger(cron: &str) -> AutomationTrigger {
        AutomationTrigger {
            preset: AutomationPreset::Custom,
            cron: cron.to_string(),
        }
    }

    #[test]
    fn rejects_bad_cron() {
        assert!(validate_trigger(&trigger("not a cron"), "").is_err());
        assert!(validate_trigger(&trigger("61 * * * *"), "").is_err());
    }

    #[test]
    fn rejects_bad_timezone() {
        assert!(validate_trigger(&trigger("* * * * *"), "Mars/Olympus").is_err());
        assert!(validate_trigger(&trigger("* * * * *"), "America/New_York").is_ok());
    }

    #[test]
    fn daily_at_nine_stays_nine_across_dst() {
        let t = trigger("0 9 * * *");
        // 2025-03-09 is the US DST shift: 09:00 New York is still 09:00 local.
        let after = 1741478400; // 2025-03-09T00:00:00Z (07:00 EDT)
        let next = next_occurrence(&t, "America/New_York", after).unwrap();
        let local = DateTime::<Utc>::from_timestamp(next, 0)
            .unwrap()
            .with_timezone(&chrono_tz::Tz::America__New_York);
        assert_eq!(
            local.format("%Y-%m-%d %H:%M").to_string(),
            "2025-03-09 09:00"
        );
        let next2 = next_occurrence(&t, "America/New_York", next + 1).unwrap();
        let local2 = DateTime::<Utc>::from_timestamp(next2, 0)
            .unwrap()
            .with_timezone(&chrono_tz::Tz::America__New_York);
        assert_eq!(
            local2.format("%Y-%m-%d %H:%M").to_string(),
            "2025-03-10 09:00"
        );
    }

    #[test]
    fn weekdays_skip_weekend() {
        let t = trigger("0 9 * * MON-FRI");
        // 2026-01-16 is a Friday.
        let friday = chrono::DateTime::parse_from_rfc3339("2026-01-16T15:00:00Z")
            .unwrap()
            .timestamp();
        let next = next_occurrence(&t, "UTC", friday).unwrap();
        let day = DateTime::<Utc>::from_timestamp(next, 0).unwrap().weekday();
        assert_eq!(day, chrono::Weekday::Mon);
    }
}
