# Meta-Harness Implementation Plan

## Executive Summary

Warpforge has ~60% of the meta-harness infrastructure already built. The remaining work adds:
1. **Git worktree isolation** — parallel task branches (Omnigent `fanout` pattern)
2. **Multi-agent orchestration** — Planner→Worker→Reviewer pipeline (Omnigent `polly` pattern)
3. **Policy engine** — ALLOW/ASK/DENY gate on agent actions (Omnigent `policies` pattern)
4. **ACP server endpoint** — warpforge exposes ACP for external agents (reverse of existing ACP client)

---

## Phase 1: Git Worktree Isolation

**Omnigent pattern:** `examples/polly/skills/fanout/SKILL.md`
- Worker creates `.worktrees/<task_id>`, runs there, opens PR from worktree

**What exists:** `src/daemon/diff.rs` — git operations on single working tree per project

**What to build:**

### 1.1 WorktreeManager (`src/daemon/worktree.rs`)
```rust
pub struct WorktreeManager {
    base_repo: PathBuf,
    worktrees: HashMap<String, Worktree>,  // task_id → worktree
}

pub struct Worktree {
    pub task_id: String,
    pub path: PathBuf,           // .worktrees/<task_id>
    pub branch: String,          // warpforge/task/<task_id>
    pub base_branch: String,     // branch created from
}

impl WorktreeManager {
    pub async fn create(&self, task_id: &str, base_branch: Option<&str>) -> Result<Worktree>;
    pub async fn remove(&self, task_id: &str) -> Result<()>;
    pub fn path(&self, task_id: &str) -> Option<&Path>;
    pub async fn list(&self) -> Vec<WorktreeInfo>;
}
```

**Key operations:**
- `git worktree add .worktrees/<task_id> -b warpforge/task/<task_id> [<base>]`
- `git worktree remove .worktrees/<task_id>`
- Task's agent spawns with `cwd = worktree.path` instead of project root

### 1.2 Integration points
- `Daemon::start_session()` — resolve task's worktree path, pass as `cwd` to `spawn_acp_session()`
- `Command::CreateTask` — optional `worktree: bool` flag to auto-create worktree
- `Command::MergeWorktree` — merge worktree branch back to base, clean up

**Files to modify:**
- `src/daemon/actor.rs` — add `worktrees: WorktreeManager` field, handle new commands
- `src/daemon/acp.rs` — no changes (already accepts `cwd` param)

---

## Phase 2: Multi-Agent Orchestration

**Omnigent pattern:** `examples/polly/config.yaml` — planner decides when to fanout, which sub-agents to use

**What exists:**
- `src/daemon/agents.rs` — 5 known agents (claude, codex, opencode, qwen, goose)
- `src/daemon/acp.rs` — can spawn any ACP-capable agent
- `src/daemon/sessions.rs` — session discovery/resume

**What to build:**

### 2.1 Orchestrator Config (`src/orchestration/config.rs`)
```rust
pub struct OrchestratorConfig {
    pub planner_agent: String,           // e.g. "claude"
    pub workers: Vec<WorkerConfig>,      // available sub-agents
    pub reviewers: Vec<ReviewerConfig>,  // cross-vendor reviewers
    pub policies: Vec<PolicyConfig>,     // enabled policies
}

pub struct WorkerConfig {
    pub agent: String,                   // "claude", "codex", "opencode"
    pub purpose: String,                 // "implement", "test", "refactor"
    pub permission_mode: PermissionMode, // Auto, Headless, Ask
    pub worktree: bool,                  // isolate in worktree?
}

pub struct ReviewerConfig {
    pub agent: String,                   // must differ from worker
    pub review_scope: ReviewScope,       // Diff, Full, Targeted
}
```

### 2.2 Task Graph (`src/orchestration/graph.rs`)
```rust
pub struct TaskGraph {
    pub root: TaskNode,
    pub nodes: HashMap<String, TaskNode>,
}

pub struct TaskNode {
    pub id: String,
    pub kind: NodeKind,      // Plan, Implement, Review, Merge
    pub agent: String,
    pub status: NodeStatus,
    pub depends_on: Vec<String>,
    pub worktree: Option<String>,
}

pub enum NodeKind {
    Plan,
    Implement { spec: String },
    Review { diff_ref: String },
    Merge,
}

impl TaskGraph {
    pub fn from_planner_output(output: &str) -> Result<Self>;
    pub fn ready_nodes(&self) -> Vec<&TaskNode>;
    pub fn mark_complete(&mut self, id: &str);
    pub fn all_complete(&self) -> bool;
}
```

