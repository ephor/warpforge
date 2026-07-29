//! Deterministic workflow pipeline engine: run-state container and pure
//! helpers (stage prompts, verdict/marker parsing, review merging, context
//! formatting).
//!
//! The pipeline shape is fixed: `plan? → implement → review ⇄ fix`. This
//! module has no side effects — the actor glue that spawns stage sessions,
//! reacts to turn ends, and emits events lives in `actor.rs` and calls into
//! these helpers, so everything here is unit-testable in isolation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use warpforge_protocol as wire;

use crate::workflow_config::{render_template, ReviewContextItem, WorkflowSpec};

/// Byte budget for the diff embedded into review/fix prompts.
pub const DIFF_CONTEXT_MAX_BYTES: usize = 200 * 1024;
/// Byte budget for the implementer-summary context section (tail wins).
pub const SUMMARY_CONTEXT_MAX_BYTES: usize = 16 * 1024;
/// Budget for a salvaged review body used as a stand-in finding.
const SALVAGED_FINDING_MAX_BYTES: usize = 4 * 1024;
/// How many times a reviewer is re-asked for a parseable verdict before the
/// pipeline fails.
pub const MAX_VERDICT_REASKS: u8 = 1;
/// Cap on rounds granted by a single `workflow.decide { extend }`.
pub const MAX_EXTEND_ROUNDS: u32 = 5;

// ─── Stages and state ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageKind {
    Plan,
    Implement,
    Review,
    Fix,
}

