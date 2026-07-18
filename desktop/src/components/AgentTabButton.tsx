import { memo } from "react";

import { taskBadge } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { TaskInfo } from "@/protocol";

export const AgentTabButton = memo(function AgentTabButton({
  task,
  selected,
  permission = false,
  lead = false,
  shrinkable = true,
  onSelect,
}: {
  task: TaskInfo;
  selected: boolean;
  permission?: boolean;
  lead?: boolean;
  shrinkable?: boolean;
  onSelect: (id: string) => void;
}) {
  const badge = permission
    ? { label: "permission", variant: "warn" as const }
    : taskBadge(task.status);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`${lead ? "Lead" : task.agent}: ${badge.label}`}
      title={`${lead ? "Lead" : task.agent} — ${task.prompt}`}
      className={cn(
        "flex h-8 min-w-0 max-w-36 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        shrinkable ? "shrink" : "shrink-0",
        selected
          ? "border-primary/60 bg-primary/15 text-foreground shadow-sm"
          : "border-border/60 bg-secondary/30 text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
      onClick={() => onSelect(task.id)}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          badge.variant === "destructive" && "bg-destructive",
          badge.variant === "warn" && "bg-warn",
          badge.variant === "ok" && "bg-ok",
          (badge.variant === "default" || badge.variant === "outline") && "bg-muted-foreground",
        )}
      />
      <span className="truncate">{lead ? "Lead" : task.agent}</span>
    </button>
  );
});
