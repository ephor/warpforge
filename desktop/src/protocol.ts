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
  | { event: "agents.setup_needed"; data: { detected: DetectedAgent[] } }
  | { event: "agents.updated"; data: { agents: AgentConfig[] } }
  | {
      event: "terminal.screen";
      data: { terminal_id: string; screen: TerminalScreen };
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
    };

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
  /** Persisted conversation history keyed by task id — loaded on subscribe. */
  sessionHistory?: Record<string, SessionUpdate[]>;
  /** Configured agents (empty until setup wizard is completed). */
  agents?: AgentConfig[];
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

export type TaskStatus =
  | "queued"
  | "running"
  | "idle"
  | "needs_review"
  | "done"
  | "blocked"
  | "interrupted";

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
  /** Session selectors (model/mode/…) reported by the live ACP session. */
  configOptions?: ConfigOption[];
  /** Path to the git worktree for this task, if isolated. */
  worktree?: string | null;
  /** Orchestration graph for parent orchestrator tasks. */
  orchestrationGraph?: OrchGraphInfo | null;
  /** Task that spawned this sub-agent through the orchestrator MCP. */
  parentTaskId?: string | null;
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

export type OrchNodeKind = "plan" | "implement" | "review" | "merge";

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

export type PromptAttachment =
  | { type: "file"; path: string }
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

export type SessionUpdate =
  | { kind: "user_message"; text: string; attachments?: PromptAttachmentSummary[] }
  | { kind: "prompt_capabilities"; image: boolean; embedded_context: boolean }
  | { kind: "agent_text"; text: string }
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
}

export interface ProjectFile {
  path: string;
  changed: boolean;
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
