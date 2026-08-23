import { TriangleAlert } from "lucide-react";

import { Card } from "@/components/ui/card";
import { attentionAction, attentionStatus } from "@/lib/attentionLabels";
import { elapsed } from "@/lib/status";
import { taskLabel } from "@/lib/taskLabel";

import { AgentAvatarGroup } from "../../components/AgentAvatar";
import { StatusBadge } from "../../components/StatusBadge";
import type { AttentionItem } from "../../lib/attentionRail";

export function DecisionQueue({
  items,
  onOpenTask,
}: {
  items: AttentionItem[];
  onOpenTask: (id: string) => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden rounded-md border-border/70 bg-card/35 shadow-none">
      <div className="flex items-start gap-3 border-b border-border/60 px-3 py-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Decision queue</h2>
            <span className="tnum rounded-full bg-warn/10 px-1.5 py-px text-[11px] text-warn">
              {items.length}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Only work blocked on human input.</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing is waiting for you.
        </div>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          {items.map((item) => (
            <button
              key={item.task.id}
              type="button"
              onClick={() => onOpenTask(item.task.id)}
              aria-label={`Open ${taskLabel(item.task)}`}
              className="group flex w-full min-w-0 flex-col gap-1.5 border-b border-border/55 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-secondary/35 focus-visible:bg-secondary/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge status={attentionStatus(item)} size="xs" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {taskLabel(item.task)}
                </span>
                <span className="shrink-0 text-[11px] font-medium text-primary">
                  {attentionAction(item)}
                </span>
              </div>
              <p className="truncate pl-1 text-xs text-muted-foreground" title={item.reason}>
                {item.reason}
              </p>
              <div className="flex min-w-0 items-center gap-2 pl-1 text-[11px] text-muted-foreground/80">
                <span className="truncate">{item.task.project}</span>
                <span
                  aria-hidden
                  className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40"
                />
                <AgentAvatarGroup agentId={item.task.agent} />
                <span className="tnum ml-auto shrink-0">{elapsed(item.task.updatedAt)} ago</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
