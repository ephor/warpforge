import { daemon, DaemonState } from "../daemon";
import { SessionUpdate, TaskInfo } from "../protocol";
import { taskBadge } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

/**
 * "Needs you" rail — tasks blocked on a human (pending permission, review,
 * blocked, interrupted). Lives at the app shell so it shows on every screen.
 */

type PermissionUpdate = Extract<SessionUpdate, { kind: "permission_request" }>;

function pendingPermission(updates: SessionUpdate[]): PermissionUpdate | undefined {
  const last = updates[updates.length - 1];
  return last?.kind === "permission_request" ? last : undefined;
}

interface AttentionItem {
  task: TaskInfo;
  reason: string;
  priority: number;
  permission?: PermissionUpdate;
}

export function attentionQueue(state: DaemonState): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of state.snapshot.tasks) {
    const permission = pendingPermission(state.sessionUpdates[task.id] ?? []);
    if (permission) items.push({ task, reason: permission.title, priority: 0, permission });
    else if (task.status === "needs_review")
      items.push({ task, reason: "finished — review changes", priority: 1 });
    else if (task.status === "blocked")
      items.push({ task, reason: task.blockedReason ?? "blocked", priority: 2 });
    else if (task.status === "interrupted")
      items.push({ task, reason: "session lost on daemon restart", priority: 3 });
  }
  return items.sort((a, b) => a.priority - b.priority || a.task.updatedAt - b.task.updatedAt);
}

interface Props {
  state: DaemonState;
  onOpenTask: (id: string) => void;
}

export default function AttentionRail({ state, onOpenTask }: Props) {
  const queue = attentionQueue(state);
  const working = state.snapshot.tasks.filter((t) => t.status === "running").length;

  return (
    <Card className="flex min-h-0 w-[300px] shrink-0 flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Needs you
        </span>
        {queue.length > 0 && (
          <span className="tnum flex size-5 items-center justify-center rounded-full bg-destructive text-xs font-bold text-destructive-foreground">
            {queue.length}
          </span>
        )}
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-3">
          {queue.length === 0 ? (
            <div className="mt-10 px-4 text-center text-sm leading-relaxed text-muted-foreground">
              <p className="mb-1 text-foreground">All quiet.</p>
              {working} agent{working === 1 ? "" : "s"} working. Nothing needs you.
            </div>
          ) : (
            queue.map((item) => (
              <Card
                key={item.task.id}
                className="border-warn/40 bg-warn/5 p-3 transition-colors hover:border-warn"
              >
                <button
                  className="mb-1.5 flex w-full items-center justify-between text-xs"
                  onClick={() => onOpenTask(item.task.id)}
                >
                  <span className="font-semibold">{item.task.project}</span>
                  <Badge variant={taskBadge(item.task.status).variant}>
                    {taskBadge(item.task.status).label}
                  </Badge>
                </button>
                <p className="mb-2 text-sm">{item.reason}</p>
                {item.permission ? (
                  <div className="flex flex-wrap gap-1.5">
                    {item.permission.options.map((opt) => (
                      <Button
                        key={opt}
                        size="sm"
                        variant={opt === "deny" ? "destructive" : "default"}
                        onClick={() =>
                          void daemon.request("session.permission", {
                            task_id: item.task.id,
                            request_id: item.permission!.request_id,
                            outcome: opt,
                          })
                        }
                      >
                        {opt}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onOpenTask(item.task.id)}>
                    {item.task.status === "needs_review" ? "review diff" : "open"}
                  </Button>
                )}
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}
