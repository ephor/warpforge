import { Check, Clock, Minus } from "lucide-react";

import {
  ORCH_NODE_META,
  PERMISSION_VISUAL,
  type StatusActivity,
  type StatusVisual,
  taskStatusVisual,
} from "@/lib/statusMeta";
import { cn } from "@/lib/utils";
import type { OrchNodeStatus, TaskStatus } from "@/protocol";

type Tone = "ok" | "warn" | "destructive" | "neutral";
type Glyph = "dot" | "ring" | "clock" | "check" | "minus";

const UNKNOWN_NODE_VISUAL: StatusVisual = { glyph: "ring", label: "unknown", tone: "neutral" };

const ACTIVITY_TONE: Record<"thinking" | "working" | "writing", Tone> = {
  thinking: "neutral",
  working: "warn",
  writing: "ok",
};

const TONE_PILL: Record<Tone, string> = {
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  neutral: "border-border bg-secondary/40 text-muted-foreground",
  ok: "border-ok/35 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
};

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

/** What a badge can be asked to draw. `permission` overlays a task status. */
export type TaskBadgeStatus = TaskStatus | "permission";

type StatusBadgeProps = {
  activity?: StatusActivity | null;
  size?: "xs" | "sm";
  variant?: "pill" | "dot";
  className?: string;
} & ({ kind?: "task"; status: TaskBadgeStatus } | { kind: "node"; status: OrchNodeStatus });

/**
 * The one way to show a status anywhere in the UI.
 *
 * Two vocabularies reach this component and they stay apart until here: a task
 * lifecycle (`kind="task"`, the default) and an orchestration-graph node
 * (`kind="node"`). The `kind` discriminator is what lets `statusMeta` keep two
 * independent maps instead of one union with overlapping keys.
 *
 * - `pill` (default) — tinted pill with glyph + label.
 * - `dot` — glyph only with a tooltip and sr-only label, for tight spots
 *   (tab strips) where the label lives elsewhere.
 *
 * Pass `activity` while the agent is mid-turn: the label swaps to the live
 * activity (thinking/working/writing) and the dot keeps pulsing.
 */
export function StatusBadge(props: StatusBadgeProps) {
  const { activity, size = "sm", variant = "pill", className } = props;
  const status: string = props.status;
  const meta: StatusVisual =
    props.kind === "node"
      ? (ORCH_NODE_META[props.status] ?? UNKNOWN_NODE_VISUAL)
      : props.status === "permission"
        ? PERMISSION_VISUAL
        : taskStatusVisual(props.status);
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
