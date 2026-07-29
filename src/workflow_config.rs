//! Workflow templates: `.warpforge/workflows/*.yaml` parsing and validation,
//! `{{placeholder}}` prompt-template rendering, and the built-in templates
//! shipped with the binary.
//!
//! The pipeline shape is fixed (`plan? → implement → review ⇄ fix`), so a
//! workflow file configures the fixed stages rather than declaring arbitrary
//! ones.
//!
//! This module is deliberately independent of daemon internals: the daemon's
//! workflow engine consumes [`WorkflowSpec`], and everything here is plain
//! sync code unit-testable in isolation.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The only workflow file format version this build understands.
pub const SUPPORTED_VERSION: u64 = 1;
/// Hard cap on review ⇄ fix rounds a YAML may request (a human can still
/// extend a running pipeline past this — that is an explicit decision).
pub const MAX_ROUNDS_CAP: u32 = 5;
pub const DEFAULT_MAX_ROUNDS: u32 = 2;
pub const MAX_REVIEWERS: usize = 4;

/// Built-in templates, selectable everywhere and ejectable into a project.
/// A project file with the same id overrides (hides) the built-in.
pub const BUILTIN_WORKFLOWS: &[(&str, &str)] = &[
    ("review-loop", include_str!("workflows/review-loop.yaml")),
    (
        "plan-review-loop",
        include_str!("workflows/plan-review-loop.yaml"),
    ),
];

// ─── Validated model ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowSpec {
    /// File stem for project workflows, registry key for built-ins.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `Some` when the optional planning stage is enabled.
    pub plan: Option<StageConfig>,
    pub implement: StageConfig,
    pub review: ReviewConfig,
    pub fix: StageConfig,
}

/// Per-stage overrides. `None` falls back to the lead agent / model picked in
/// the New Task dialog (for `fix`: to the `implement` stage's values) and to
/// the built-in stage prompt.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StageConfig {
    pub agent: Option<String>,
    pub model: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewConfig {
    pub max_rounds: u32,
    pub on_limit: OnLimit,
    /// How repeat review rounds are staffed after a fix.
    #[serde(default)]
    pub reask: ReaskMode,
    // These collections carry `serde(default)` because a `WorkflowSpec` is
    // persisted inside a running pipeline's snapshot: a field that is required
    // on load turns every in-flight run unreadable after an upgrade.
    #[serde(default)]
    pub context: Vec<ReviewContextItem>,
    /// Always 1..=MAX_REVIEWERS entries; defaults to one all-`None` reviewer.
    #[serde(default)]
    pub reviewers: Vec<ReviewerConfig>,
    /// True when the YAML set `context` explicitly. Only drives the warning
    /// that the key is inert alongside custom reviewer prompts.
    #[serde(default, skip_serializing)]
    pub context_was_set: bool,
}

/// Who reviews repeat rounds after a fix.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaskMode {
    /// Follow up in the same reviewer session: it remembers its own findings
    /// and verifies each one is actually resolved, at the cost of some
    /// anchoring bias. Falls back to a fresh session when the old one is gone
    /// (daemon restart, agent death).
    #[default]
    SameSession,
    /// Spawn fresh reviewer sessions every round. The previous round's
    /// findings are still included in the prompt for verification.
    Fresh,
}

/// What the pipeline does when `max_rounds` is exhausted with open findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnLimit {
    /// Suspend and ask the user (extend / finish / stop).
    Ask,
    /// Finish as NeedsReview with the open findings in the summary.
    Finish,
}

