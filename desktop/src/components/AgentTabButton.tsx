import { memo } from "react";

import { cn } from "@/lib/utils";
import type { TaskInfo } from "@/protocol";

import { AgentBadge } from "./AgentBadge";
import { agentDisplayName } from "./AgentLogo";
import { StatusBadge, statusLabel } from "./StatusBadge";

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
  const status = permission ? "permission" : task.status;
  const name = lead ? "Lead" : agentDisplayName(task.agent);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`${name}: ${statusLabel(status)}`}
      title={`${name} — ${task.prompt}`}
      className={cn(
        "flex h-7 min-w-0 max-w-36 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        shrinkable ? "shrink" : "shrink-0",
        selected
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-transparent bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
      onClick={() => onSelect(task.id)}
    >
      <StatusBadge status={status} variant="dot" className="shrink-0" />
      {lead ? (
        <span className="truncate">Lead</span>
      ) : (
        <AgentBadge agentId={task.agent} className="min-w-0" />
      )}
    </button>
  );
});