impl StageKind {
    pub fn label(self) -> &'static str {
        match self {
            StageKind::Plan => "plan",
            StageKind::Implement => "implement",
            StageKind::Review => "review",
            StageKind::Fix => "fix",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            StageKind::Plan => "Plan",
            StageKind::Implement => "Implement",
            StageKind::Review => "Review",
            StageKind::Fix => "Fix",
        }
    }

    pub fn wire(self) -> wire::WorkflowStage {
        match self {
            StageKind::Plan => wire::WorkflowStage::Plan,
            StageKind::Implement => wire::WorkflowStage::Implement,
            StageKind::Review => wire::WorkflowStage::Review,
            StageKind::Fix => wire::WorkflowStage::Fix,
        }
    }

    pub fn node_kind(self) -> wire::OrchNodeKind {
        match self {
            StageKind::Plan => wire::OrchNodeKind::Plan,
            StageKind::Implement => wire::OrchNodeKind::Implement,
            StageKind::Review => wire::OrchNodeKind::Review,
            StageKind::Fix => wire::OrchNodeKind::Fix,
        }
    }

    /// The stage that follows a successfully completed one. Review is not a
    /// simple successor — it branches on the merged verdict — so it has no
    /// entry here.
    pub fn successor(self) -> Option<StageKind> {
        match self {
            StageKind::Plan => Some(StageKind::Implement),
            StageKind::Implement => Some(StageKind::Review),
            StageKind::Fix => Some(StageKind::Review),
            StageKind::Review => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum RunState {
    /// A stage's child session(s) are running.
    Running {
        stage: StageKind,
    },
    /// A stage asked `need_user_input`; suspended until `workflow.reply`.
    AwaitingReply {
        stage: StageKind,
        child: String,
        question: String,
    },
    /// Review rounds exhausted with open findings; suspended until
    /// `workflow.decide`.
    AwaitingLimitDecision,
    /// Soft-paused at a stage barrier; `next` starts on `workflow.resume`.
    Paused {
        next: StageKind,
    },
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

impl Severity {
    pub fn label(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::High => "high",
            Severity::Medium => "medium",
            Severity::Low => "low",
        }
    }

    /// Low-severity findings go to the final summary, not to the fixer.
    pub fn goes_to_fix(self) -> bool {
        !matches!(self, Severity::Low)
    }

    /// Map an agent's severity word onto the four levels. Agents use a much
    /// wider vocabulary than the protocol asks for, and the default matters:
    /// an unknown word becomes `Medium`, which forces a repair round, so
    /// opinion-shaped words must land in `Low` rather than fall through.
    fn parse(s: &str) -> Severity {
        match s.trim().to_ascii_lowercase().as_str() {
            "critical" | "blocker" | "blocking" | "severe" | "fatal" => Severity::Critical,
            "high" | "major" | "important" => Severity::High,
            "low" | "minor" | "nit" | "nitpick" | "info" | "informational" | "suggestion"
            | "style" | "cosmetic" | "trivial" | "optional" | "polish" | "note" => Severity::Low,
            _ => Severity::Medium,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub file: Option<String>,
    /// Line in the post-change file, when the reviewer pinned one down.
    #[serde(default)]
    pub line: Option<u32>,
    /// A short verbatim excerpt of the offending code. More robust than a line
    /// number — the fixer can search for it after the file has shifted.
    #[serde(default)]
    pub snippet: Option<String>,
    pub description: String,
    /// Reviewer label, e.g. "reviewer 2 (codex)".
    pub reviewer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Approve,
    RequestChanges,
}

impl Verdict {
    pub fn wire(self) -> wire::WorkflowVerdict {
        match self {
            Verdict::Approve => wire::WorkflowVerdict::Approve,
            Verdict::RequestChanges => wire::WorkflowVerdict::RequestChanges,
        }
    }
}

/// How a pipeline ends.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkflowOutcome {
    /// Reviewers approved, or the user chose to finish with open findings.
    Success { limit_hit: bool },
    /// Stopped by the user (task cancel, or `workflow.decide { stop }`).
    Stopped,
    /// Infrastructure or protocol failure.
    Error(String),
}

/// One spawned stage child, kept for the orchestration graph on the board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StageRecord {
    pub kind: StageKind,
    pub task_id: String,
    pub agent: String,
    /// Display label, e.g. "review 1/2 (codex)".
    pub label: String,
    pub status: wire::OrchNodeStatus,
}

// ─── The run ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub parent_id: String,
    pub project: String,
    pub spec: WorkflowSpec,
    /// Lead agent / model picked in the New Task dialog — the fallback for
    /// every stage that doesn't override them.
    pub lead_agent: String,
    pub lead_model: Option<String>,
    pub state: RunState,
    /// 1-based review round; 0 until the first review starts.
    pub round: u32,
    /// Extra rounds granted by `workflow.decide { extend }`.
    pub extra_rounds: u32,
    /// Set by `workflow.pause` while a stage is running; takes effect at the
    /// next stage barrier.
    pub pause_requested: bool,
    /// Free-text from resume/decide, delivered to the next spawned stage as a
    /// "User guidance" block and then cleared.
    pub pending_guidance: Option<String>,
    pub plan_output: Option<String>,
    /// Final text of the last implement/fix session.
    pub last_summary: Option<String>,
    pub last_verdict: Option<Verdict>,
    /// Findings of the latest review round that still need fixing.
    #[serde(default)]
    pub open_findings: Vec<Finding>,
    /// Low-severity findings accumulated for the final summary only.
    #[serde(default)]
    pub deferred_findings: Vec<Finding>,
    /// child task id → reviewer index, while a review stage is in flight.
    #[serde(default)]
    pub review_pending: HashMap<String, usize>,
    /// (reviewer index, verdict, findings) collected this round.
    #[serde(default)]
    pub review_collected: Vec<(usize, Verdict, Vec<Finding>)>,
    /// child task id → verdict re-ask count.
    #[serde(default)]
    pub reasked: HashMap<String, u8>,
    /// child task id → stage kind, for routing TurnEnded (single-child stages).
    #[serde(default)]
    pub active_children: HashMap<String, StageKind>,
    /// reviewer index → child task id of the previous review round. With
    /// `review.reask: same_session` the next round follows up in these
    /// sessions instead of spawning fresh ones.
    #[serde(default)]
    pub prior_review_children: HashMap<usize, String>,
    #[serde(default)]
    pub history: Vec<StageRecord>,
    /// Attachments from the New Task dialog, delivered to the first stage.
    #[serde(default)]
    pub attachments: Vec<wire::PromptAttachment>,
    /// Whether stage sessions get the project's runtime-context preamble, as
    /// picked in the New Task dialog.
    #[serde(default)]
    pub include_runtime_context: bool,
    /// Non-model session config picks from the dialog (reasoning effort, mode),
    /// applied to every stage session.
    #[serde(default)]
    pub config_overrides: HashMap<String, String>,
}

impl WorkflowRun {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        parent_id: String,
        project: String,
        spec: WorkflowSpec,
        lead_agent: String,
        lead_model: Option<String>,
        attachments: Vec<wire::PromptAttachment>,
        include_runtime_context: bool,
        config_overrides: HashMap<String, String>,
    ) -> Self {
        Self {
            parent_id,
            project,
            spec,
            lead_agent,
            lead_model,
            state: RunState::Running {
                stage: StageKind::Implement, // set properly by the first spawn
            },
            round: 0,
            extra_rounds: 0,
            pause_requested: false,
            pending_guidance: None,
            plan_output: None,
            last_summary: None,
            last_verdict: None,
            open_findings: Vec::new(),
            deferred_findings: Vec::new(),
            review_pending: HashMap::new(),
            review_collected: Vec::new(),
            prior_review_children: HashMap::new(),
            reasked: HashMap::new(),
            active_children: HashMap::new(),
            history: Vec::new(),
            attachments: Vec::new(),
            include_runtime_context,
            config_overrides,
        }
        .with_attachments(attachments)
    }

    fn with_attachments(mut self, attachments: Vec<wire::PromptAttachment>) -> Self {
        self.attachments = attachments;
        self
    }

    pub fn first_stage(&self) -> StageKind {
        if self.spec.plan.is_some() {
            StageKind::Plan
        } else {
            StageKind::Implement
        }
    }

    pub fn effective_max_rounds(&self) -> u32 {
        self.spec.review.max_rounds + self.extra_rounds
    }

    pub fn is_active(&self) -> bool {
        !matches!(self.state, RunState::Done | RunState::Failed)
    }

    /// Agent + model for a stage, applying the fallback chain:
    /// stage override → (fix falls back to implement) → lead agent/model.
    pub fn stage_agent(
        &self,
        kind: StageKind,
        reviewer: Option<usize>,
    ) -> (String, Option<String>) {
        let (agent, model) = match kind {
            StageKind::Plan => {
                let s = self.spec.plan.as_ref();
                (
                    s.and_then(|s| s.agent.clone()),
                    s.and_then(|s| s.model.clone()),
                )
            }
            StageKind::Implement => (
                self.spec.implement.agent.clone(),
                self.spec.implement.model.clone(),
            ),
            StageKind::Fix => (
                self.spec
                    .fix
                    .agent
                    .clone()
                    .or_else(|| self.spec.implement.agent.clone()),
                self.spec
                    .fix
                    .model
                    .clone()
                    .or_else(|| self.spec.implement.model.clone()),
            ),
            StageKind::Review => {
                let r = reviewer.and_then(|i| self.spec.review.reviewers.get(i));
                (
                    r.and_then(|r| r.agent.clone()),
                    r.and_then(|r| r.model.clone()),
                )
            }
        };
        (
            agent.unwrap_or_else(|| self.lead_agent.clone()),
            model.or_else(|| self.lead_model.clone()),
        )
    }

    pub fn reviewer_label(&self, index: usize) -> String {
        let total = self.spec.review.reviewers.len();
        let (agent, _) = self.stage_agent(StageKind::Review, Some(index));
        if total == 1 {
            format!("reviewer ({agent})")
        } else {
            format!("reviewer {}/{total} ({agent})", index + 1)
        }
    }

    pub fn record_stage(&mut self, kind: StageKind, task_id: &str, agent: &str, label: String) {
        self.history.push(StageRecord {
            kind,
            task_id: task_id.to_string(),
            agent: agent.to_string(),
            label,
            status: wire::OrchNodeStatus::Running,
        });
    }

    pub fn set_record_status(&mut self, task_id: &str, status: wire::OrchNodeStatus) {
        if let Some(rec) = self.history.iter_mut().rev().find(|r| r.task_id == task_id) {
            rec.status = status;
        }
    }

    /// Take the pending guidance (it is delivered to exactly one stage).
    pub fn take_guidance(&mut self) -> Option<String> {
        self.pending_guidance.take()
    }

    /// Every stage child this run ever spawned. Completed stages keep their
    /// sessions alive during the run (same-session re-review needs them), so
    /// final cleanup must sweep this full set, not just `active_children`.
    pub fn all_children(&self) -> std::collections::HashSet<String> {
        self.history
            .iter()
            .map(|record| record.task_id.clone())
            .chain(self.active_children.keys().cloned())
            .collect()
    }

    // ── Wire projections ──

    pub fn wire_info(&self) -> wire::WorkflowRunInfo {
        let (stage, waiting) = match &self.state {
            RunState::Running { stage } => (stage.wire(), None),
            RunState::AwaitingReply {
                stage, question, ..
            } => (
                stage.wire(),
                Some(wire::WorkflowWaiting {
                    kind: wire::WorkflowWaitKind::Question,
                    stage: Some(stage.wire()),
                    question: Some(question.clone()),
                }),
            ),
            RunState::AwaitingLimitDecision => (
                wire::WorkflowStage::Review,
                Some(wire::WorkflowWaiting {
                    kind: wire::WorkflowWaitKind::Limit,
                    stage: Some(wire::WorkflowStage::Review),
                    question: Some(summarize_findings(&self.open_findings)),
                }),
            ),
            RunState::Paused { next } => (
                next.wire(),
                Some(wire::WorkflowWaiting {
                    kind: wire::WorkflowWaitKind::Paused,
                    stage: Some(next.wire()),
                    question: None,
                }),
            ),
            RunState::Done => (wire::WorkflowStage::Done, None),
            RunState::Failed => (wire::WorkflowStage::Failed, None),
        };
        wire::WorkflowRunInfo {
            workflow_id: self.spec.id.clone(),
            workflow_name: self.spec.name.clone(),
            stage,
            round: self.round,
            max_rounds: self.effective_max_rounds(),
            verdict: self.last_verdict.map(Verdict::wire),
            waiting,
            pause_requested: self.pause_requested,
        }
    }

    pub fn graph_info(&self) -> wire::OrchGraphInfo {
        wire::OrchGraphInfo {
            id: self.parent_id.clone(),
            goal: self.spec.name.clone(),
            nodes: self
                .history
                .iter()
                .map(|rec| wire::OrchNodeInfo {
                    id: rec.label.clone(),
                    kind: rec.kind.node_kind(),
                    agent: rec.agent.clone(),
                    status: rec.status,
                    task_id: Some(rec.task_id.clone()),
                    result: None,
                })
                .collect(),
        }
    }
}

