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
    | "internal";
  message: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type DaemonEvent =
  | { event: "state.snapshot"; data: Snapshot }
  | { event: "project.added"; data: ProjectInfo }
  | { event: "project.removed"; data: { name: string } }
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
  | { event: "terminal.exited"; data: { terminal_id: string; code: number } };

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
  projects: [],
  services: [],
  portforwards: [],
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

export type PortForwardStatus =
  | "starting"
  | "active"
  | "restarting"
  | "failed"
  | "stopped";

export interface PortForwardInfo {
  project: string;
  name: string;
  namespace: string;
  pod: string;
  localPort: number;
  remotePort: number;
  status: PortForwardStatus;
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
  createdAt: number;
  updatedAt: number;
  filesChanged: number;
  blockedReason: string | null;
  /** Session selectors (model/mode/…) reported by the live ACP session. */
  configOptions?: ConfigOption[];
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

export type SessionUpdate =
  | { kind: "user_message"; text: string }
  | { kind: "agent_text"; text: string }
  | { kind: "agent_thought"; text: string }
  | {
      kind: "tool_call";
      tool_call_id: string;
      title: string;
      status: ToolCallStatus;
      tool_kind: string;
      content?: string;
    }
  | { kind: "file_edit"; path: string }
  | {
      kind: "permission_request";
      request_id: string;
      title: string;
      options: string[];
    }
  | { kind: "permission_resolved"; request_id: string; outcome: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "available_commands"; commands: CommandInfo[] }
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

export type GitOpStatus = "upToDate" | "ok" | "conflict" | "error";

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
}

export interface DetectedAgent {
  id: string;
  displayName: string;
  installed: boolean;
  defaultAcpCommand: string;
  installHint: string;
}

/** An agent session discovered on disk (claude/codex), resumable via task.resume. */
export interface ExternalSession {
  agent: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

// ── Daemon discovery (~/.warpforge/daemon.json) ─────────────────────────────

export interface DaemonEndpoint {
  pid: number;
  url: string;
  token: string;
  version: string;
}
