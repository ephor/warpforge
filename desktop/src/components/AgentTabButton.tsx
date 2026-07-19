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
        "flex h-7 min-w-0 max-w-36 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        shrinkable ? "shrink" : "shrink-0",
        selected
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-transparent bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
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
