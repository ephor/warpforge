import { CircleX } from "lucide-react";

import { Card } from "@/components/ui/card";
import { elapsed } from "@/lib/status";
import { taskLabel } from "@/lib/taskLabel";

import { AgentAvatarGroup } from "../../components/AgentAvatar";
import type { FailureKind } from "../../lib/taskFailures";

interface FailedItem {
  task: import("@/protocol").TaskInfo;
  kind: FailureKind;
  reason: string;
}

function failureKindLabel(kind: FailureKind): string {
  switch (kind) {
    case "interrupted":
      return "Interrupted";
    case "tool_call":
      return "Tool call";
    case "orchestration":
      return "Node";
    case "workflow_stage":
      return "Stage";
  }
}

export function FailedSection({
  failures,
  onOpenTask,
  hideHeader,
}: {
  failures: FailedItem[];
  onOpenTask: (id: string) => void;
  hideHeader?: boolean;
}) {
  return (
    <Card className="min-w-0 overflow-hidden rounded-md border-border/70 bg-card/35 shadow-none">
      {!hideHeader && (
        <div className="flex items-start gap-3 border-b border-border/60 px-3 py-3">
          <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Failed</h2>
              <span className="tnum rounded-full bg-destructive/10 px-1.5 py-px text-[11px] text-destructive">
                {failures.length}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Something went wrong — open to retry.
            </p>
          </div>
        </div>
      )}
      {failures.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">No failures.</div>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          {failures.map((item) => (
            <button
              key={item.task.id}
              type="button"
              onClick={() => onOpenTask(item.task.id)}
              aria-label={`Open ${taskLabel(item.task)}`}
              className="flex w-full min-w-0 flex-col gap-1.5 border-b border-border/55 px-3 py-3 text-left last:border-b-0 transition-colors hover:bg-secondary/35 focus-visible:bg-secondary/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                  {failureKindLabel(item.kind)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {taskLabel(item.task)}
                </span>
                <span className="shrink-0 text-[11px] font-medium text-primary">Retry</span>
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