// ─── Output parsing ──────────────────────────────────────────────────────────

/// The machine-readable signal at the end of a plan/implement/fix stage.
#[derive(Debug, Clone, PartialEq)]
pub enum StageSignal {
    /// The stage needs an answer from the user before it can continue.
    Question(String),
    /// Normal completion; the stage's text output is its result.
    Output,
}

/// Scan a stage's output for the trailing `need_user_input` marker.
pub fn parse_stage_signal(text: &str) -> StageSignal {
    if let Some(value) = extract_last_json_with_key(text, "need_user_input") {
        if let Some(q) = value.get("need_user_input").and_then(|v| v.as_str()) {
            let q = q.trim();
            // Ignore an agent that echoes the protocol example back at us
            // instead of asking something.
            if !q.is_empty() && q != "<your question>" {
                return StageSignal::Question(q.to_string());
            }
        }
    }
    StageSignal::Output
}

/// Parse a reviewer's verdict from its output. `Err` is a human-readable
/// reason suitable for the re-ask prompt / failure message.
pub fn parse_review_verdict(text: &str, reviewer: &str) -> Result<(Verdict, Vec<Finding>), String> {
    let Some(value) = extract_last_json_with_key(text, "verdict") else {
        return Err("no fenced JSON block with a `verdict` field found".to_string());
    };
    let verdict = match value.get("verdict").and_then(|v| v.as_str()) {
        Some("approve") => Verdict::Approve,
        Some("request_changes") => Verdict::RequestChanges,
        Some(other) => {
            return Err(format!(
                "verdict must be \"approve\" or \"request_changes\", got \"{other}\""
            ))
        }
        None => return Err("the `verdict` field is not a string".to_string()),
    };
    let mut findings = Vec::new();
    if let Some(items) = value.get("findings").and_then(|v| v.as_array()) {
        for item in items {
            let description = item
                .get("description")
                .or_else(|| item.get("title"))
                .or_else(|| item.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if description.is_empty() {
                continue;
            }
            findings.push(Finding {
                severity: item
                    .get("severity")
                    .and_then(|v| v.as_str())
                    .map(Severity::parse)
                    .unwrap_or(Severity::Medium),
                file: item
                    .get("file")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .filter(|f| !f.is_empty()),
                // Agents emit the line as a number or a string, and sometimes
                // as a range ("42-45") — the first number is the anchor.
                line: item
                    .get("line")
                    .and_then(|v| {
                        v.as_u64().or_else(|| {
                            v.as_str().and_then(|s| {
                                s.trim()
                                    .split(|c: char| !c.is_ascii_digit())
                                    .find(|part| !part.is_empty())
                                    .and_then(|part| part.parse().ok())
                            })
                        })
                    })
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|n| *n > 0),
                snippet: item
                    .get("snippet")
                    .or_else(|| item.get("code"))
                    .and_then(|v| v.as_str())
                    .map(|s| clip_snippet(s.trim()))
                    .filter(|s| !s.is_empty()),
                description,
                reviewer: reviewer.to_string(),
            });
        }
    }
    // A reviewer that asks for changes but leaves `findings` empty (prose-only
    // review, a differently-named key, entries without a description) must not
    // read as "nothing to fix" — that path finishes the pipeline as a success
    // and silently rubber-stamps the change. Salvage its own words instead so
    // the repair stage still has something concrete to act on.
    if verdict == Verdict::RequestChanges && findings.is_empty() {
        let prose = strip_protocol_blocks(text).trim().to_string();
        let prose = if prose.len() > SALVAGED_FINDING_MAX_BYTES {
            let end = floor_char_boundary(&prose, SALVAGED_FINDING_MAX_BYTES);
            format!("{}\n[…truncated…]", &prose[..end])
        } else {
            prose
        };
        findings.push(Finding {
            severity: Severity::Medium,
            file: None,
            line: None,
            snippet: None,
            description: if prose.is_empty() {
                "Changes were requested without any detail. Re-check the diff against the task \
                 and fix what looks wrong."
                    .to_string()
            } else {
                format!(
                    "Changes requested without a structured findings list — the reviewer's own \
                     words follow:\n\n{prose}"
                )
            },
            reviewer: reviewer.to_string(),
        });
    }

    Ok((verdict, findings))
}

/// The last fenced code block in `text` that parses as a JSON object
/// containing `key`. Requiring the key matters: agents routinely end a reply
/// with an unrelated fenced block (a config snippet, a quoted diff), and
/// taking the last JSON object unconditionally would misread that as the
/// protocol payload. Accepts both ```json and bare ``` fences — agents are
/// inconsistent.
fn extract_last_json_with_key(text: &str, key: &str) -> Option<serde_json::Value> {
    let mut best: Option<serde_json::Value> = None;
    let mut rest = text;
    while let Some(open) = rest.find("```") {
        let after_open = &rest[open + 3..];
        // Skip the info string ("json", "JSON", …) up to the first newline.
        let Some(nl) = after_open.find('\n') else {
            break;
        };
        let body_start = nl + 1;
        let Some(close) = after_open[body_start..].find("```") else {
            break;
        };
        let body = &after_open[body_start..body_start + close];
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body.trim()) {
            if value.get(key).is_some() {
                best = Some(value);
            }
        }
        rest = &after_open[body_start + close + 3..];
    }
    best
}

/// Merge one round's reviewer results: approve only when everyone approves;
/// findings are concatenated in reviewer order.
pub fn merge_reviews(collected: &[(usize, Verdict, Vec<Finding>)]) -> (Verdict, Vec<Finding>) {
    let mut sorted: Vec<_> = collected.iter().collect();
    sorted.sort_by_key(|(idx, _, _)| *idx);
    let verdict = if sorted
        .iter()
        .all(|(_, verdict, _)| *verdict == Verdict::Approve)
    {
        Verdict::Approve
    } else {
        Verdict::RequestChanges
    };
    let findings = sorted
        .iter()
        .flat_map(|(_, _, findings)| findings.iter().cloned())
        .collect();
    (verdict, findings)
}

// ─── Context formatting ──────────────────────────────────────────────────────

