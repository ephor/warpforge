import { Check, ChevronDown, Users } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { taskBadge } from "@/lib/status";
import { flattenTaskTree, type TaskTree } from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { AgentBadge } from "./AgentBadge";
import { agentDisplayName } from "./AgentLogo";

export const TaskAgentSwitcher = memo(function TaskAgentSwitcher({
  currentTaskId,
  onOpenTask,
  tree,
}: {
  currentTaskId: string;
  onOpenTask: (id: string) => void;
  tree: TaskTree;
}) {
  const members = useMemo(() => flattenTaskTree(tree), [tree]);
  const currentIndex = members.findIndex((member) => member.id === currentTaskId);
  const current = members[currentIndex] ?? tree.task;
  const currentLabel = currentIndex === 0 ? "Lead" : agentDisplayName(current.agent);
  const handleSelect = useCallback(
    (id: string) => {
      if (id !== currentTaskId) onOpenTask(id);
    },
    [currentTaskId, onOpenTask],
  );

  if (members.length <= 1) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch agent session. Current: ${currentLabel}`}
          title="Switch agent session"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Users className="size-3.5 text-primary" />
          <span>Agents {members.length - 1}</span>
          <span className="text-border">·</span>
          {currentIndex === 0 ? (
            <span className="max-w-24 truncate text-foreground">Lead</span>
          ) : (
            <AgentBadge agentId={current.agent} className="max-w-28 text-foreground" />
          )}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {members.map((member, index) => {
          const badge = taskBadge(member.status);
          const selected = member.id === currentTaskId;
          const label = index === 0 ? "Lead" : agentDisplayName(member.agent);
          return (
            <DropdownMenuItem
              key={member.id}
              aria-label={`${label}: ${badge.label}`}
              onSelect={() => handleSelect(member.id)}
              className="items-start"
            >
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  badge.variant === "destructive" && "bg-destructive",
                  badge.variant === "warn" && "bg-warn",
                  badge.variant === "ok" && "bg-ok",
                  (badge.variant === "default" || badge.variant === "outline") &&
                    "bg-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  {index === 0 ? (
                    <span className="font-medium text-foreground">Lead</span>
                  ) : (
                    <AgentBadge
                      agentId={member.agent}
                      className="font-medium text-foreground"
                    />
                  )}
                  <span className="text-xs text-muted-foreground">{badge.label}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {taskLabel(member)}
                </span>
              </span>
              <Check className={cn("mt-0.5 size-3.5", selected ? "opacity-100" : "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
