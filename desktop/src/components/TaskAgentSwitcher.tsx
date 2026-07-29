import { Check, ChevronDown, Users } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentDisplayName } from "@/lib/agentNames";
import { statusLabel } from "@/lib/statusMeta";
import { flattenTaskTree, type TaskTree } from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { AgentBadge } from "./AgentBadge";
import { StatusBadge } from "./StatusBadge";

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
  const workflow = Boolean(tree.task.workflowRun);
  const stageByTaskId = useMemo(
    () => {
      const result = new Map<string, string>();
      for (const node of tree.task.orchestrationGraph?.nodes ?? []) {
        if (node.taskId) result.set(node.taskId, node.id);
      }
      return result;
    },
    [tree.task.orchestrationGraph?.nodes],
  );
  const memberLabel = useCallback(
    (member: (typeof members)[number], index: number) => {
      if (index === 0) return workflow ? "Workflow" : "Lead";
      const stage = stageByTaskId.get(member.id);
      return stage ? `${stage} · ${agentDisplayName(member.agent)}` : agentDisplayName(member.agent);
    },
    [stageByTaskId, workflow],
  );
  const currentLabel = memberLabel(current, currentIndex);
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
          <span>{workflow ? "Stages" : "Agents"} {members.length - 1}</span>
          <span className="text-border">·</span>
          {currentIndex === 0 ? (
            <span className="max-w-24 truncate text-foreground">
              {workflow ? "Workflow" : "Lead"}
            </span>
          ) : (
            <span className="max-w-40 truncate text-foreground">{currentLabel}</span>
          )}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {members.map((member, index) => {
          const selected = member.id === currentTaskId;
          const label = memberLabel(member, index);
          const stage = stageByTaskId.get(member.id);
          return (
            <DropdownMenuItem
              key={member.id}
              aria-label={`${label}: ${statusLabel(member.status)}`}
              onSelect={() => handleSelect(member.id)}
              className="items-start"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  {index === 0 ? (
                    <span className="font-medium text-foreground">
                      {workflow ? "Workflow" : "Lead"}
                    </span>
                  ) : (
                    <>
                      {stage && <span className="font-medium text-foreground">{stage}</span>}
                      <AgentBadge agentId={member.agent} className="font-medium text-foreground" />
                    </>
                  )}
                  <StatusBadge status={member.status} size="xs" />
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
