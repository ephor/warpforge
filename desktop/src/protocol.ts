/**
 * TypeScript mirror of `crates/warpforge-protocol` (the daemon's wire types).
 * Keep the two in sync by hand for now; codegen (e.g. ts-rs) is a candidate
 * once the shape settles.
 */

// ── Envelope ────────────────────────────────────────────────────────────────

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: RpcError }
  | DaemonEvent;

export interface RpcError {
  code:
    | "invalid_request"
    | "not_found"
    | "conflict"
    | "agent_unavailable"
    | "internal"
    | "updating";
  message: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type DaemonEvent =
  | { event: "state.snapshot"; data: Snapshot }
  | { event: "project.added"; data: ProjectInfo }
  | { event: "project.removed"; data: { name: string } }
  | { event: "project.configChanged"; data: ProjectConfigState }
  | {
      event: "service.status";
      data: {
        project: string;
        service: string;
        status: ServiceStatus;
        allocated_port: number;
      };
    }
  | {
      event: "service.log";
      data: { project: string; service: string; seq: number; line: string };
    }
  | {
      event: "portforward.status";
      data: { project: string; name: string; status: PortForwardStatus };
    }
  | {
      event: "portforward.log";
      data: { project: string; name: string; seq: number; line: string };
    }
  | { event: "task.created"; data: TaskInfo }
  | { event: "task.updated"; data: TaskInfo }
  | { event: "task.removed"; data: { id: string } }
  | { event: "session.update"; data: { task_id: string; update: SessionUpdate } }
  | { event: "history.pruned"; data: { updates: number } }
  | {
      event: "history.swept";
      data: { settled: number; expired: number; kept: number };
    }
  | { event: "agents.setup_needed"; data: { detected: DetectedAgent[] } }
  | { event: "agents.updated"; data: { agents: AgentConfig[] } }
  | { event: "accounts.updated"; data: { accounts: AccountInfo[] } }
  | { event: "agentLimits.updated"; data: { accounts: AgentAccountLimits[] } }
  | {
      event: "terminal.screen";
      data: { terminal_id: string; screen: TerminalScreen };
    }
  | { event: "terminal.spawned"; data: TerminalInfo }
  | {
      event: "terminal.data";
      data: { terminal_id: string; data_b64: string };
    }
  | { event: "terminal.exited"; data: { terminal_id: string; code: number } }
  // ── Orchestration ──
  | {
      event: "orchestration.nodeDispatched";
      data: {
        graph_id: string;
        node_id: string;
        task_id: string;
        agent: string;
        kind: string;
      };
    }
  | {
      event: "orchestration.nodeCompleted";
      data: { graph_id: string; node_id: string; task_id: string };
    }
  | {
      event: "orchestration.nodeFailed";
      data: {
        graph_id: string;
        node_id: string;
        task_id: string;
        reason: string;
      };
    }
  | {
      event: "orchestration.allComplete";
      data: { graph_id: string; project: string };
    }
  // ── LSP ──
  | { event: "lsp.message"; data: { server_id: string; payload: unknown } }
  | { event: "lsp.exit"; data: { server_id: string; code: number | null } };

export interface LspStartResult {
  serverId: string;
  available: boolean;
  rootPath: string;
}

/** Install state of one editor language's language server (mirrors Rust). */
export interface DetectedLanguageServer {
  id: string;
  language: string;
  installed: boolean;
  version?: string | null;
  latestVersion?: string | null;
  /** "current" | "behind" | "missing" | "unknown" */
  status: string;
  installCommand?: string | null;
  updateCommand?: string | null;
  canManage: boolean;
  installHint: string;
}

export function isEvent(msg: ServerMessage): msg is DaemonEvent {
  return "event" in msg;
}

// ── State DTOs ──────────────────────────────────────────────────────────────

export interface Snapshot {
  projects: ProjectInfo[];
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
  tasks: TaskInfo[];
  terminals: TerminalInfo[];
  /** Persisted conversation history keyed by task id — loaded whole on
   *  subscribe, because a transcript that arrives in two pieces cannot hold
   *  its scroll (docs/adr/0005). */
  sessionHistory?: Record<string, SessionUpdate[]>;
  /** Configured agents (empty until setup wizard is completed). */
  agents?: AgentConfig[];
  /** Registered agent accounts (empty until the user adds one). */
  accounts?: AccountInfo[];
}

/** How long finished tasks keep their data, per lifecycle stage (mirrors Rust). */
export interface HistorySettings {
  /** Days before a closed task's conversation is deleted. */
  retentionDays: number;
  /** Days before an ignored diff-less waiting task is settled. 0 = off. */
  settleIgnoredAfterDays: number;
  /** Days before an untouched closed task is deleted outright. 0 = off. */
  deleteClosedAfterDays: number;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  portforwards: [],
  projects: [],
  services: [],
  tasks: [],
  terminals: [],
};

export interface ProjectInfo {
  name: string;
  path: string;
  portRange: [number, number];
  declaredServices: string[];
  agentTemplates: Record<string, string>;
}

export interface ProjectConfigState {
  project: ProjectInfo;
  services: ServiceInfo[];
  portforwards: PortForwardInfo[];
}

export type ServiceStatus = "starting" | "running" | "stopped" | "failed";

export interface ServiceInfo {
  project: string;
  name: string;
  command: string;
  status: ServiceStatus;
  originalPort: number;
  allocatedPort: number;
  logSeq: number;
}

export type PortForwardStatus = "starting" | "active" | "restarting" | "failed" | "stopped";

export interface PortForwardInfo {
  project: string;
  name: string;
  namespace: string;
  pod: string;
  localPort: number;
  remotePort: number;
  status: PortForwardStatus;
  logSeq: number;
}

/**
 * Mirrors the Rust `TaskStatus`. `waiting` is one state, not the old
 * `idle` / `needs_review` pair: both meant "the agent yielded its turn", and
 * whether there is a diff to look at is `TaskInfo.filesChanged`, not a status.
 * The daemon still *reads* the legacy spellings off disk, but never emits them.
 */
export type TaskStatus = "queued" | "running" | "waiting" | "blocked" | "interrupted" | "done";

export interface TaskInfo {
  id: string;
  project: string;
  prompt: string;
  agent: string;
  status: TaskStatus;
  tags: string[];
  /** Short imperative label derived from the prompt, or set explicitly. Empty until generated. */
  title: string;
  createdAt: number;
  updatedAt: number;
  filesChanged: number;
  blockedReason: string | null;
  /** The model the user explicitly asked for on this task, if they ever did. */
  model?: string | null;
  /**
   * Why the task is blocked, when the daemon could classify it. `session_lost`
   * means the agent no longer has the saved session and never will — the stored
   * conversation is intact, so the work continues in a fresh session.
   * `model_mismatch` means the session is alive but running on a model other
   * than the requested one; the status is deliberately left unchanged.
   */
  blockedKind?: "session_lost" | "model_mismatch" | null;
  /** Session selectors (model/mode/…) reported by the live ACP session. */
  configOptions?: ConfigOption[];
  /** Path to the git worktree for this task, if isolated. */
  worktree?: string | null;
  /** Orchestration graph for parent orchestrator tasks, and for workflow parents. */
  orchestrationGraph?: OrchGraphInfo | null;
  /** Live pipeline state when this task is a workflow parent. */
  workflowRun?: WorkflowRunInfo | null;
  /** Task that spawned this sub-agent through the orchestrator MCP. */
  parentTaskId?: string | null;
  /** Explicit settle override (true = settled, false = not settled). */
  settledOverride?: boolean | null;
  /** Unix seconds when the task was last settled. */
  settledAt?: number | null;
  /** Unix seconds until which the task is snoozed. */
  snoozedUntil?: number | null;
  /** Unix seconds when the current snooze was set. */
  snoozedAt?: number | null;
}

export interface ConfigChoice {
  value: string;
  name: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  /** "mode" | "model" | "model_config" | "thought_level" | … */
  category?: string | null;
  currentValue: string;
  options: ConfigChoice[];
}

// ── Orchestration DTOs ─────────────────────────────────────────────────────

export interface OrchGraphInfo {
  id: string;
  goal: string;
  nodes: OrchNodeInfo[];
}

export interface OrchNodeInfo {
  id: string;
  kind: OrchNodeKind;
  agent: string;
  status: OrchNodeStatus;
  taskId?: string | null;
  result?: string | null;
}

export type OrchNodeKind = "plan" | "implement" | "review" | "fix" | "merge";

export type OrchNodeStatus = "pending" | "running" | "complete" | "failed" | "skipped";

export interface OrchestratorConfig {
  plannerAgent: string;
  workerPool: OrchWorkerPool[];
  reviewerPool: OrchReviewerPool[];
  worktreesEnabled: boolean;
}

export interface OrchWorkerPool {
  agent: string;
}

export interface OrchReviewerPool {
  agent: string;
}

// ── Workflow DTOs ──────────────────────────────────────────────────────────

/** One selectable workflow template, from `workflow.list`. */
export interface WorkflowMeta {
  id: string;
  name: string;
  description?: string | null;
  source: WorkflowSource;
  /** False when the YAML failed to parse or validate — listed but unselectable. */
  valid: boolean;
  error?: string | null;
  /** Non-fatal issues (unknown keys, clamped values). */
  warnings?: string[];
  /** Stage names for the picker tooltip, e.g. ["plan","implement","review\u00d72","fix"]. */
  stages?: string[];
  maxRounds?: number;
}

export type WorkflowSource = "project" | "builtin";

/** Live state of a workflow pipeline, carried on its parent task. */
export interface WorkflowRunInfo {
  workflowId: string;
  workflowName: string;
  stage: WorkflowStage;
  /** Current review round, 1-based; 0 until the first review starts. */
  round: number;
  /** Round limit including any user-granted extensions. */
  maxRounds: number;
  verdict?: WorkflowVerdict | null;
  /** Set while the pipeline waits for the user. */
  waiting?: WorkflowWaiting | null;
  /** A pause is queued and takes effect when the running stage finishes. */
  pauseRequested?: boolean;
}

export type WorkflowStage = "plan" | "implement" | "review" | "fix" | "done" | "failed";

export type WorkflowVerdict = "approve" | "request_changes";

export interface WorkflowWaiting {
  kind: WorkflowWaitKind;
  /** Which stage asked (for `question`). */
  stage?: WorkflowStage | null;
  /** The question text, or a findings summary for `limit`. */
  question?: string | null;
}

export type WorkflowWaitKind = "question" | "limit" | "paused";

export type WorkflowDecision = "extend" | "finish" | "stop";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PlanEntry {
  content: string;
  status: string; // "pending" | "in_progress" | "completed"
  priority?: string;
}

export interface CommandInfo {
  name: string;
  description: string;
}

export interface FileRange {
  start: number;
  end: number;
}

export type PromptAttachment =
  | { type: "file"; path: string; range?: FileRange }
  | { type: "image"; name: string; mimeType: "image/png" | "image/jpeg"; data: string };

export interface PromptSubmission {
  text: string;
  attachments: PromptAttachment[];
}

export type PromptAttachmentSummary =
  | { type: "file"; path: string }
  | { type: "image"; name: string };

export interface SessionUsageCost {
  amount: number;
  currency: string;
}

export interface WorkflowEventAgent {
  taskId: string;
  label: string;
  agent: string;
  model?: string | null;
}

export type WorkflowEventKind =
  | "workflow_started"
  | "stage_started"
  | "agent_output"
  | "review_result"
  | "status"
  | "workflow_finished";

export type WorkflowEventTone = "info" | "running" | "success" | "warning" | "error";

export type SessionUpdate =
  | { kind: "user_message"; text: string; attachments?: PromptAttachmentSummary[] }
  | { kind: "prompt_capabilities"; image: boolean; embedded_context: boolean }
  | { kind: "agent_text"; text: string }
  | {
      kind: "workflow_event";
      event: WorkflowEventKind;
      title: string;
      detail?: string | null;
      stage?: WorkflowStage | null;
      agents: WorkflowEventAgent[];
      tone: WorkflowEventTone;
    }
  | { kind: "agent_thought"; text: string }
  | {
      kind: "tool_call";
      tool_call_id: string;
      title: string;
      status: ToolCallStatus;
      tool_kind: string;
      content?: string;
      /** Daemon-preserved start of this tool call, in Unix milliseconds. */
      started_at?: number;
    }
  | {
      kind: "file_edit";
      path: string;
      /** Present on new histories; lets repeated ACP lifecycle frames coalesce. */
      tool_call_id?: string;
      additions?: number;
      deletions?: number;
      /** Concrete per-operation hunks when the ACP agent supplied old/new text. */
      hunks?: EditHunk[];
    }
  | {
      kind: "permission_request";
      request_id: string;
      title: string;
      options: string[];
    }
  | { kind: "permission_resolved"; request_id: string; outcome: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "available_commands"; commands: CommandInfo[] }
  | { kind: "usage"; used: number; size: number; cost?: SessionUsageCost }
  | { kind: "turn_ended"; stop_reason: string };

// ── Diff ────────────────────────────────────────────────────────────────────

export type HunkResolution = "accept" | "reject";

export interface EditHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Changed lines only, prefixed with "+" or "-". */
  lines: string[];
}