/// One piece of context assembled into a reviewer's prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewContextItem {
    /// The task prompt the user typed.
    Prompt,
    /// The plan stage output, when that stage ran.
    Plan,
    /// The final text of the last implement/fix session.
    ImplementerSummary,
    /// The working-copy diff.
    Diff,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReviewerConfig {
    pub agent: Option<String>,
    pub model: Option<String>,
    /// Appended to the default reviewer prompt (available as `{{focus}}`).
    pub focus: Option<String>,
    /// Full prompt override for this reviewer.
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowSource {
    Project,
    Builtin,
}

/// A workflow as found on disk (or built in): invalid files are carried as
/// `Err` so pickers can list them greyed-out with the reason.
#[derive(Debug)]
pub struct LoadedWorkflow {
    pub id: String,
    pub source: WorkflowSource,
    pub spec: Result<WorkflowSpec, String>,
    pub warnings: Vec<String>,
}

impl WorkflowSpec {
    /// Stage names for picker tooltips, e.g. `["plan", "implement", "review×2", "fix"]`.
    pub fn stage_summary(&self) -> Vec<String> {
        let mut stages = Vec::new();
        if self.plan.is_some() {
            stages.push("plan".to_string());
        }
        stages.push("implement".to_string());
        stages.push(match self.review.reviewers.len() {
            1 => "review".to_string(),
            n => format!("review×{n}"),
        });
        stages.push("fix".to_string());
        stages
    }
}

// ─── Raw YAML shape ──────────────────────────────────────────────────────────

/// Deserialize an optional mapping so that a bare `plan:` (YAML null) means
/// "present with defaults", while an absent key stays `None`.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    let value = Option::<T>::deserialize(deserializer)?;
    Ok(Some(value.unwrap_or_default()))
}

/// Like [`nullable`], but `false` means "this stage is off". Deleting the key
/// is the canonical way to disable planning; `plan: false` is the obvious
/// guess, so accept it instead of failing with a type error.
fn nullable_or_false<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Toggle<T> {
        Off(bool),
        On(T),
    }
    match Option::<Toggle<T>>::deserialize(deserializer)? {
        None => Ok(Some(T::default())),
        Some(Toggle::Off(false)) => Ok(None),
        Some(Toggle::Off(true)) => Ok(Some(T::default())),
        Some(Toggle::On(value)) => Ok(Some(value)),
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawWorkflow {
    version: Option<u64>,
    name: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "nullable_or_false")]
    plan: Option<RawStage>,
    #[serde(default, deserialize_with = "nullable")]
    implement: Option<RawStage>,
    #[serde(default, deserialize_with = "nullable")]
    review: Option<RawReview>,
    #[serde(default, deserialize_with = "nullable")]
    fix: Option<RawStage>,
}

