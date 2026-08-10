import type { OrchNodeStatus, TaskStatus } from "@/protocol";

/**
 * How a status is drawn. Two *independent* vocabularies live here, and they are
 * deliberately not one union:
 *
 * - `TASK_STATUS_META` — where a task is in its lifecycle.
 * - `ORCH_NODE_META` — where a node is in an orchestration graph.
 *
 * They never co-occur on the same value. Merging them into one `Record` is what
 * made the old map read as arbitrary: `failed` existed here but not in the Rust
 * `TaskStatus`, and `done` and `complete` were two spellings of the same cell.
 */

type Tone = "ok" | "warn" | "destructive" | "neutral";
type Glyph = "dot" | "ring" | "clock" | "check" | "minus";

export interface StatusVisual {
  label: string;
  tone: Tone;
  glyph: Glyph;
  pulse?: boolean;
  glyphAccent?: string;
}

/**
 * A task's lifecycle — the same six states the daemon reports.
 *
 * `waiting` is a *resting* state: the agent yielded its turn and the next move
 * is the user's. Whether that task also has a diff worth opening is
 * `filesChanged > 0`, a field on the task — not a seventh status. Keeping it
 * quiet here is the whole point; the old `needs_review` fired on nearly every
 * finished task and so meant nothing.
 */
export const TASK_STATUS_META: Record<TaskStatus, StatusVisual> = {
  blocked: { glyph: "dot", label: "blocked", tone: "destructive" },
  done: { glyph: "check", glyphAccent: "text-ok", label: "done", tone: "neutral" },
  interrupted: { glyph: "ring", label: "interrupted", tone: "destructive" },
  queued: { glyph: "clock", label: "queued", tone: "neutral" },
  running: { glyph: "dot", label: "running", pulse: true, tone: "ok" },
  waiting: { glyph: "ring", label: "waiting", tone: "neutral" },
};

/**
 * A node in an orchestration graph. Unrelated to `TaskStatus`: a node is a step
 * in a plan, not a unit of work a human owns, so it has no `waiting` and its
 * `failed` is a real terminal outcome.
 */
export const ORCH_NODE_META: Record<OrchNodeStatus, StatusVisual> = {
  complete: { glyph: "check", glyphAccent: "text-ok", label: "done", tone: "neutral" },
  failed: { glyph: "dot", label: "failed", tone: "destructive" },
  pending: { glyph: "clock", label: "pending", tone: "neutral" },
  running: { glyph: "dot", label: "running", pulse: true, tone: "ok" },
  skipped: { glyph: "minus", label: "skipped", tone: "neutral" },
};

/**
 * Not a lifecycle state: an outstanding permission prompt is an *overlay* on a
 * task that is otherwise `running` or `waiting`. It gets a visual because it
 * outranks the underlying status in any summary, never because it replaces it.
 */
export const PERMISSION_VISUAL: StatusVisual = {
  glyph: "dot",
  label: "permission",
  tone: "warn",
};

/**
 * Spellings a daemon older than the `waiting` merge still puts on the wire.
 * Rust deserialisation handles these via `serde(alias)`, but a desktop build
 * can outrun the daemon binary it talks to, so the frontend maps them too.
 */
const LEGACY_TASK_STATUS: Record<string, TaskStatus> = {
  idle: "waiting",
  needs_review: "waiting",
};

const UNKNOWN_TASK_VISUAL: StatusVisual = { glyph: "ring", label: "unknown", tone: "neutral" };

/**
 * Never index `TASK_STATUS_META` directly with a wire value. A status this
 * build has never heard of must degrade to a neutral badge, not crash the
 * render — version skew against a running daemon is normal, not exceptional.
 */
export function taskStatusVisual(status: TaskStatus | string): StatusVisual {
  return (
    TASK_STATUS_META[status as TaskStatus] ??
    TASK_STATUS_META[LEGACY_TASK_STATUS[status]] ??
    UNKNOWN_TASK_VISUAL
  );
}

export function statusLabel(status: TaskStatus): string {
  return taskStatusVisual(status).label;
}

const TONE_EDGE: Record<Tone, string> = {
  destructive: "border-l-destructive",
  neutral: "border-l-border",
  ok: "border-l-ok",
  warn: "border-l-warn",
};

const ACCENT_EDGE: Record<string, string> = {
  "text-ok": "border-l-ok",
  "text-primary": "border-l-primary",
};

export function statusEdge(status: TaskStatus): string {
  const meta = taskStatusVisual(status);
  return (meta.glyphAccent && ACCENT_EDGE[meta.glyphAccent]) || TONE_EDGE[meta.tone];
}

export interface StatusActivity {
  tone: "thinking" | "working" | "writing";
  label: string;
}

export { TONE_EDGE, ACCENT_EDGE };
export type { Tone, Glyph };
