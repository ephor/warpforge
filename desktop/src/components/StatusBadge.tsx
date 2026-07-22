import { Check, Clock, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/protocol";

/**
 * Every task-ish status the UI shows: task statuses, orchestration node
 * statuses (pending/complete/failed/skipped) and the synthetic attention
 * states (permission, group review).
 */
export type StatusKind =
  | TaskStatus
  | "permission"
  | "pending"
  | "complete"
  | "failed"
  | "skipped";

type Tone = "ok" | "warn" | "destructive" | "neutral";
type Glyph = "dot" | "ring" | "clock" | "check" | "minus";

/**
 * The one visual language for statuses: tone = urgency, glyph = meaning,
 * pulse = live activity. Green pulsing dot — agent is working right now;
 * amber dot — needs the user; red — stopped abnormally (ring = interrupted);
 * neutral clock — waiting in line; brand-blue ring — idle (the same accent as
 * links and the project name); green check in a neutral pill — finished fine
 * without shouting about it. `glyphAccent` tints just the glyph, leaving the
 * pill/label in the tone colour.
 */
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

/** Left-edge accent class for a card, echoing the status glyph's colour. */
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

/** Live-activity chip tones mirror the old activityBadge mapping. */
const ACTIVITY_TONE: Record<"thinking" | "working" | "writing", Tone> = {
  thinking: "neutral",
  working: "warn",
  writing: "ok",
};

export interface StatusActivity {
  tone: "thinking" | "working" | "writing";
  label: string;
}

const TONE_PILL: Record<Tone, string> = {
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  neutral: "border-border bg-secondary/40 text-muted-foreground",
  ok: "border-ok/35 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
};

/**
 * Calm statuses (idle, done) echo their glyph accent in the border and a faint
 * fill, but keep the label muted — themed like the active pills, a shade
 * quieter (the hollow ring / static check does the rest of the calming).
 */
const ACCENT_PILL: Record<string, string> = {
  "text-ok": "border-ok/50 bg-ok/10 text-muted-foreground",
  "text-primary": "border-primary/50 bg-primary/10 text-muted-foreground",
};

const TONE_TEXT: Record<Tone, string> = {
  destructive: "text-destructive",
  neutral: "text-muted-foreground",
  ok: "text-ok",
  warn: "text-warn",
};

function GlyphMark({
  glyph,
  pulse,
  iconCls,
  accent,
}: {
  glyph: Glyph;
  pulse: boolean;
  iconCls: string;
  accent?: string;
}) {
  if (glyph === "check") {
    return <Check aria-hidden className={cn(iconCls, "shrink-0", accent)} strokeWidth={3} />;
  }
  if (glyph === "clock") {
    return <Clock aria-hidden className={cn(iconCls, "shrink-0", accent)} />;
  }
  if (glyph === "minus") {
    return <Minus aria-hidden className={cn(iconCls, "shrink-0", accent)} />;
  }
  return (
    <span aria-hidden className={cn("relative flex size-1.5 shrink-0", accent)}>
      {pulse && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
      )}
      <span
        className={cn(
          "relative inline-flex size-1.5 rounded-full",
          glyph === "ring" ? "border border-current" : "bg-current",
        )}
      />
    </span>
  );
}

/**
 * The one way to show a task status anywhere in the UI.
 *
 * - `pill` (default) — tinted pill with glyph + label.
 * - `dot` — glyph only with a tooltip and sr-only label, for tight spots
 *   (tab strips) where the label lives elsewhere.
 *
 * Pass `activity` while the agent is mid-turn: the label swaps to the live
 * activity (thinking/working/writing) and the dot keeps pulsing.
 */
export function StatusBadge({
  status,
  activity,
  size = "sm",
  variant = "pill",
  className,
}: {
  status: StatusKind;
  activity?: StatusActivity | null;
  size?: "xs" | "sm";
  variant?: "pill" | "dot";
  className?: string;
}) {
  const meta = META[status];
  const live = activity != null && (status === "running" || status === "queued");
  const label = live ? activity.label : meta.label;
  const tone = live ? ACTIVITY_TONE[activity.tone] : meta.tone;
  const glyph = live ? "dot" : meta.glyph;
  const pulse = live || !!meta.pulse;
  const accent = live ? undefined : meta.glyphAccent;
  const iconCls = size === "xs" ? "size-2.5" : "size-3";

  if (variant === "dot") {
    return (
      <span title={label} className={cn("inline-flex items-center", TONE_TEXT[tone], className)}>
        <GlyphMark glyph={glyph} pulse={pulse} iconCls={iconCls} accent={accent} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  const pillTone = (accent && ACCENT_PILL[accent]) || TONE_PILL[tone];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-medium normal-case tracking-normal",
        size === "xs" ? "gap-1 px-1.5 py-px text-[11px]" : "gap-1.5 px-2 py-0.5 text-xs",
        pillTone,
        className,
      )}
    >
      <GlyphMark glyph={glyph} pulse={pulse} iconCls={iconCls} accent={accent} />
      {label}
    </span>
  );
}
