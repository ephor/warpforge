import type { TaskStatus } from "@/protocol";

export type StatusKind = TaskStatus | "permission" | "pending" | "complete" | "failed" | "skipped";

type Tone = "ok" | "warn" | "destructive" | "neutral";
type Glyph = "dot" | "ring" | "clock" | "check" | "minus";

const META: Record<
  StatusKind,
  { label: string; tone: Tone; glyph: Glyph; pulse?: boolean; glyphAccent?: string }
> = {
  blocked: { glyph: "dot", label: "blocked", tone: "destructive" },
  complete: { glyph: "check", glyphAccent: "text-ok", label: "done", tone: "neutral" },
  done: { glyph: "check", glyphAccent: "text-ok", label: "done", tone: "neutral" },
  failed: { glyph: "dot", label: "failed", tone: "destructive" },
  idle: { glyph: "ring", glyphAccent: "text-primary", label: "idle", tone: "neutral" },
  interrupted: { glyph: "ring", label: "interrupted", tone: "destructive" },
  needs_review: { glyph: "dot", label: "needs review", tone: "warn" },
  pending: { glyph: "clock", label: "pending", tone: "neutral" },
  permission: { glyph: "dot", label: "permission", tone: "warn" },
  queued: { glyph: "clock", label: "queued", tone: "neutral" },
  running: { glyph: "dot", label: "running", pulse: true, tone: "ok" },
  skipped: { glyph: "minus", label: "skipped", tone: "neutral" },
};

export function statusLabel(status: StatusKind): string {
  return META[status].label;
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

export function statusEdge(status: StatusKind): string {
  const meta = META[status];
  return (meta.glyphAccent && ACCENT_EDGE[meta.glyphAccent]) || TONE_EDGE[meta.tone];
}

export interface StatusActivity {
  tone: "thinking" | "working" | "writing";
  label: string;
}

export { META, TONE_EDGE, ACCENT_EDGE };
export type { Tone, Glyph };