export interface TaskDiff {
  taskId: string;
  files: FileDiff[];
  /** Current git branch of the task's project, if it's a repo. */
  branch?: string | null;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: Hunk[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  resolution: HunkResolution | null;
}

/** Result of `file.contents` — a file's HEAD + working-tree text. */
export interface FileDoc {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldText: string;
  newText: string;
  /** Base64-encoded binary content for images (PNG, JPG, etc). Undefined for text files. */
  newDataBase64?: string;
  oldDataBase64?: string;
}

export interface ProjectFile {
  path: string;
  changed: boolean;
}

/** One line-level match from `file.search` — path plus 1-based line/column. */
export interface SymbolMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

// ── Git ops (update / branch switch) ────────────────────────────────────────

export type GitOpStatus = "up_to_date" | "ok" | "conflict" | "error";

/** Result of `git.update` / `git.switchBranch`. */
export interface GitOpResult {
  status: GitOpStatus;
  message: string;
  /** Files that blocked the op (on `conflict`); empty otherwise. */
  conflicts: string[];
  /** Current branch after the op. */
  branch?: string | null;
}

/** Result of `git.branches`. */
export interface GitBranchList {
  current?: string | null;
  branches: string[];
  /** Remote-tracking refs, e.g. `origin/main`. */
  remotes?: string[];
}

export interface GitPushFile {
  path: string;
  status: string;
}

export interface GitPushCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  files: GitPushFile[];
}