/// Render a working-copy diff into prompt text, truncated to
/// [`DIFF_CONTEXT_MAX_BYTES`] with an explicit truncation note.
pub fn format_diff(files: &[wire::FileDiff]) -> String {
    if files.is_empty() {
        return "(no changes in the working copy)".to_string();
    }
    let mut out = String::new();
    let mut truncated = false;
    'files: for file in files {
        let header = match (&file.status, &file.old_path) {
            (wire::FileDiffStatus::Renamed, Some(old)) => {
                format!("--- {old}\n+++ {} (renamed)\n", file.path)
            }
            (wire::FileDiffStatus::Added, _) => format!("+++ {} (added)\n", file.path),
            (wire::FileDiffStatus::Deleted, _) => format!("--- {} (deleted)\n", file.path),
            _ => format!("--- a/{p}\n+++ b/{p}\n", p = file.path),
        };
        out.push_str(&header);
        for hunk in &file.hunks {
            out.push_str(&format!(
                "@@ -{},{} +{},{} @@\n",
                hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
            ));
            for line in &hunk.lines {
                out.push_str(line);
                out.push('\n');
            }
            if out.len() > DIFF_CONTEXT_MAX_BYTES {
                truncated = true;
                break 'files;
            }
        }
        out.push('\n');
    }
    if truncated {
        out.truncate(floor_char_boundary(&out, DIFF_CONTEXT_MAX_BYTES));
        out.push_str("\n\n[diff truncated — full list of changed files:]\n");
        for file in files {
            out.push_str(&format!("- {}\n", file.path));
        }
    }
    out
}

/// Strip the trailing machine protocol block (the `verdict` / `need_user_input`
/// JSON fence) so the parent's timeline shows the agent's prose instead of the
/// wire format it was asked to emit. Falls back to the full text when nothing
/// matches, and always clips to the summary budget.
pub fn display_output(text: &str) -> String {
    let trimmed = strip_protocol_blocks(text).trim().to_string();
    let trimmed = trimmed.as_str();
    if trimmed.is_empty() {
        // The whole reply was the protocol block — show it rather than an
        // empty card.
        return clip_summary(text.trim());
    }
    clip_summary(trimmed)
}

/// Drop the trailing machine protocol fences from an agent reply.
fn strip_protocol_blocks(text: &str) -> &str {
    let mut visible = text;
    for key in ["verdict", "need_user_input"] {
        if let Some(start) = protocol_block_start(visible, key) {
            visible = &visible[..start];
        }
    }
    visible
}

/// Byte offset of the fence that opens the last JSON block containing `key`.
fn protocol_block_start(text: &str, key: &str) -> Option<usize> {
    let mut found = None;
    let mut cursor = 0;
    while let Some(open) = text[cursor..].find("```").map(|p| cursor + p) {
        let after_open = open + 3;
        let Some(nl) = text[after_open..].find('\n').map(|p| after_open + p + 1) else {
            break;
        };
        let Some(close) = text[nl..].find("```").map(|p| nl + p) else {
            break;
        };
        if serde_json::from_str::<serde_json::Value>(text[nl..close].trim())
            .ok()
            .and_then(|value| value.get(key).cloned())
            .is_some()
        {
            found = Some(open);
        }
        cursor = close + 3;
    }
    found
}