### 2.3 Orchestrator Actor (`src/orchestration/mod.rs`)
```rust
pub struct Orchestrator {
    config: OrchestratorConfig,
    graphs: HashMap<String, TaskGraph>,  // project → graph
    daemon_handle: DaemonHandle,
}

pub enum OrchestratorCommand {
    StartPlan { project: String, goal: String },
    WorkerComplete { task_id: String, result: WorkerResult },
    ReviewerComplete { task_id: String, review: ReviewResult },
    Cancel { project: String },
}

pub enum OrchestratorEvent {
    PlanCreated { project: String, graph: TaskGraph },
    WorkerDispatched { task_id: String, agent: String, worktree: String },
    ReviewRequested { task_id: String, reviewer: String },
    ReadyToMerge { project: String },
    Error { task_id: String, error: String },
}
```

**Flow:**
1. User submits goal → `StartPlan`
2. Orchestrator spawns planner agent (Claude) with goal
3. Planner returns structured plan (JSON in agent text)
4. Orchestrator parses plan into `TaskGraph`
5. For each ready node: spawn worker in worktree
6. Worker completes → notify orchestrator
7. When implement nodes done → dispatch reviewers
8. Reviews pass → merge worktrees back
9. All merged → `ReadyToMerge` event

---

## Phase 3: Policy Engine

**Omnigent pattern:** `omnigent/policies/` — `Policy.evaluate()` → `PolicyResult(ALLOW/ASK/DENY)`

**What exists:**
- `src/daemon/acp.rs:262-276` — `fs/read_text_file` and `fs/write_text_file` handled directly (no policy gate)
- `src/daemon/acp.rs:240-260` — permission requests surfaced to UI (manual answer)

**What to build:**

### 3.1 Policy Trait (`src/policies/mod.rs`)
```rust
use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq)]
pub enum PolicyAction {
    Allow,
    Ask { reason: String, options: Vec<String> },
    Deny { reason: String },
}

#[derive(Debug, Clone)]
pub struct PolicyContext {
    pub phase: Phase,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub agent: String,
    pub task_id: String,
    pub cwd: PathBuf,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    ToolCall,
    AgentPrompt,
    Spawn,
}

#[async_trait]
pub trait Policy: Send + Sync {
    fn name(&self) -> &str;
    async fn evaluate(&self, ctx: &PolicyContext) -> PolicyResult;
    fn reset_turn(&mut self) {}  // per-turn state
}

#[derive(Debug, Clone)]
pub struct PolicyResult {
    pub action: PolicyAction,
    pub reason: Option<String>,
    pub set_labels: HashMap<String, String>,
}
```

### 3.2 Built-in Policies (`src/policies/builtins/`)

**BlastRadius** (from Omnigent `orchestration.py`):
```rust
pub struct BlastRadiusPolicy {
    deny_patterns: Vec<String>,   // ["rm -rf *", "force push"]
    ask_patterns: Vec<String>,    // ["git push", "git merge", "npm publish"]
    gate_pushes: bool,
}
```

**CostBudget** (from Omnigent `cost.py`):
```rust
pub struct CostBudgetPolicy {
    max_cost_usd: f64,
    ask_threshold_usd: f64,
    current_cost: Arc<AtomicU64>,  // microUSD counter
}
```

**SpawnBounds** (from Omnigent `orchestration.py`):
```rust
pub struct SpawnBoundsPolicy {
    max_spawns_per_turn: usize,
    current_count: usize,
}
```

**WorktreeGuard** (from Omnigent `orchestration.py`):
```rust
pub struct WorktreeGuardPolicy {
    allowed_worktree: PathBuf,
}
```

### 3.3 Policy Registry (`src/policies/registry.rs`)
```rust
pub struct PolicyRegistry {
    policies: Vec<Box<dyn Policy>>,
}

impl PolicyRegistry {
    pub fn from_config(config: &[PolicyConfig]) -> Self;
    pub async fn evaluate_all(&self, ctx: &PolicyContext) -> PolicyResult;
    // Returns first DENY, then first ASK, then ALLOW
}
```

