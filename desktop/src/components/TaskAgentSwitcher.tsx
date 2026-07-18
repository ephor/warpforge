import { Users } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { flattenTaskTree, type TaskTree } from "@/lib/taskGroups";

import { AgentTabButton } from "./AgentTabButton";

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
  const handleSelect = useCallback(
    (id: string) => {
      if (id !== currentTaskId) onOpenTask(id);
    },
    [currentTaskId, onOpenTask],
  );

  if (members.length <= 1) return null;

  return (
    <div className="flex h-10 shrink-0 min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/30 px-2">
      <div className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <Users className="size-3 text-primary" />
        <span>Agents {members.length - 1}</span>
      </div>
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        role="tablist"
        aria-label="Agents in this task group"
      >
        {members.map((member, index) => (
          <AgentTabButton
            key={member.id}
            task={member}
            lead={index === 0}
            shrinkable={false}
            selected={member.id === currentTaskId}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  );
});
