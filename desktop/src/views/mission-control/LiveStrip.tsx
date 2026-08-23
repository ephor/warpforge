import { memo, useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { formatElapsed, type LiveStripItem } from "@/lib/liveStrip";

const TONE_CLASS: Record<LiveStripItem["tone"], string> = {
  thinking: "text-sky-400",
  working: "text-amber-400",
  writing: "text-emerald-400",
};

interface LiveStripProps {
  items: LiveStripItem[];
  nowMs?: number;
  onOpenTask?: (taskId: string) => void;
}

export const LiveStrip = memo(function LiveStrip({ items, nowMs, onOpenTask }: LiveStripProps) {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (nowMs !== undefined) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [nowMs]);

  if (items.length === 0) return null;

  const effectiveNow = nowMs ?? tick;

  return (
    <section aria-labelledby="live-strip-heading" className="min-w-0">
      <div className="mb-2 flex items-end justify-between gap-3">
        <h2 id="live-strip-heading" className="text-sm font-semibold text-foreground">
          Live
        </h2>
        <span className="tnum text-xs text-muted-foreground">
          {items.length} session{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {items.map((item) => (
          <button
            key={item.taskId}
            type="button"
            onClick={() => onOpenTask?.(item.taskId)}
            className="flex min-w-56 max-w-72 flex-col gap-1 rounded-md border border-border p-2 text-left hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="flex w-full items-center gap-2">
              <span className={cn("truncate text-xs font-semibold", TONE_CLASS[item.tone])}>
                {item.label}
              </span>
              <span className="ml-auto shrink-0 tnum text-[11px] text-muted-foreground">
                {item.startedAt !== null ? formatElapsed(item.startedAt, effectiveNow) : ""}
              </span>
            </span>
            {item.detail ? (
              <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
            ) : null}
            {item.previewText ? (
              <span className="line-clamp-2 text-xs text-muted-foreground/90">{item.previewText}</span>
            ) : null}
            <span className="truncate text-xs font-medium text-foreground">{item.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}, liveStripEqual);

function liveStripEqual(previous: LiveStripProps, next: LiveStripProps): boolean {
  if (previous.nowMs !== next.nowMs) return false;
  if (previous.onOpenTask !== next.onOpenTask) return false;
  if (previous.items === next.items) return true;
  if (previous.items.length !== next.items.length) return false;
  for (let i = 0; i < previous.items.length; i += 1) {
    const a = previous.items[i];
    const b = next.items[i];
    if (
      a.taskId !== b.taskId ||
      a.title !== b.title ||
      a.label !== b.label ||
      a.detail !== b.detail ||
      a.tone !== b.tone ||
      a.previewText !== b.previewText ||
      a.startedAt !== b.startedAt ||
      a.toolCount !== b.toolCount
    ) {
      return false;
    }
  }
  return true;
}