### 3.4 Integration with ACP
Modify `src/daemon/acp.rs` to gate agent requests through policies:

```rust
// In the ACP reader task, before handling fs/write_text_file:
let policy_ctx = PolicyContext {
    phase: Phase::ToolCall,
    tool_name: Some("fs/write_text_file".into()),
    tool_input: Some(json!({"path": path, "content": content})),
    agent: agent_name.clone(),
    task_id: task_id.clone(),
    cwd: PathBuf::from(&cwd),
    labels: session_labels.clone(),
};

match policy_registry.evaluate_all(&policy_ctx).await.action {
    PolicyAction::Allow => { /* proceed */ }
    PolicyAction::Ask { reason, options } => { /* surface to UI */ }
    PolicyAction::Deny { reason } => { /* reject, reply error */ }
}
```

**Files to create:**
- `src/policies/mod.rs`
- `src/policies/builtins/blast_radius.rs`
- `src/policies/builtins/cost.rs`
- `src/policies/builtins/spawn_bounds.rs`
- `src/policies/builtins/worktree_guard.rs`
- `src/policies/registry.rs`

**Files to modify:**
- `src/daemon/acp.rs` — add policy gate before file ops and spawns
- `src/daemon/actor.rs` — add `policy_registry: Arc<PolicyRegistry>` to Daemon

---

## Phase 4: ACP Server Endpoint

**What exists:** `src/daemon/acp.rs` — warpforge speaks ACP as **client** to agents

**What to build:** warpforge exposes ACP as **server** so external orchestrators can drive it

### 4.1 ACP Server (`src/daemon/acp_server.rs`)
```rust
pub struct AcpServer {
    listener: TcpListener,
    daemon_handle: DaemonHandle,
}

impl AcpServer {
    pub async fn run(self) -> Result<()>;
    // Handles: initialize, session/new, session/prompt, session/update
}
```

This lets Claude Desktop or other ACP hosts drive warpforge tasks remotely.

**Priority:** Low — defer until Phase 1-3 proven.

---

## Phase 5: UI Integration

**What exists:** `desktop/` — full Tauri v2 frontend with agent tabs, task management, diff viewer

**What to add:**

### 5.1 Orchestrator View
- TaskGraph visualization (nodes = circles, edges = arrows)
- Real-time status per node (pending/running/complete/failed)
- Merge button when all reviews pass

### 5.2 Policy Notifications
- ASK results surface as permission dialogs in the UI
- DENY results shown as blocked actions with reason
- Cost/spawn counters visible in status bar

**Files to modify:**
- `desktop/src/components/` — add `OrchestratorView.tsx`, `PolicyNotification.tsx`
- `src/daemon/wire.rs` — add wire types for orchestrator events

---

## Implementation Order

| Phase | Effort | Dependencies | Deliverable |
|-------|--------|--------------|-------------|
| 1. Worktrees | 2-3 days | None | Parallel task branches |
| 3. Policies | 3-4 days | None | ALLOW/ASK/DENY gate |
| 2. Orchestrator | 5-7 days | Phase 1, 3 | Planner→Worker→Reviewer |
| 4. ACP Server | 2-3 days | None | External orchestrator support |
| 5. UI | 3-4 days | Phase 2 | Visual orchestration |

**Total: 15-21 days**

---

## Key Design Decisions

1. **Rust async, not tmux** — Omnigent uses tmux sessions; warpforge uses tokio tasks + ACP. More structured, typed, testable.

2. **Policies as trait objects** — Omnigent uses Python ABC; warpforge uses `Box<dyn Policy>`. Same pattern, Rust idioms.

3. **Worktrees over branches** — Each worker gets a real filesystem isolation, not just a git branch switch. Enables parallel writes.

4. **ACP for everything** — All agent communication via ACP protocol. No special-casing per agent vendor.

5. **Task graph, not prompts** — Omnigent's planner returns text parsed into actions; warpforge returns structured JSON parsed into `TaskGraph`. More reliable.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| ACP agent doesn't return structured plan | Fallback: parse markdown plan with regex |
| Worktree merge conflicts | Auto-retry with rebase; surface conflict to user |
| Policy evaluation latency | Cache results per turn; async evaluation |
| Cross-vendor review quality | Start with same-vendor, add cross-vendor later |