#[derive(Debug, Default, Deserialize)]
struct RawStage {
    agent: Option<String>,
    model: Option<String>,
    prompt: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawReview {
    max_rounds: Option<u32>,
    on_limit: Option<String>,
    reask: Option<String>,
    context: Option<Vec<String>>,
    reviewers: Option<Vec<RawReviewer>>,
}

#[derive(Debug, Default, Deserialize)]
struct RawReviewer {
    agent: Option<String>,
    model: Option<String>,
    focus: Option<String>,
    prompt: Option<String>,
}

// ─── Parsing and validation ──────────────────────────────────────────────────

/// Parse and validate one workflow file. Returns the spec (or a human-readable
/// error making the file invalid) plus non-fatal warnings either way.
pub fn parse_workflow(id: &str, yaml: &str) -> (Result<WorkflowSpec, String>, Vec<String>) {
    let mut warnings = Vec::new();
    let value: serde_yaml::Value = match serde_yaml::from_str(yaml) {
        Ok(value) => value,
        Err(e) => return (Err(format!("invalid YAML: {e}")), warnings),
    };
    if !value.is_mapping() {
        return (
            Err("workflow file must be a YAML mapping".to_string()),
            warnings,
        );
    }
    collect_unknown_keys(&value, &mut warnings);
    // Deserialize from the source text, not the `Value` above: only `from_str`
    // reports the offending key path plus line and column, and that message is
    // what the picker shows as the reason a workflow is rejected.
    let raw: RawWorkflow = match serde_yaml::from_str(yaml) {
        Ok(raw) => raw,
        Err(e) => return (Err(format!("invalid workflow: {e}")), warnings),
    };
    (build_spec(id, raw, &mut warnings), warnings)
}

/// Unknown keys are forward-compatible warnings, not errors — `workflow.list`
/// surfaces them in picker tooltips.
fn collect_unknown_keys(value: &serde_yaml::Value, warnings: &mut Vec<String>) {
    const TOP: &[&str] = &[
        "version",
        "name",
        "description",
        "plan",
        "implement",
        "review",
        "fix",
    ];
    const STAGE: &[&str] = &["agent", "model", "prompt"];
    const REVIEW: &[&str] = &["max_rounds", "on_limit", "reask", "context", "reviewers"];
    const REVIEWER: &[&str] = &["agent", "model", "focus", "prompt"];

    check_keys(value, TOP, "top level", warnings);
    for stage in ["plan", "implement", "fix"] {
        if let Some(v) = value.get(stage) {
            check_keys(v, STAGE, stage, warnings);
        }
    }
    if let Some(review) = value.get("review") {
        check_keys(review, REVIEW, "review", warnings);
        if let Some(serde_yaml::Value::Sequence(reviewers)) = review.get("reviewers") {
            for (i, reviewer) in reviewers.iter().enumerate() {
                check_keys(
                    reviewer,
                    REVIEWER,
                    &format!("review.reviewers[{i}]"),
                    warnings,
                );
            }
        }
    }
}

fn check_keys(
    value: &serde_yaml::Value,
    known: &[&str],
    location: &str,
    warnings: &mut Vec<String>,
) {
    let serde_yaml::Value::Mapping(map) = value else {
        return;
    };
    for key in map.keys() {
        if let Some(key) = key.as_str() {
            if !known.contains(&key) {
                warnings.push(format!("unknown key `{key}` in {location}"));
            }
        }
    }
}

fn build_spec(
    id: &str,
    raw: RawWorkflow,
    warnings: &mut Vec<String>,
) -> Result<WorkflowSpec, String> {
    let version = raw.version.unwrap_or(SUPPORTED_VERSION);
    if version != SUPPORTED_VERSION {
        return Err(format!(
            "unsupported workflow version {version} (this build supports {SUPPORTED_VERSION})"
        ));
    }
    let name = raw.name.as_deref().map(str::trim).unwrap_or_default();
    if name.is_empty() {
        return Err("`name` is required".to_string());
    }

    let plan = raw.plan.map(stage_config);
    let implement = raw.implement.map(stage_config).unwrap_or_default();
    let fix = raw.fix.map(stage_config).unwrap_or_default();
    let review = build_review(raw.review.unwrap_or_default(), warnings)?;

    // A placeholder this workflow can never populate renders as an empty
    // section, so scope the allow-lists: `{{plan}}` needs a plan stage and
    // `{{focus}}` needs that reviewer to define one.
    let has_plan = plan.is_some();
    let allow = |vars: &[&'static str], _focus: bool| -> Vec<&'static str> {
        vars.iter()
            .copied()
            .filter(|name| match *name {
                "plan" => has_plan,
                _ => true,
            })
            .collect()
    };
    validate_prompt(
        plan.as_ref().and_then(|s| s.prompt.as_deref()),
        "plan",
        &allow(VARS_PLAN, false),
    )?;
    validate_prompt(
        implement.prompt.as_deref(),
        "implement",
        &allow(VARS_IMPLEMENT, false),
    )?;
    validate_prompt(fix.prompt.as_deref(), "fix", &allow(VARS_FIX, false))?;
    for (i, reviewer) in review.reviewers.iter().enumerate() {
        validate_prompt(
            reviewer.prompt.as_deref(),
            &format!("review.reviewers[{i}]"),
            &allow(VARS_REVIEW, reviewer.focus.is_some()),
        )?;
    }
    // `context` and `focus` only shape the BUILT-IN reviewer prompt: a custom
    // prompt renders its own context. Silently ignoring them is the most
    // confusing possible outcome for the first edit a user makes.
    if review.reviewers.iter().all(|r| r.prompt.is_some()) {
        if review.context_was_set {
            warnings.push(
                "review.context is ignored because every reviewer defines its own `prompt` — a \
                 custom prompt decides what context it includes"
                    .to_string(),
            );
        }
        for (i, reviewer) in review.reviewers.iter().enumerate() {
            let uses_focus = reviewer
                .prompt
                .as_deref()
                .is_some_and(|p| extract_placeholders(p).iter().any(|v| v == "focus"));
            if reviewer.focus.is_some() && !uses_focus {
                warnings.push(format!(
                    "review.reviewers[{i}].focus is ignored because that reviewer's `prompt` \
                     never uses {{{{focus}}}}"
                ));
            }
        }
    }

    Ok(WorkflowSpec {
        id: id.to_string(),
        name: name.to_string(),
        description: raw
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
        plan,
        implement,
        review,
        fix,
    })
}

fn stage_config(raw: RawStage) -> StageConfig {
    StageConfig {
        agent: raw.agent,
        model: raw.model,
        prompt: raw.prompt,
    }
}

fn build_review(raw: RawReview, warnings: &mut Vec<String>) -> Result<ReviewConfig, String> {
    let context_was_set = raw.context.is_some();
    let mut max_rounds = raw.max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS);
    if max_rounds == 0 {
        return Err("review.max_rounds must be at least 1".to_string());
    }
    if max_rounds > MAX_ROUNDS_CAP {
        warnings.push(format!(
            "review.max_rounds {max_rounds} exceeds the cap, clamped to {MAX_ROUNDS_CAP}"
        ));
        max_rounds = MAX_ROUNDS_CAP;
    }

    let reask = match raw.reask.as_deref() {
        None => ReaskMode::default(),
        Some("same_session") => ReaskMode::SameSession,
        Some("fresh") => ReaskMode::Fresh,
        Some(other) => {
            return Err(format!(
                "review.reask must be `same_session` or `fresh`, got `{other}`"
            ))
        }
    };

    let on_limit = match raw.on_limit.as_deref() {
        None => OnLimit::Ask,
        Some("ask") => OnLimit::Ask,
        Some("finish") => OnLimit::Finish,
        Some(other) => {
            return Err(format!(
                "review.on_limit must be `ask` or `finish`, got `{other}`"
            ))
        }
    };

    let context = match raw.context {
        None => vec![
            ReviewContextItem::Prompt,
            ReviewContextItem::Plan,
            ReviewContextItem::ImplementerSummary,
            ReviewContextItem::Diff,
        ],
        Some(items) => {
            if items.is_empty() {
                warnings.push(
                    "review.context is empty — reviewers will only see their instructions"
                        .to_string(),
                );
            }
            let mut parsed = Vec::with_capacity(items.len());
            for item in &items {
                parsed.push(match item.as_str() {
                    "prompt" => ReviewContextItem::Prompt,
                    "plan" => ReviewContextItem::Plan,
                    "implementer_summary" => ReviewContextItem::ImplementerSummary,
                    "diff" => ReviewContextItem::Diff,
                    other => {
                        return Err(format!(
                            "unknown review.context item `{other}` (expected prompt, plan, implementer_summary, diff)"
                        ))
                    }
                });
            }
            parsed
        }
    };

    let reviewers = match raw.reviewers {
        None => vec![ReviewerConfig::default()],
        Some(list) => {
            if list.is_empty() || list.len() > MAX_REVIEWERS {
                return Err(format!(
                    "review.reviewers must list 1..{MAX_REVIEWERS} reviewers when set, got {}",
                    list.len()
                ));
            }
            list.into_iter()
                .map(|r| ReviewerConfig {
                    agent: r.agent,
                    model: r.model,
                    focus: r.focus,
                    prompt: r.prompt,
                })
                .collect()
        }
    };

    Ok(ReviewConfig {
        max_rounds,
        on_limit,
        reask,
        context,
        reviewers,
        context_was_set,
    })
}

// ─── Prompt templates ────────────────────────────────────────────────────────

/// Placeholders each stage's custom prompt may use. An unknown placeholder is
/// a validation error — silently rendering `{{typo}}` verbatim into an agent
/// prompt would be far harder to notice.
pub const VARS_PLAN: &[&str] = &["task_prompt"];
pub const VARS_IMPLEMENT: &[&str] = &["task_prompt", "plan"];
pub const VARS_REVIEW: &[&str] = &[
    "task_prompt",
    "plan",
    "implementer_summary",
    "diff",
    "round",
    "max_rounds",
    "focus",
];
pub const VARS_FIX: &[&str] = &[
    "task_prompt",
    "plan",
    "implementer_summary",
    "diff",
    "findings",
    "round",
    "max_rounds",
];

fn validate_prompt(
    prompt: Option<&str>,
    stage: &str,
    allowed: &[&'static str],
) -> Result<(), String> {
    let Some(prompt) = prompt else {
        return Ok(());
    };
    for name in extract_placeholders(prompt) {
        if !allowed.contains(&name.as_str()) {
            return Err(format!(
                "unknown placeholder {{{{{name}}}}} in {stage} prompt (allowed: {})",
                allowed.join(", ")
            ));
        }
    }
    Ok(())
}

/// `{{name}}` occurrences as (start, end-exclusive, trimmed name). Only
/// identifier-shaped names count; other `{{…}}` text is left alone.
fn scan_placeholders(template: &str) -> Vec<(usize, usize, String)> {
    let mut found = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while let Some(open) = template[i..].find("{{").map(|p| i + p) {
        let Some(close) = template[open + 2..].find("}}").map(|p| open + 2 + p) else {
            break;
        };
        let name = template[open + 2..close].trim();
        let is_ident =
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if is_ident {
            found.push((open, close + 2, name.to_string()));
            i = close + 2;
        } else {
            // Skip just the opening braces so `{{ {{diff}}` still finds the
            // inner placeholder.
            i = open + 2;
        }
        if i >= bytes.len() {
            break;
        }
    }
    found
}

/// Distinct placeholder names used in a template, in order of first use.
pub fn extract_placeholders(template: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    scan_placeholders(template)
        .into_iter()
        .map(|(_, _, name)| name)
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

/// Substitute `{{name}}` placeholders. Names missing from `vars` are left
/// verbatim (validation has already rejected unknown names at load time).
/// Consumed by the workflow engine when it renders stage prompts.
#[allow(dead_code)]
pub fn render_template(template: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut last = 0;
    for (start, end, name) in scan_placeholders(template) {
        if let Some(value) = vars.get(name.as_str()) {
            out.push_str(&template[last..start]);
            out.push_str(value);
            last = end;
        }
    }
    out.push_str(&template[last..]);
    out
}

// ─── Disk access ─────────────────────────────────────────────────────────────

pub fn workflows_dir(project_path: &Path) -> PathBuf {
    project_path.join(".warpforge").join("workflows")
}

/// All workflows visible to a project: `.warpforge/workflows/*.{yaml,yml}`
/// (sorted by file name; on duplicate stems the first file wins) followed by
/// built-ins not overridden by a project file with the same id.
pub fn list_workflows(project_path: &Path) -> Vec<LoadedWorkflow> {
    let mut out: Vec<LoadedWorkflow> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut files: Vec<PathBuf> = fs::read_dir(workflows_dir(project_path))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    matches!(
                        path.extension().and_then(|e| e.to_str()),
                        Some("yaml") | Some("yml")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();

    for path in files {
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !seen.insert(id.clone()) {
            if let Some(existing) = out.iter_mut().find(|w| w.id == id) {
                existing
                    .warnings
                    .push(format!("duplicate workflow file ignored: {file_name}"));
            }
            continue;
        }
        let (spec, warnings) = match fs::read_to_string(&path) {
            Ok(text) => parse_workflow(&id, &text),
            Err(e) => (Err(format!("reading {file_name}: {e}")), Vec::new()),
        };
        out.push(LoadedWorkflow {
            id,
            source: WorkflowSource::Project,
            spec,
            warnings,
        });
    }

    for (id, text) in BUILTIN_WORKFLOWS {
        if seen.contains(*id) {
            continue;
        }
        let (spec, warnings) = parse_workflow(id, text);
        out.push(LoadedWorkflow {
            id: (*id).to_string(),
            source: WorkflowSource::Builtin,
            spec,
            warnings,
        });
    }

    out
}

/// Load one workflow by id: the project file wins over a built-in.
/// Consumed by the workflow engine when a task starts with a workflow.
#[allow(dead_code)]
pub fn load_workflow(project_path: &Path, id: &str) -> Option<LoadedWorkflow> {
    list_workflows(project_path)
        .into_iter()
        .find(|w| w.id == id)
}

/// Copy a built-in workflow into the project's workflows directory so the
/// user can customize it. Refuses to overwrite an existing file.
pub fn eject_builtin(project_path: &Path, id: &str) -> Result<PathBuf> {
    let Some((_, text)) = BUILTIN_WORKFLOWS.iter().find(|(bid, _)| *bid == id) else {
        bail!("no built-in workflow `{id}`");
    };
    let dir = workflows_dir(project_path);
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    for ext in ["yaml", "yml"] {
        let existing = dir.join(format!("{id}.{ext}"));
        if existing.exists() {
            bail!("{} already exists", existing.display());
        }
    }
    let target = dir.join(format!("{id}.yaml"));
    fs::write(&target, text).with_context(|| format!("writing {}", target.display()))?;
    Ok(target)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(yaml: &str) -> (WorkflowSpec, Vec<String>) {
        let (spec, warnings) = parse_workflow("test", yaml);
        (spec.expect("expected valid workflow"), warnings)
    }

    fn parse_err(yaml: &str) -> String {
        let (spec, _) = parse_workflow("test", yaml);
        spec.expect_err("expected invalid workflow")
    }

    #[test]
    fn minimal_workflow_gets_defaults() {
        let (spec, warnings) = parse_ok("name: Minimal\n");
        assert!(warnings.is_empty());
        assert_eq!(spec.name, "Minimal");
        assert!(spec.plan.is_none());
        assert_eq!(spec.implement, StageConfig::default());
        assert_eq!(spec.review.max_rounds, DEFAULT_MAX_ROUNDS);
        assert_eq!(spec.review.on_limit, OnLimit::Ask);
        assert_eq!(spec.review.reask, ReaskMode::SameSession);
        assert_eq!(spec.review.reviewers, vec![ReviewerConfig::default()]);
        assert_eq!(
            spec.review.context,
            vec![
                ReviewContextItem::Prompt,
                ReviewContextItem::Plan,
                ReviewContextItem::ImplementerSummary,
                ReviewContextItem::Diff,
            ]
        );
        assert_eq!(spec.stage_summary(), vec!["implement", "review", "fix"]);
    }

    #[test]
    fn builtins_are_valid() {
        for (id, text) in BUILTIN_WORKFLOWS {
            let (spec, warnings) = parse_workflow(id, text);
            let spec = spec.unwrap_or_else(|e| panic!("built-in `{id}` invalid: {e}"));
            assert!(
                warnings.is_empty(),
                "built-in `{id}` has warnings: {warnings:?}"
            );
            assert_eq!(spec.id, *id);
        }
    }

    #[test]
    fn bare_plan_key_enables_stage() {
        assert!(parse_ok("name: X\n").0.plan.is_none());
        assert_eq!(
            parse_ok("name: X\nplan:\n").0.plan,
            Some(StageConfig::default())
        );
        assert_eq!(
            parse_ok("name: X\nplan: {}\n").0.plan,
            Some(StageConfig::default())
        );
        let (spec, _) = parse_ok("name: X\nplan:\n  agent: codex\n");
        assert_eq!(spec.plan.unwrap().agent.as_deref(), Some("codex"));
    }

    #[test]
    fn full_workflow_parses() {
        let yaml = r#"
version: 1
name: Feature loop
description: Cross-review with two models.
plan:
  agent: claude
implement:
  agent: claude
  model: claude-fable-5
review:
  max_rounds: 3
  on_limit: finish
  reask: fresh
  context: [prompt, diff]
  reviewers:
    - agent: claude
      model: claude-opus-5
      focus: correctness
    - agent: codex
      prompt: "Review this: {{diff}} for round {{round}}/{{max_rounds}}"
fix:
  agent: claude
"#;
        let (spec, warnings) = parse_ok(yaml);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(spec.review.max_rounds, 3);
        assert_eq!(spec.review.on_limit, OnLimit::Finish);
        assert_eq!(spec.review.reask, ReaskMode::Fresh);
        assert_eq!(
            spec.review.context,
            vec![ReviewContextItem::Prompt, ReviewContextItem::Diff]
        );
        assert_eq!(spec.review.reviewers.len(), 2);
        assert_eq!(spec.review.reviewers[1].agent.as_deref(), Some("codex"));
        assert_eq!(
            spec.stage_summary(),
            vec!["plan", "implement", "review×2", "fix"]
        );
    }

    #[test]
    fn unknown_keys_warn_but_stay_valid() {
        let yaml = "name: X\nfuture_thing: 1\nreview:\n  gate: build\n  reviewers:\n    - agent: claude\n      voice: loud\n";
        let (spec, warnings) = parse_workflow("test", yaml);
        assert!(spec.is_ok());
        assert_eq!(
            warnings,
            vec![
                "unknown key `future_thing` in top level",
                "unknown key `gate` in review",
                "unknown key `voice` in review.reviewers[0]",
            ]
        );
    }

    #[test]
    fn validation_errors() {
        assert!(parse_err("services: {}\n").contains("`name` is required"));
        assert!(parse_err("name: X\nversion: 2\n").contains("unsupported workflow version 2"));
        assert!(parse_err("name: X\nreview:\n  max_rounds: 0\n").contains("at least 1"));
        assert!(parse_err("name: X\nreview:\n  on_limit: retry\n").contains("`ask` or `finish`"));
        assert!(
            parse_err("name: X\nreview:\n  reask: never\n").contains("`same_session` or `fresh`")
        );
        assert!(
            parse_err("name: X\nreview:\n  context: [prompt, everything]\n")
                .contains("unknown review.context item `everything`")
        );
        assert!(parse_err("name: X\nreview:\n  reviewers: []\n").contains("1..4 reviewers"));
        let five =
            "name: X\nreview:\n  reviewers:\n    - {}\n    - {}\n    - {}\n    - {}\n    - {}\n";
        assert!(parse_err(five).contains("1..4 reviewers"));
        assert!(parse_workflow("test", ": : :")
            .0
            .unwrap_err()
            .contains("invalid YAML"));
    }

    #[test]
    fn max_rounds_clamped_with_warning() {
        let (spec, warnings) = parse_ok("name: X\nreview:\n  max_rounds: 9\n");
        assert_eq!(spec.review.max_rounds, MAX_ROUNDS_CAP);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("clamped to 5"));
    }

    #[test]
    fn unknown_placeholder_is_an_error() {
        let err = parse_err("name: X\nimplement:\n  prompt: \"Do {{taks_prompt}}\"\n");
        assert!(
            err.contains("unknown placeholder {{taks_prompt}} in implement prompt"),
            "{err}"
        );
        // `{{diff}}` is a review/fix variable, not an implement one.
        let err = parse_err("name: X\nimplement:\n  prompt: \"See {{diff}}\"\n");
        assert!(err.contains("{{diff}}"), "{err}");
        // Reviewer prompts may use the review variable set, including {{focus}}.
        let yaml = "name: X\nreview:\n  reviewers:\n    - prompt: \"{{focus}}: check {{diff}}\"\n";
        assert!(parse_workflow("test", yaml).0.is_ok());
        // {{plan}} is rejected when the workflow has no planning stage — it
        // would render an empty section instead of a plan.
        let err = parse_err("name: X\nimplement:\n  prompt: \"Plan: {{plan}}\"\n");
        assert!(err.contains("{{plan}}"), "{err}");
        assert!(parse_workflow(
            "test",
            "name: X\nplan: {}\nimplement:\n  prompt: \"Plan: {{plan}}\"\n"
        )
        .0
        .is_ok());
    }

    #[test]
    fn inert_reviewer_knobs_warn() {
        // `context` and `focus` only shape the built-in reviewer prompt, so
        // setting them next to a custom prompt must not pass silently.
        let (spec, warnings) = parse_workflow(
            "test",
            "name: X\nreview:\n  context: [prompt]\n  reviewers:\n    - focus: security\n      prompt: \"check it\"\n",
        );
        assert!(spec.is_ok());
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("review.context is ignored")),
            "{warnings:?}"
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("focus is ignored") && w.contains("{{focus}}")),
            "{warnings:?}"
        );
        // A custom prompt that actually uses {{focus}} draws no warning.
        let (_, warnings) = parse_workflow(
            "test",
            "name: X\nreview:\n  reviewers:\n    - focus: security\n      prompt: \"{{focus}}\"\n",
        );
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn plan_false_disables_the_stage() {
        assert!(parse_ok("name: X\nplan: false\n").0.plan.is_none());
        assert!(parse_ok("name: X\nplan: true\n").0.plan.is_some());
    }

    #[test]
    fn placeholder_extraction_and_rendering() {
        assert_eq!(
            extract_placeholders("{{a}} and {{ b }} and {{a}} but not {{a b}} or {{}}"),
            vec!["a", "b"]
        );
        let vars = HashMap::from([
            ("task_prompt", "fix the bug".to_string()),
            ("round", "2".to_string()),
        ]);
        assert_eq!(
            render_template(
                "Task: {{task_prompt}} (round {{ round }}) {{unknown}}",
                &vars
            ),
            "Task: fix the bug (round 2) {{unknown}}"
        );
        assert_eq!(render_template("no placeholders", &vars), "no placeholders");
    }

    #[test]
    fn listing_project_overrides_builtin_and_reports_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let wf_dir = workflows_dir(dir.path());
        fs::create_dir_all(&wf_dir).unwrap();
        // Overrides the built-in of the same id.
        fs::write(wf_dir.join("review-loop.yaml"), "name: Mine\n").unwrap();
        // Invalid file still listed.
        fs::write(wf_dir.join("broken.yaml"), "name: [\n").unwrap();
        // Non-workflow files ignored.
        fs::write(wf_dir.join("notes.txt"), "hi").unwrap();

        let listed = list_workflows(dir.path());
        let ids: Vec<(&str, WorkflowSource, bool)> = listed
            .iter()
            .map(|w| (w.id.as_str(), w.source, w.spec.is_ok()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("broken", WorkflowSource::Project, false),
                ("review-loop", WorkflowSource::Project, true),
                ("plan-review-loop", WorkflowSource::Builtin, true),
            ]
        );
        let mine = load_workflow(dir.path(), "review-loop").unwrap();
        assert_eq!(mine.spec.unwrap().name, "Mine");
    }

