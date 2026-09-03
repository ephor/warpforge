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
import { flattenTaskTree, isOrchestratorTask, type TaskTree } from "@/lib/taskGroups";
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
  const orchestrator = isOrchestratorTask(tree.task, tree.children.length);
  const stageByTaskId = useMemo(() => {
    const result = new Map<string, string>();
    for (const node of tree.task.orchestrationGraph?.nodes ?? []) {
      if (node.taskId) result.set(node.taskId, node.id);
    }
    return result;
  }, [tree.task.orchestrationGraph?.nodes]);
  const memberLabel = useCallback(
    (member: (typeof members)[number], index: number) => {
      if (index === 0) return workflow ? "Workflow" : "Lead";
      const stage = stageByTaskId.get(member.id);
      return stage
        ? `${stage} · ${agentDisplayName(member.agent)}`
        : agentDisplayName(member.agent);
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

  if (members.length <= 1) {
    if (!orchestrator) return null;
    return (
      <span
        title="Orchestrator lead — no worker sessions yet"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-2 text-[11px] font-medium text-muted-foreground"
      >
        <Users className="size-3.5 text-muted-foreground" />
        Orchestrator
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch agent session. Current: ${currentLabel}`}
          title={
            members.length - 1 === 0
              ? "no worker sessions yet"
              : `${members.length - 1} worker sessions`
          }
          className="flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Users className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">
            {members.length - 1}
          </span>
          <span className="text-muted-foreground/50">·</span>
          {currentIndex === 0 ? (
            <span className="max-w-24 truncate rounded-full border border-border/60 bg-secondary/40 px-1.5 py-px text-[11px] font-medium text-foreground">
              {workflow ? "Workflow" : "Lead"}
            </span>
          ) : (
            <span className="max-w-40 truncate rounded-full border border-border/60 bg-secondary/40 px-1.5 py-px text-[11px] font-medium text-foreground">{currentLabel}</span>
          )}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain"
      >
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
