import { ListTodo } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";

import { AgentBadge } from "../../components/AgentBadge";
import { StatusBadge } from "../../components/StatusBadge";
import type { OrchNodeInfo, TaskInfo } from "../../protocol";

function SubtaskRow({ node }: { node: OrchNodeInfo }) {
  return (
    <div className="flex items-center gap-2 rounded bg-secondary/30 px-2 py-1.5 text-xs">
      <StatusBadge status={node.status} size="xs" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{node.kind}</span>
      <AgentBadge agentId={node.agent} size="xs" className="shrink-0 text-muted-foreground" />
      {node.taskId && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{node.taskId}</span>
      )}
    </div>
  );
}

export function SubtasksRail({ task }: { task: TaskInfo }) {
  const nodes = task.orchestrationGraph?.nodes ?? [];
  const graph = task.orchestrationGraph;
  if (!graph) {
    return <p className="p-3 text-sm text-muted-foreground">No orchestration data.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ListTodo className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Subtasks</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {nodes.filter((n) => n.status === "complete").length}/{nodes.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-2">
          {nodes.map((node) => (
            <SubtaskRow key={node.id} node={node} />
          ))}
        </div>
      </ScrollArea>
      <div className="border-t px-3 py-2">
        <div className="text-xs text-muted-foreground">{graph.goal}</div>
      </div>
    </div>
  );
}
