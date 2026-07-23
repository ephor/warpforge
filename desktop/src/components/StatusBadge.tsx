import { Check, Clock, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import { META, type StatusActivity, type StatusKind } from "@/lib/statusMeta";

type Tone = "ok" | "warn" | "destructive" | "neutral";
type Glyph = "dot" | "ring" | "clock" | "check" | "minus";

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