/// Keep the tail of a long implementer summary (the conclusion matters most).
pub fn clip_summary(summary: &str) -> String {
    if summary.len() <= SUMMARY_CONTEXT_MAX_BYTES {
        return summary.to_string();
    }
    let start = ceil_char_boundary(summary, summary.len() - SUMMARY_CONTEXT_MAX_BYTES);
    format!("[…truncated…]\n{}", &summary[start..])
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

pub fn format_findings(findings: &[Finding]) -> String {
    findings
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let location = match (f.file.as_deref(), f.line) {
                (Some(path), Some(line)) => format!(" `{path}:{line}`"),
                (Some(path), None) => format!(" `{path}`"),
                (None, _) => String::new(),
            };
            let mut entry = format!(
                "{}. [{}]{} — {} ({})",
                i + 1,
                f.severity.label(),
                location,
                f.description,
                f.reviewer
            );
            if let Some(snippet) = f.snippet.as_deref() {
                // A verbatim excerpt survives line drift: the fixer can search
                // for it even after the file has moved underneath the number.
                entry.push_str(&format!("\n   at: `{snippet}`"));
            }
            entry
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Keep a code anchor short: a reviewer that pastes a whole function would
/// otherwise dominate the repair prompt.
fn clip_snippet(snippet: &str) -> String {
    const MAX: usize = 200;
    let one_line = snippet.replace('\n', " ").trim().to_string();
    if one_line.len() <= MAX {
        return one_line;
    }
    let end = floor_char_boundary(&one_line, MAX);
    format!("{}…", &one_line[..end])
}

/// True when `text` carries either machine protocol payload. Used to decide
/// whether an agent's closing message is the authoritative output or whether
/// the payload only appears earlier in the turn.
pub fn has_protocol_payload(text: &str) -> bool {
    extract_last_json_with_key(text, "verdict").is_some()
        || extract_last_json_with_key(text, "need_user_input").is_some()
}

/// Short one-line findings summary for the limit-decision prompt.
pub fn summarize_findings(findings: &[Finding]) -> String {
    let mut counts: [usize; 4] = [0; 4];
    for f in findings {
        counts[match f.severity {
            Severity::Critical => 0,
            Severity::High => 1,
            Severity::Medium => 2,
            Severity::Low => 3,
        }] += 1;
    }
    let parts: Vec<String> = [
        (counts[0], "critical"),
        (counts[1], "high"),
        (counts[2], "medium"),
        (counts[3], "low"),
    ]
    .iter()
    .filter(|(n, _)| *n > 0)
    .map(|(n, label)| format!("{n} {label}"))
    .collect();
    if parts.is_empty() {
        "no open findings".to_string()
    } else {
        format!("open findings: {}", parts.join(", "))
    }
}

// ─── Prompt building ─────────────────────────────────────────────────────────

/// Everything a stage prompt can draw on. Owned strings so the actor can
/// assemble it without borrow gymnastics.
#[derive(Debug, Default, Clone)]
pub struct PromptCtx {
    pub task_prompt: String,
    pub plan: Option<String>,
    pub implementer_summary: Option<String>,
    pub diff: Option<String>,
    /// Pre-formatted findings list (fix stage).
    pub findings: Option<String>,
    /// Previous round's findings (repeat review rounds) — the reviewer must
    /// verify each one instead of reviewing from scratch.
    pub prior_findings: Option<String>,
    pub round: u32,
    pub max_rounds: u32,
    pub guidance: Option<String>,
}

/// Appended to every plan/implement/fix prompt — the question protocol the
/// engine's `parse_stage_signal` understands.
const QUESTION_PROTOCOL: &str = "This stage runs unattended, so stop for the user only when you \
genuinely cannot proceed — a decision only they can make, or missing access. Otherwise pick the \
most reasonable option, proceed, and record the assumption in your final message. When you do \
need them, end your reply with exactly one fenced code block of this shape and stop:\n\
```json\n{\"need_user_input\": \"<your question>\"}\n```\n\
Otherwise, do not emit such a block.";

/// Appended to every reviewer prompt — the verdict protocol the engine's
/// `parse_review_verdict` understands.
const VERDICT_PROTOCOL: &str = "Scope: judge correctness, regressions, and whether the task's \
stated requirements are met. Style, naming, and improvements nobody asked for are `low` at most. \
Report real problems only — do not invent findings to seem thorough. You may run read-only \
verification (build, tests, linters) to check your reasoning, but do not edit files.\n\n\
You MUST end your reply with exactly one fenced code block, and nothing after it, of this \
shape:\n\
```json\n{\"verdict\": \"request_changes\", \"findings\": [{\"severity\": \"high\", \"file\": \"src/example.rs\", \"line\": 42, \"snippet\": \"if attempts > max {\", \"description\": \"what is wrong and why\"}]}\n```\n\
Anchor every finding you can: `line` is the line in the file AFTER the change \
(each diff hunk header `@@ -old +new @@` gives you the new-file line its body \
starts at), and `snippet` is one short verbatim line of the offending code. \
Both are optional but they let the repair stage go straight to the right place \
instead of searching.\n\
When you approve, send `{\"verdict\": \"approve\", \"findings\": []}` — use `approve` only when no \
critical, high, or medium problem remains. `findings` MUST be a JSON array (empty when there are \
none) and every entry MUST carry a `description`: anything you only write in prose is invisible \
to the pipeline. `severity` is critical, high, medium, or low, and `file` may be null. Note that \
`low` findings are recorded for the human but are NEVER sent to the repair stage — use `medium` \
or higher for anything you actually want fixed.";

fn vars_from_ctx(ctx: &PromptCtx, focus: Option<&str>) -> HashMap<&'static str, String> {
    let mut vars: HashMap<&'static str, String> = HashMap::new();
    vars.insert("task_prompt", ctx.task_prompt.clone());
    vars.insert("plan", ctx.plan.clone().unwrap_or_default());
    vars.insert(
        "implementer_summary",
        ctx.implementer_summary.clone().unwrap_or_default(),
    );
    vars.insert("diff", ctx.diff.clone().unwrap_or_default());
    vars.insert("findings", ctx.findings.clone().unwrap_or_default());
    vars.insert("round", ctx.round.to_string());
    vars.insert("max_rounds", ctx.max_rounds.to_string());
    vars.insert("focus", focus.unwrap_or_default().to_string());
    vars
}

fn push_section(out: &mut String, title: &str, body: &str) {
    if body.trim().is_empty() {
        return;
    }
    out.push_str("## ");
    out.push_str(title);
    out.push('\n');
    out.push_str(body.trim_end());
    out.push_str("\n\n");
}

fn finish_prompt(mut body: String, protocol: &str, guidance: Option<&str>) -> String {
    if let Some(guidance) = guidance {
        if !guidance.trim().is_empty() {
            push_section(&mut body, "User guidance", guidance);
        }
    }
    let body = body.trim_end();
    format!("{body}\n\n---\n{protocol}")
}

pub fn build_plan_prompt(spec: &WorkflowSpec, ctx: &PromptCtx) -> String {
    let body = match spec.plan.as_ref().and_then(|s| s.prompt.as_deref()) {
        Some(custom) => render_template(custom, &vars_from_ctx(ctx, None)),
        None => {
            let mut out = String::from(
                "You are the planning stage of a workflow pipeline. Explore the codebase as \
                 needed and produce a concise implementation plan: the files to touch, the \
                 approach, edge cases, and how to verify the result. Do NOT edit any files — \
                 this stage is planning only. Your final message is handed to the implementer \
                 verbatim, so end with the complete plan.\n\n",
            );
            push_section(&mut out, "Task", &ctx.task_prompt);
            out
        }
    };
    finish_prompt(body, QUESTION_PROTOCOL, ctx.guidance.as_deref())
}

pub fn build_implement_prompt(spec: &WorkflowSpec, ctx: &PromptCtx) -> String {
    let body = match spec.implement.prompt.as_deref() {
        Some(custom) => render_template(custom, &vars_from_ctx(ctx, None)),
        None => {
            let mut out = String::from(
                "You are the implementation stage of a workflow pipeline. Implement the task \
                 below completely: write the code, keep the change focused, and verify your \
                 work (build/tests) where feasible. Your final message should summarize what \
                 you did — it is handed to the reviewers.\n\n",
            );
            push_section(&mut out, "Task", &ctx.task_prompt);
            if let Some(plan) = ctx.plan.as_deref() {
                push_section(&mut out, "Approved plan", plan);
            }
            out
        }
    };
    finish_prompt(body, QUESTION_PROTOCOL, ctx.guidance.as_deref())
}

pub fn build_reviewer_prompt(spec: &WorkflowSpec, reviewer: usize, ctx: &PromptCtx) -> String {
    let config = &spec.review.reviewers[reviewer];
    let focus = config.focus.as_deref();
    let body = match config.prompt.as_deref() {
        Some(custom) => render_template(custom, &vars_from_ctx(ctx, focus)),
        None => {
            let mut out = format!(
                "You are a code reviewer in a workflow pipeline (round {}/{}). Review the \
                 changes below against the task. Do NOT edit any files — review only. Judge \
                 what is actually there: verify claims against the diff, and flag real \
                 problems with concrete evidence.\n\n",
                ctx.round, ctx.max_rounds
            );
            if let Some(focus) = focus {
                push_section(&mut out, "Your focus", focus);
            }
            for item in &spec.review.context {
                match item {
                    ReviewContextItem::Prompt => push_section(&mut out, "Task", &ctx.task_prompt),
                    ReviewContextItem::Plan => {
                        if let Some(plan) = ctx.plan.as_deref() {
                            push_section(&mut out, "Approved plan", plan);
                        }
                    }
                    ReviewContextItem::ImplementerSummary => {
                        if let Some(summary) = ctx.implementer_summary.as_deref() {
                            push_section(&mut out, "Implementer's summary", summary);
                        }
                    }
                    ReviewContextItem::Diff => {
                        if let Some(diff) = ctx.diff.as_deref() {
                            push_section(&mut out, "Working-copy diff", diff);
                        }
                    }
                }
            }
            out
        }
    };
    let mut body = body;
    if let Some(prior) = ctx.prior_findings.as_deref() {
        if !body.ends_with('\n') {
            body.push('\n');
        }
        body.push('\n');
        push_section(
            &mut body,
            "Previous round's findings — verify each one",
            &format!(
                "{prior}\n\nThis is a repeat review after a repair pass. For every finding \
                 above, state whether it is actually resolved in the current diff — do not take \
                 the fixer's summary on faith; reopen anything that is not. Then check the rest \
                 of the changes for regressions the repair may have introduced, including code \
                 that was fine last round."
            ),
        );
    }
    // Reviewers get no guidance block — guidance targets implement/fix.
    finish_prompt(body, VERDICT_PROTOCOL, None)
}

/// Follow-up message sent into a reviewer's EXISTING session for a repeat
/// round (`review.reask: same_session`). The session already holds the task,
/// the original diff, and this reviewer's own reasoning, so the follow-up
/// carries only what changed since — plus the explicit anti-anchoring
/// instructions: verify every prior finding and re-check for regressions.
pub fn build_rereview_prompt(ctx: &PromptCtx) -> String {
    let mut out = format!(
        "The repair stage has addressed your review. This is review round {}/{}.\n\n",
        ctx.round, ctx.max_rounds
    );
    if let Some(summary) = ctx.implementer_summary.as_deref() {
        push_section(&mut out, "Fixer's summary", summary);
    }
    if let Some(findings) = ctx.prior_findings.as_deref() {
        push_section(
            &mut out,
            "Findings raised last round (all reviewers)",
            findings,
        );
    }
    if let Some(diff) = ctx.diff.as_deref() {
        push_section(&mut out, "Current working-copy diff", diff);
    }
    push_section(
        &mut out,
        "What to do",
        "Go through each finding above and verify against the current diff that it is actually \
         resolved — do not take the fixer's summary on faith; reopen anything that is not. Then \
         check the changes for regressions the repair may have introduced, including code you \
         found fine last round. Defending your earlier verdict is not a goal — accuracy is.",
    );
    finish_prompt(out, VERDICT_PROTOCOL, None)
}

pub fn build_fix_prompt(spec: &WorkflowSpec, ctx: &PromptCtx) -> String {
    let body = match spec.fix.prompt.as_deref() {
        Some(custom) => render_template(custom, &vars_from_ctx(ctx, None)),
        None => {
            let mut out = format!(
                "You are the repair stage of a workflow pipeline (round {}/{}). Reviewers \
                 found the problems listed below. Address every finding — fix it or, when a \
                 finding is factually wrong, explain why in your summary. Do not change \
                 unrelated code. Your final message should summarize what you changed; it is \
                 handed back to the reviewers.\n\n",
                ctx.round, ctx.max_rounds
            );
            push_section(&mut out, "Task", &ctx.task_prompt);
            if let Some(findings) = ctx.findings.as_deref() {
                push_section(&mut out, "Findings to address", findings);
            }
            if let Some(diff) = ctx.diff.as_deref() {
                push_section(&mut out, "Current working-copy diff", diff);
            }
            out
        }
    };
    finish_prompt(body, QUESTION_PROTOCOL, ctx.guidance.as_deref())
}

/// Follow-up sent to a reviewer whose output had no parseable verdict.
pub fn reask_verdict_prompt(reason: &str) -> String {
    format!(
        "Your previous reply could not be parsed: {reason}. Reply with ONLY the fenced JSON \
         verdict block:\n```json\n{{\"verdict\": \"approve\" | \"request_changes\", \
         \"findings\": [{{\"severity\": \"…\", \"file\": \"…\", \"description\": \"…\"}}]}}\n```"
    )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_config::parse_workflow;

    fn spec(yaml: &str) -> WorkflowSpec {
        parse_workflow("test", yaml).0.expect("valid spec")
    }

    fn run_for(yaml: &str) -> WorkflowRun {
        WorkflowRun::new(
            "t_parent".into(),
            "demo".into(),
            spec(yaml),
            "claude".into(),
            Some("lead-model".into()),
            vec![],
            false,
            HashMap::new(),
        )
    }

    #[test]
    fn stage_signal_detects_trailing_question() {
        let text = "I looked around.\n```json\n{\"need_user_input\": \"Which database?\"}\n```\n";
        assert_eq!(
            parse_stage_signal(text),
            StageSignal::Question("Which database?".into())
        );
        assert_eq!(
            parse_stage_signal("all done, no questions"),
            StageSignal::Output
        );
        // An empty question is not a question.
        assert_eq!(
            parse_stage_signal("```json\n{\"need_user_input\": \"  \"}\n```"),
            StageSignal::Output
        );
    }

    #[test]
    fn verdict_parsing_happy_path_and_aliases() {
        let text = r#"Review done.
```json
{"verdict": "request_changes", "findings": [
  {"severity": "HIGH", "file": "src/a.rs", "description": "off-by-one"},
  {"severity": "nit", "description": "typo"},
  {"severity": "weird", "title": "fallback title"},
  {"description": ""}
]}
```"#;
        let (verdict, findings) = parse_review_verdict(text, "reviewer 1 (claude)").unwrap();
        assert_eq!(verdict, Verdict::RequestChanges);
        assert_eq!(findings.len(), 3, "empty description dropped");
        assert_eq!(findings[0].severity, Severity::High);
        assert_eq!(findings[0].file.as_deref(), Some("src/a.rs"));
        assert_eq!(findings[1].severity, Severity::Low);
        assert_eq!(findings[2].severity, Severity::Medium);
        assert_eq!(findings[2].description, "fallback title");
        assert!(findings.iter().all(|f| f.reviewer == "reviewer 1 (claude)"));
    }

    #[test]
    fn verdict_parsing_uses_last_json_block_and_bare_fences() {
        let text = "```json\n{\"verdict\": \"approve\"}\n```\nwait, actually:\n```\n{\"verdict\": \"request_changes\", \"findings\": []}\n```";
        let (verdict, _) = parse_review_verdict(text, "r").unwrap();
        assert_eq!(verdict, Verdict::RequestChanges);
    }

    #[test]
    fn verdict_parsing_errors() {
        assert!(parse_review_verdict("no block at all", "r")
            .unwrap_err()
            .contains("no fenced JSON"));
        // A JSON block without a `verdict` key is not the protocol payload.
        assert!(
            parse_review_verdict("```json\n{\"findings\": []}\n```", "r")
                .unwrap_err()
                .contains("no fenced JSON")
        );
        assert!(
            parse_review_verdict("```json\n{\"verdict\": \"maybe\"}\n```", "r")
                .unwrap_err()
                .contains("\"maybe\"")
        );
        // Non-JSON fenced blocks are skipped, not fatal.
        let text = "```rust\nfn x() {}\n```\n```json\n{\"verdict\": \"approve\"}\n```";
        assert!(parse_review_verdict(text, "r").is_ok());
    }

    #[test]
    fn verdict_parsing_reads_finding_anchors() {
        let text = r#"```json
{"verdict": "request_changes", "findings": [
  {"severity": "high", "file": "src/a.rs", "line": 42, "snippet": "if attempts > max {", "description": "off-by-one"},
  {"severity": "high", "file": "src/b.rs", "line": "17-20", "code": "let x = 1;", "description": "string range"},
  {"severity": "low", "line": 0, "description": "no anchor"}
]}
```"#;
        let (_, findings) = parse_review_verdict(text, "r").unwrap();
        assert_eq!(findings[0].line, Some(42));
        assert_eq!(findings[0].snippet.as_deref(), Some("if attempts > max {"));
        // A range and a `code` alias both resolve.
        assert_eq!(findings[1].line, Some(17));
        assert_eq!(findings[1].snippet.as_deref(), Some("let x = 1;"));
        // Line 0 is not a location.
        assert_eq!(findings[2].line, None);
        assert_eq!(findings[2].snippet, None);

        // Anchors reach the repair prompt.
        let rendered = format_findings(&findings);
        assert!(rendered.contains("`src/a.rs:42`"), "{rendered}");
        assert!(rendered.contains("at: `if attempts > max {`"), "{rendered}");
        assert!(rendered.contains("`src/b.rs:17`"), "{rendered}");

        // An oversized excerpt is clipped to one line.
        let long = format!(
            "```json\n{{\"verdict\": \"approve\", \"findings\": [{{\"description\": \"d\", \"snippet\": \"{}\"}}]}}\n```",
            "x".repeat(400)
        );
        let (_, findings) = parse_review_verdict(&long, "r").unwrap();
        let snippet = findings[0].snippet.as_deref().unwrap();
        assert!(snippet.len() <= 204, "{}", snippet.len());
        assert!(snippet.ends_with('…'));
    }

    #[test]
    fn protocol_payload_detection() {
        assert!(has_protocol_payload(
            "```json\n{\"verdict\": \"approve\"}\n```"
        ));
        assert!(has_protocol_payload(
            "```json\n{\"need_user_input\": \"which db?\"}\n```"
        ));
        // An unrelated JSON block is not a protocol payload — this is what
        // keeps a quoted config file from hijacking a stage's result.
        assert!(!has_protocol_payload("```json\n{\"name\": \"pkg\"}\n```"));
        assert!(!has_protocol_payload("just prose"));
    }

    #[test]
    fn merge_reviews_requires_unanimous_approve() {
        let f = |desc: &str| Finding {
            severity: Severity::High,
            file: None,
            line: None,
            snippet: None,
            description: desc.into(),
            reviewer: "r".into(),
        };
        let (verdict, findings) = merge_reviews(&[
            (1, Verdict::Approve, vec![f("b")]),
            (0, Verdict::RequestChanges, vec![f("a")]),
        ]);
        assert_eq!(verdict, Verdict::RequestChanges);
        // Findings ordered by reviewer index.
        assert_eq!(findings[0].description, "a");
        assert_eq!(findings[1].description, "b");

        let (verdict, _) =
            merge_reviews(&[(0, Verdict::Approve, vec![]), (1, Verdict::Approve, vec![])]);
        assert_eq!(verdict, Verdict::Approve);
    }

    #[test]
    fn stage_agent_fallback_chain() {
        let run = run_for(
            "name: X\nplan: {}\nimplement:\n  agent: codex\n  model: gpt-x\nreview:\n  reviewers:\n    - agent: opencode\n    - {}\n",
        );
        // plan has no override → lead agent + lead model.
        assert_eq!(
            run.stage_agent(StageKind::Plan, None),
            ("claude".into(), Some("lead-model".into()))
        );
        // implement overrides both.
        assert_eq!(
            run.stage_agent(StageKind::Implement, None),
            ("codex".into(), Some("gpt-x".into()))
        );
        // fix falls back to implement's overrides.
        assert_eq!(
            run.stage_agent(StageKind::Fix, None),
            ("codex".into(), Some("gpt-x".into()))
        );
        // reviewer 0 overrides agent, inherits lead model; reviewer 1 → lead.
        assert_eq!(
            run.stage_agent(StageKind::Review, Some(0)),
            ("opencode".into(), Some("lead-model".into()))
        );
        assert_eq!(
            run.stage_agent(StageKind::Review, Some(1)),
            ("claude".into(), Some("lead-model".into()))
        );
    }

    #[test]
    fn first_stage_respects_plan_presence() {
        assert_eq!(run_for("name: X\n").first_stage(), StageKind::Implement);
        assert_eq!(
            run_for("name: X\nplan: {}\n").first_stage(),
            StageKind::Plan
        );
    }

    #[test]
    fn default_prompts_include_context_and_protocols() {
        let run = run_for("name: X\nplan: {}\nreview:\n  reviewers:\n    - focus: security only\n");
        let ctx = PromptCtx {
            task_prompt: "Add rate limiting".into(),
            plan: Some("1. do things".into()),
            implementer_summary: Some("did things".into()),
            diff: Some("--- a/x\n+++ b/x".into()),
            findings: Some("1. [high] — bug (r)".into()),
            prior_findings: None,
            round: 1,
            max_rounds: 2,
            guidance: Some("prefer tower middleware".into()),
        };

        let plan = build_plan_prompt(&run.spec, &ctx);
        assert!(plan.contains("Add rate limiting"));
        assert!(plan.contains("need_user_input"));
        assert!(plan.contains("User guidance"));

        let implement = build_implement_prompt(&run.spec, &ctx);
        assert!(implement.contains("Approved plan"));
        assert!(implement.contains("1. do things"));

        let review = build_reviewer_prompt(&run.spec, 0, &ctx);
        assert!(review.contains("security only"));
        assert!(review.contains("Working-copy diff"));
        assert!(review.contains("\"verdict\""));
        assert!(
            !review.contains("User guidance"),
            "guidance must not leak to reviewers"
        );

        let fix = build_fix_prompt(&run.spec, &ctx);
        assert!(fix.contains("Findings to address"));
        assert!(fix.contains("round 1/2"));
    }

    #[test]
    fn custom_prompts_render_placeholders_and_keep_protocol() {
        let run = run_for(
            "name: X\nimplement:\n  prompt: \"Do {{task_prompt}} now\"\nreview:\n  reviewers:\n    - prompt: \"{{focus}} check {{diff}} r{{round}}\"\n      focus: perf\n",
        );
        let ctx = PromptCtx {
            task_prompt: "the thing".into(),
            diff: Some("DIFF".into()),
            round: 2,
            max_rounds: 3,
            ..Default::default()
        };
        let implement = build_implement_prompt(&run.spec, &ctx);
        assert!(implement.starts_with("Do the thing now"));
        assert!(
            implement.contains("need_user_input"),
            "protocol always appended"
        );

        let review = build_reviewer_prompt(&run.spec, 0, &ctx);
        assert!(review.starts_with("perf check DIFF r2"));
        assert!(review.contains("\"verdict\""));
    }

    #[test]
    fn repeat_round_reviewer_prompt_verifies_prior_findings() {
        let run = run_for("name: X\nreview:\n  reviewers:\n    - focus: security\n");
        let base = PromptCtx {
            task_prompt: "Add rate limiting".into(),
            diff: Some("DIFF".into()),
            round: 2,
            max_rounds: 3,
            ..Default::default()
        };
        // Round 1 (no prior findings): no verification section.
        let first = build_reviewer_prompt(&run.spec, 0, &base);
        assert!(!first.contains("Previous round's findings"));

        let ctx = PromptCtx {
            prior_findings: Some("1. [high] `a.rs` — bug here (reviewer)".into()),
            ..base.clone()
        };
        let repeat = build_reviewer_prompt(&run.spec, 0, &ctx);
        assert!(repeat.contains("Previous round's findings — verify each one"));
        assert!(repeat.contains("bug here"));
        assert!(repeat.contains("regressions"));

        // The verification section is engine-owned: custom reviewer prompts
        // get it appended too, without any template changes.
        let custom = run_for("name: X\nreview:\n  reviewers:\n    - prompt: \"check {{diff}}\"\n");
        let repeat = build_reviewer_prompt(&custom.spec, 0, &ctx);
        assert!(repeat.starts_with("check DIFF"));
        assert!(repeat.contains("Previous round's findings — verify each one"));
        assert!(
            repeat.contains("\"verdict\""),
            "protocol still appended last"
        );
    }

    #[test]
    fn rereview_followup_carries_delta_and_instructions() {
        let ctx = PromptCtx {
            task_prompt: "irrelevant — the session already has it".into(),
            implementer_summary: Some("FIX-DONE: patched the parser".into()),
            prior_findings: Some("1. [high] — off-by-one (reviewer)".into()),
            diff: Some("THE-NEW-DIFF".into()),
            round: 2,
            max_rounds: 2,
            ..Default::default()
        };
        let followup = build_rereview_prompt(&ctx);
        assert!(followup.starts_with("The repair stage has addressed your review"));
        assert!(followup.contains("round 2/2"));
        assert!(followup.contains("FIX-DONE: patched the parser"));
        assert!(followup.contains("off-by-one"));
        assert!(followup.contains("THE-NEW-DIFF"));
        assert!(followup.contains("regressions"));
        assert!(
            followup.contains("\"verdict\""),
            "verdict protocol reminder"
        );
        // The session already has the task prompt — the follow-up must not
        // re-send it.
        assert!(!followup.contains("irrelevant — the session already has it"));
    }

    #[test]
    fn all_children_spans_history_and_active() {
        let mut run = run_for("name: X\n");
        run.record_stage(StageKind::Implement, "t_impl", "claude", "implement".into());
        run.record_stage(StageKind::Review, "t_rev", "claude", "reviewer".into());
        run.active_children.insert("t_fix".into(), StageKind::Fix);
        let all = run.all_children();
        assert_eq!(all.len(), 3);
        for id in ["t_impl", "t_rev", "t_fix"] {
            assert!(all.contains(id), "{id} missing");
        }
    }

    #[test]
    fn diff_formatting_and_truncation() {
        let hunk = wire::Hunk {
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            lines: vec!["-old".into(), "+new".into()],
            resolution: None,
        };
        let small = vec![wire::FileDiff {
            path: "src/a.rs".into(),
            old_path: None,
            status: wire::FileDiffStatus::Modified,
            hunks: vec![hunk.clone()],
        }];
        let text = format_diff(&small);
        assert!(text.contains("--- a/src/a.rs"));
        assert!(text.contains("+new"));

        let big_hunk = wire::Hunk {
            lines: vec!["+x".to_string(); 300_000],
            ..hunk
        };
        let big = vec![
            wire::FileDiff {
                path: "src/big.rs".into(),
                old_path: None,
                status: wire::FileDiffStatus::Modified,
                hunks: vec![big_hunk],
            },
            wire::FileDiff {
                path: "src/other.rs".into(),
                old_path: None,
                status: wire::FileDiffStatus::Added,
                hunks: vec![],
            },
        ];
        let text = format_diff(&big);
        assert!(text.len() < DIFF_CONTEXT_MAX_BYTES + 1024);
        assert!(text.contains("[diff truncated"));
        assert!(
            text.contains("- src/other.rs"),
            "file list survives truncation"
        );

        assert_eq!(format_diff(&[]), "(no changes in the working copy)");
    }

    #[test]
    fn summary_clip_keeps_tail() {
        let long = format!("{}THE-END", "x".repeat(SUMMARY_CONTEXT_MAX_BYTES * 2));
        let clipped = clip_summary(&long);
        assert!(clipped.len() <= SUMMARY_CONTEXT_MAX_BYTES + 32);
        assert!(clipped.ends_with("THE-END"));
        assert!(clipped.starts_with("[…truncated…]"));
        assert_eq!(clip_summary("short"), "short");
    }

    #[test]
    fn wire_info_reflects_state() {
        let mut run = run_for("name: My flow\nreview:\n  max_rounds: 2\n");
        run.state = RunState::Running {
            stage: StageKind::Implement,
        };
        let info = run.wire_info();
        assert_eq!(info.stage, wire::WorkflowStage::Implement);
        assert!(info.waiting.is_none());
        assert!(!info.pause_requested);
        assert_eq!(info.max_rounds, 2);

        // A requested pause is visible before it takes effect, so the UI can
        // show progress rather than an idle Pause button.
        run.pause_requested = true;
        assert!(run.wire_info().pause_requested);
        run.pause_requested = false;

        run.extra_rounds = 2;
        run.state = RunState::AwaitingReply {
            stage: StageKind::Plan,
            child: "t_c".into(),
            question: "which db?".into(),
        };
        let info = run.wire_info();
        assert_eq!(info.max_rounds, 4);
        let waiting = info.waiting.unwrap();
        assert_eq!(waiting.kind, wire::WorkflowWaitKind::Question);
        assert_eq!(waiting.question.as_deref(), Some("which db?"));

        run.open_findings = vec![Finding {
            severity: Severity::High,
            file: None,
            line: None,
            snippet: None,
            description: "d".into(),
            reviewer: "r".into(),
        }];
        run.state = RunState::AwaitingLimitDecision;
        let waiting = run.wire_info().waiting.unwrap();
        assert_eq!(waiting.kind, wire::WorkflowWaitKind::Limit);
        assert_eq!(waiting.question.as_deref(), Some("open findings: 1 high"));

        run.state = RunState::Paused {
            next: StageKind::Fix,
        };
        let info = run.wire_info();
        assert_eq!(info.stage, wire::WorkflowStage::Fix);
        assert_eq!(info.waiting.unwrap().kind, wire::WorkflowWaitKind::Paused);
    }

    #[test]
    fn graph_info_maps_history() {
        let mut run = run_for("name: X\n");
        run.record_stage(StageKind::Implement, "t_1", "claude", "implement".into());
        run.set_record_status("t_1", wire::OrchNodeStatus::Complete);
        run.record_stage(
            StageKind::Review,
            "t_2",
            "codex",
            "reviewer 1/2 (codex)".into(),
        );
        let graph = run.graph_info();
        assert_eq!(graph.goal, "X");
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.nodes[0].status, wire::OrchNodeStatus::Complete);
        assert_eq!(graph.nodes[0].kind, wire::OrchNodeKind::Implement);
        assert_eq!(graph.nodes[1].task_id.as_deref(), Some("t_2"));
        assert_eq!(graph.nodes[1].kind, wire::OrchNodeKind::Review);
    }

    #[test]
    fn run_serialization_roundtrip() {
        let mut run = run_for("name: X\nplan: {}\n");
        run.state = RunState::Paused {
            next: StageKind::Review,
        };
        run.round = 2;
        run.open_findings = vec![Finding {
            severity: Severity::Critical,
            file: Some("a.rs".into()),
            line: Some(7),
            snippet: Some("let x = 1;".into()),
            description: "boom".into(),
            reviewer: "r".into(),
        }];
        let json = serde_json::to_string(&run).unwrap();
        let restored: WorkflowRun = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.state, run.state);
        assert_eq!(restored.round, 2);
        assert_eq!(restored.spec, run.spec);
        assert_eq!(restored.open_findings, run.open_findings);
    }
}