/** Outgoing commits and their files for the current branch. */
export interface GitPushInfo {
  branch: string;
  remote: string;
  remoteBranch: string;
  upstream: string;
  hasUpstream: boolean;
  commits: GitPushCommit[];
}

// ── Terminals ───────────────────────────────────────────────────────────────

export interface TerminalInfo {
  id: string;
  project: string;
  command: string;
  startedAt: number;
  cols: number;
  rows: number;
}

export interface TerminalScreen {
  cols: number;
  rows: number;
  cursor: [number, number];
  rowsContent: StyledSpan[][];
}

export interface StyledSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  inverse?: boolean;
}

// ── Agent registry ──────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  displayName: string;
  acpCommand: string;
  enabled: boolean;
  /** Cached model/effort selectors from the agent's last ACP probe. */
  models: ConfigOption[];
  /** Last model the user explicitly picked; used as default for new tasks. */
  lastModel?: string;
}

export interface DetectedAgent {
  id: string;
  displayName: string;
  installed: boolean;
  defaultAcpCommand: string;
  installHint: string;
  version?: string;
  latestVersion?: string;
  /** "current" | "behind" | "missing" | "unknown" */
  status: string;
  installCommand?: string;
  updateCommand?: string;
  canManage: boolean;
}

/**
 * One registered login for an agent. Never carries credentials — the daemon
 * keeps those in its vault and only reports what the switcher shows.
 */
