import { Activity } from "lucide-react";
import { useEffect, useState } from "react";

import type { SessionActivity } from "@/lib/sessionActivity";
import { cn } from "@/lib/utils";

/** Ticking elapsed since mount — mounts when a turn starts (activity appears)
 * and unmounts when it ends, so it measures the current turn. */
function TurnTimer() {
  const [start] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((Date.now() - start) / 1000);
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  return <span className="tnum ml-auto shrink-0 opacity-70">{label}</span>;
}

export function AgentActivityIndicator({
  activity,
  compact,
}: {
  activity: SessionActivity;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border shadow-[0_8px_24px_rgb(0_0_0/0.18)]",
        activity.tone === "thinking" && "border-primary/20 bg-primary/[0.055] text-primary",
        activity.tone === "working" && "border-warn/25 bg-warn/[0.06] text-warn",
        activity.tone === "writing" && "border-ok/25 bg-ok/[0.06] text-ok",
        compact ? "px-2.5 py-2 text-xs" : "px-3 py-2.5 text-sm",
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <Activity className={cn("animate-pulse", compact ? "size-3.5" : "size-4")} />
      </div>
      <span className="shrink-0 font-medium">{activity.label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{activity.detail}</span>
      <TurnTimer />
    </div>
  );
}
