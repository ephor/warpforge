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
import { cn } from "@/lib/utils";

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
  const currentLabel = currentIndex === 0 ? "Lead" : current.agent;
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
          <span className="max-w-24 truncate text-foreground">{currentLabel}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {members.map((member, index) => {
          const badge = taskBadge(member.status);
          const selected = member.id === currentTaskId;
          const label = index === 0 ? "Lead" : member.agent;
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
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="text-xs text-muted-foreground">{badge.label}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {member.prompt}
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