export interface AccountInfo {
  /** Stable id, "<agent>:<slug>". */
  id: string;
  agentId: string;
  label: string;
  email?: string;
  /** Plan or seat tier, when the agent reports one. */
  plan?: string;
  /** Whether new sessions for this agent use this account. */
  active: boolean;
}

// ── Agent rate limits ───────────────────────────────────────────────────────

/** One usage window (session, weekly, …) on an agent account. */
export interface AgentLimitWindow {
  /** "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "primary" | "secondary"
   *  — plus the synthetic "rate_limited" (usedPercent 100, resetsAt from the
   *  server's Retry-After) when the harness has hard-stopped the account. */
  id: string;
  /** Human label, e.g. "Session" | "Weekly" | "Weekly (Opus)". */
  label: string;
  /** 0..100 */
  usedPercent: number;
  /** Unix SECONDS when the window resets. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** Rate-limit state for one registered agent account. */
export interface AgentAccountLimits {
  /** "<agent>:<slug>", e.g. "claude:personal" */
  accountId: string;
  /** "claude" | "codex" | "opencode" */
  agentId: string;
  label: string;
  /** Currently-active account for that agent. */
  active: boolean;
  /** "plus", "max20", … */
  plan?: string;
  windows: AgentLimitWindow[];
  /** Any window is at 100%. */
  exhausted: boolean;
  /** Unix SECONDS when this snapshot was taken. */
  fetchedAt: number;
  /** "api" | "local" | "unknown" */
  source: string;
  /** Per-account failure, e.g. "not logged in". */
  error?: string;
}

/** Response of the `listAgentLimits` RPC. */
export interface ListAgentLimitsResult {
  accounts: AgentAccountLimits[];
}

/**
 * API-equivalent spend for one harness: what the usage *would* cost at API
 * rates, never an amount charged to the user. A Max/Plus/Team subscription is
 * billed nothing of the sort. Reported per harness, not per account — the cost
 * stream carries no account id.
 */
export interface AgentSpend {
  /** "claude" | "codex" | "opencode" */
  agentId: string;
  /** Accrued in the last 24h; null when unknown. */
  todayUsd: number | null;
  /** All-time total we can account for; null when unknown. */
  totalUsd: number | null;
  /** Tasks that contributed spend. */
  tasks: number;
  /** False when this harness never reports cost at all. */
  reported: boolean;
}

/** Response of the `listAgentSpend` RPC. */
export interface ListAgentSpendResult {
  agents: AgentSpend[];
}

/** An agent session discovered on disk (claude/codex), resumable via task.resume. */
export interface ExternalSession {
  agent: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** A git worktree for an isolated task. */
export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  baseBranch: string;
}

// ── Daemon discovery (~/.warpforge/daemon.json) ─────────────────────────────

export interface DaemonEndpoint {
  pid: number;
  url: string;
  token: string;
  version: string;
  protocolVersion: number;
  owner: "desktop" | "external";
}

export interface DaemonHandshake {
  daemonVersion: string;
  protocolVersion: number;
  owner: "desktop" | "external";
  protocolCompatible: boolean;
  exactVersionMatch: boolean;
}

export interface UpdateHandoff {
  ready: boolean;
  blockers: string[];
}
// ── Issue trackers (GitHub / Linear) ────────────────────────────────────────

export interface TrackerLinearStatus {
  connected: boolean;
  email?: string | null;
  organization?: string | null;
}

export interface TrackerGithubStatus {
  connected: boolean;
  login?: string | null;
  warning?: string | null;
}

export interface TrackerStatus {
  linear?: TrackerLinearStatus | null;
  github?: TrackerGithubStatus | null;
}

/** A Linear team the connected API key can see. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** Which external-tracker slice a project reads (the Linear team mapping). */
export interface TrackerProjectSettings {
  project: string;
  linearTeamId?: string | null;
  linearTeamName?: string | null;
}

/** Per-project tracker availability — what source filters and pickers key on.
 *  Local is always true; Linear needs a connected key plus a mapped team;
 *  GitHub needs a `gh` session whose repo resolves from the project dir. */
export interface ProjectSources {
  project: string;
  local: boolean;
  linear: boolean;
  github: boolean;
}

/** One persisted backlog-item ↔ external-issue link. */
export interface TrackerLinkInfo {
  itemId: string;
  provider: "github" | "linear";
  externalId: string;
  url: string;
  status: string;
  remoteStatus?: string | null;
  assignee?: string | null;
  lastSyncedAt: number;
  taskId?: string | null;
}

export interface CreateExternalResult {
  itemId: string;
  provider: "github" | "linear";
  externalId: string;
  url: string;
  status: string;
}

export interface SyncedExternalItem {
  id: string;
  url: string;
  status: string;
  remoteStatus?: string | null;
}

/** An issue that existed in a tracker before warpforge knew about it. */
export interface ImportedWorkItem {
  itemId: string;
  number?: number;
  provider: "github" | "linear";
  project: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
  status: string;
  remoteStatus?: string | null;
  /** Remote's last-updated time, unix seconds. */
  updatedAt: number;
}

export interface ExternalWorkItemPage {
  items: ImportedWorkItem[];
  page: number;
  pageSize: number;
  total?: number | null;
  hasNextPage: boolean;
}

export type BacklogStorageMode = "sqlite" | "yaml";

export interface BacklogSettings {
  mode: BacklogStorageMode;
}

export interface BacklogItem {
  id: string;
  number: number;
  project: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  source: "local" | "github" | "linear" | string;
  externalId?: string | null;
  url?: string | null;
  remoteStatus?: string | null;
  assignee?: string | null;
  createdAt: number;
  updatedAt: number;
  taskId?: string | null;
}

export interface BacklogPage {
  items: BacklogItem[];
  page: number;
  pageSize: number;
  total: number;
  hasNextPage: boolean;
}

export interface MemoryStats {
  globalCount: number;
  projectCount: number;
  embeddingMode: "hybrid" | "fts";
  scopesEnabled: {
    global: boolean;
    project: boolean;
  };
  perProjectDbExists: boolean;
  embeddingUnavailable?: string | null;
}
