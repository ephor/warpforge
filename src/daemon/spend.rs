use warpforge_protocol as wire;

/// Sum the peak of each run, where a run ends wherever the value drops.
///
/// `cost.amount` is the running total for one agent *session*, and it restarts
/// at zero whenever the session does (daemon restart, resume). Summing the raw
/// values would multiply-count; taking only the last value would drop every
/// earlier run. The peaks are the per-run totals.
///
/// Only ever call this with ONE task's rows in insertion order. Two tasks
/// interleaved in database order look like constant restarts to this function
/// and inflate the total wildly.
pub fn sum_runs(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sum = 0.0;
    let mut run_max = values[0];
    for &v in &values[1..] {
        if v < run_max {
            sum += run_max;
            run_max = v;
        } else if v > run_max {
            run_max = v;
        }
    }
    sum += run_max;
    Some(sum)
}

/// One reported cost sample: the session's running total, and when we stored it
/// (`None` for rows written before the column existed).
type CostSample = (f64, Option<i64>);

pub fn compute_agent_spend(
    rows: Vec<(String, String, Option<i64>)>,
    tasks: &[wire::TaskInfo],
) -> Vec<wire::AgentSpend> {
    use std::collections::HashMap;
    let now = crate::daemon::task::now_secs() as i64;
    let cutoff = now - 24 * 3600;

    let agent_of: HashMap<&str, &str> = tasks
        .iter()
        .map(|t| (t.id.as_str(), t.agent.as_str()))
        .collect();

    // Grouped PER TASK, not per agent: every task carries its own restarting
    // cost series, so interleaving two tasks in database order would read as a
    // restart on every alternation and multiply the total.
    let mut per_task: HashMap<(String, String), Vec<CostSample>> = HashMap::new();
    for (task_id, json, created_at) in rows {
        let Ok(u) = serde_json::from_str::<wire::SessionUpdate>(&json) else {
            continue;
        };
        let wire::SessionUpdate::Usage { cost: Some(c), .. } = u else {
            continue;
        };
        // Mixing currencies into one number would be a lie. Converting needs a
        // rate we do not have, so a non-USD row is dropped, not coerced.
        if c.currency != "USD" {
            continue;
        }
        let Some(agent) = agent_of.get(task_id.as_str()) else {
            continue;
        };
        per_task
            .entry((agent.to_string(), task_id))
            .or_default()
            .push((c.amount, created_at));
    }

    // Every agent that has tasks appears, so a harness reporting no cost at all
    // can say "not reported" rather than "$0.00".
    let mut totals: HashMap<String, (f64, f64, bool, u32)> = HashMap::new();
    for t in tasks {
        totals
            .entry(t.agent.clone())
            .or_insert((0.0, 0.0, false, 0));
    }

    for ((agent, _task), vals) in &per_task {
        let all: Vec<f64> = vals.iter().map(|(a, _)| *a).collect();
        let Some(task_total) = sum_runs(&all) else {
            continue;
        };
        // Spend inside the window is what accrued on top of where the task
        // already stood at the cutoff — not the sum of the in-window values,
        // which would re-count everything the run had accumulated before it.
        let before: Vec<f64> = vals
            .iter()
            .filter(|(_, ts)| ts.is_none_or(|t| t < cutoff))
            .map(|(a, _)| *a)
            .collect();
        let saw_recent = vals.iter().any(|(_, ts)| ts.is_some_and(|t| t >= cutoff));
        let recent = if saw_recent {
            (task_total - sum_runs(&before).unwrap_or(0.0)).max(0.0)
        } else {
            0.0
        };

        let e = totals.entry(agent.clone()).or_insert((0.0, 0.0, false, 0));
        e.0 += task_total;
        e.1 += recent;
        e.2 = true;
        e.3 += 1;
    }

    let any_recent: HashMap<&String, bool> = per_task
        .iter()
        .map(|((agent, _), vals)| {
            (
                agent,
                vals.iter().any(|(_, ts)| ts.is_some_and(|t| t >= cutoff)),
            )
        })
        .fold(HashMap::new(), |mut acc, (agent, recent)| {
            *acc.entry(agent).or_insert(false) |= recent;
            acc
        });

    let mut out: Vec<wire::AgentSpend> = totals
        .into_iter()
        .map(|(agent_id, (total, recent, reported, tasks))| {
            // Rows written before the schema carried a timestamp have none, so
            // "today" stays unknown until timestamped rows exist — reporting 0
            // would read as "spent nothing today".
            let today_usd = match any_recent.get(&agent_id) {
                Some(true) => Some(recent),
                _ => None,
            };
            wire::AgentSpend {
                agent_id,
                today_usd,
                total_usd: reported.then_some(total),
                tasks,
                reported,
            }
        })
        .collect();
    out.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn run_split_series() {
        let vals = vec![
            1.285794, 1.898526, 2.530877, 2.811081, 2.145824, 4.378447, 4.732938, 5.487799,
            5.955733, 6.041498, 4.189422, 0.490667,
        ];
        // runs: [1.28..2.81]=2.811081, [2.14..6.04]=6.041498, [4.18]=4.189422, [0.49]=0.490667
        let expected = 2.811081 + 6.041498 + 4.189422 + 0.490667;
        let got = sum_runs(&vals).unwrap();
        assert!((got - expected).abs() < 1e-6, "{got} vs {expected}");
        assert!((got - 40.0).abs() > 1.0);
    }
    #[test]
    fn single_run() {
        assert_eq!(sum_runs(&[1.0, 2.0, 3.0]), Some(3.0));
    }
    #[test]
    fn empty_none() {
        assert_eq!(sum_runs(&[]), None);
    }
    fn base_task() -> wire::TaskInfo {
        wire::TaskInfo {
            id: "t1".into(),
            project: "p".into(),
            prompt: String::new(),
            agent: "claude".into(),
            status: wire::TaskStatus::Waiting,
            tags: vec![],
            title: String::new(),
            created_at: 0,
            updated_at: 0,
            files_changed: 0,
            blocked_reason: None,
            blocked_kind: None,
            config_options: vec![],
            worktree: None,
            orchestration_graph: None,
            parent_task_id: None,
            workflow_run: None,
            settled_override: None,
            settled_at: None,
            snoozed_until: None,
            snoozed_at: None,
            backlog_item_id: None,
            model: None,
            pending_permission: false,
        }
    }

    fn usage_row(
        task: &str,
        amount: f64,
        currency: &str,
        ts: Option<i64>,
    ) -> (String, String, Option<i64>) {
        let json = serde_json::to_string(&wire::SessionUpdate::Usage {
            used: 0,
            size: 0,
            cost: Some(wire::SessionUsageCost {
                amount,
                currency: currency.into(),
            }),
        })
        .unwrap();
        (task.to_string(), json, ts)
    }

    fn task_of(id: &str, agent: &str) -> wire::TaskInfo {
        let mut t = base_task();
        t.id = id.into();
        t.agent = agent.into();
        t
    }

    /// Two tasks of one agent interleave in database id order. Treating that
    /// single stream as one series reads every alternation as a session restart:
    /// [5.0, 0.1, 6.0, 0.2] would total 11.2 instead of 6.2.
    #[test]
    fn interleaved_tasks_are_summed_per_task() {
        let tasks = vec![task_of("a", "claude"), task_of("b", "claude")];
        let rows = vec![
            usage_row("a", 5.0, "USD", None),
            usage_row("b", 0.1, "USD", None),
            usage_row("a", 6.0, "USD", None),
            usage_row("b", 0.2, "USD", None),
        ];
        let out = compute_agent_spend(rows, &tasks);
        assert_eq!(out.len(), 1);
        let total = out[0].total_usd.unwrap();
        assert!((total - 6.2).abs() < 1e-9, "got {total}, expected 6.2");
        assert_eq!(out[0].tasks, 2);
    }

    /// A run that began before the window must contribute only its growth,
    /// not everything it had already accumulated.
    #[test]
    fn today_counts_only_what_accrued_in_the_window() {
        let now = crate::daemon::task::now_secs() as i64;
        let tasks = vec![task_of("a", "claude")];
        let rows = vec![
            usage_row("a", 5.0, "USD", Some(now - 40 * 3600)),
            usage_row("a", 8.0, "USD", Some(now - 60)),
        ];
        let out = compute_agent_spend(rows, &tasks);
        assert_eq!(out[0].total_usd, Some(8.0));
        assert_eq!(out[0].today_usd, Some(3.0));
    }

    /// Untimestamped history predates the column; "today" is unknown, not zero.
    #[test]
    fn today_unknown_without_timestamps() {
        let tasks = vec![task_of("a", "claude")];
        let rows = vec![usage_row("a", 5.0, "USD", None)];
        let out = compute_agent_spend(rows, &tasks);
        assert_eq!(out[0].total_usd, Some(5.0));
        assert_eq!(out[0].today_usd, None);
    }

    #[test]
    fn non_usd_skipped() {
        let tasks = vec![task_of("t1", "claude")];
        let eur = serde_json::to_string(&wire::SessionUpdate::Usage {
            used: 0,
            size: 0,
            cost: Some(wire::SessionUsageCost {
                amount: 100.0,
                currency: "EUR".into(),
            }),
        })
        .unwrap();
        let rows = vec![("t1".into(), eur, Some(9999999999))];
        let out = compute_agent_spend(rows, &tasks);
        assert_eq!(out[0].total_usd, None);
        assert!(!out[0].reported);
    }
    #[test]
    fn reported_false_no_rows() {
        let tasks = vec![task_of("t1", "codex")];
        let out = compute_agent_spend(vec![], &tasks);
        assert!(!out[0].reported);
        assert_eq!(out[0].today_usd, None);
        assert_eq!(out[0].total_usd, None);
    }
}