    #[test]
    fn listing_without_workflows_dir_returns_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let listed = list_workflows(dir.path());
        assert_eq!(listed.len(), BUILTIN_WORKFLOWS.len());
        assert!(listed.iter().all(|w| w.source == WorkflowSource::Builtin));
    }

    #[test]
    fn duplicate_stems_warn_and_first_wins() {
        let dir = tempfile::tempdir().unwrap();
        let wf_dir = workflows_dir(dir.path());
        fs::create_dir_all(&wf_dir).unwrap();
        fs::write(wf_dir.join("loop.yaml"), "name: From yaml\n").unwrap();
        fs::write(wf_dir.join("loop.yml"), "name: From yml\n").unwrap();

        let listed = list_workflows(dir.path());
        let entry = listed.iter().find(|w| w.id == "loop").unwrap();
        assert_eq!(entry.spec.as_ref().unwrap().name, "From yaml");
        assert_eq!(
            entry.warnings,
            vec!["duplicate workflow file ignored: loop.yml"]
        );
    }

    #[test]
    fn eject_writes_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = eject_builtin(dir.path(), "review-loop").unwrap();
        assert!(path.ends_with(".warpforge/workflows/review-loop.yaml"));
        let text = fs::read_to_string(&path).unwrap();
        assert!(parse_workflow("review-loop", &text).0.is_ok());
        // Second eject refuses to overwrite.
        assert!(eject_builtin(dir.path(), "review-loop").is_err());
        assert!(eject_builtin(dir.path(), "nope").is_err());
    }
}
