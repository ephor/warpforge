import { Activity } from "lucide-react";
import { SessionActivity } from "@/lib/sessionActivity";
import { cn } from "@/lib/utils";

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
        <span className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-pulse rounded-full bg-current opacity-70"
              style={{ animationDelay: `${i * 140}ms` }}
            />
          ))}
        </span>
      </div>
      <span className="shrink-0 font-medium">{activity.label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{activity.detail}</span>
    </div>
  );
}
