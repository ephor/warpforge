import { Maximize2, Pin } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { PermissionUpdate } from "@/lib/sessionPermissions";
import { pendingPermission } from "@/lib/sessionPermissions";
import { elapsed, taskBadge, taskEdge } from "@/lib/status";
import { cn } from "@/lib/utils";

import type { DaemonState } from "../daemon";
import { daemon } from "../daemon";
import type { SessionUpdate, TaskInfo } from "../protocol";
import { useUi } from "../store/ui";
import { StreamLine, coalesceUpdates, streamKey } from "../views/MissionControl";

/**
 * "Needs you" rail — tasks blocked on a human (pending permission, review,
 * blocked, interrupted). Lives at the app shell so it shows on every screen.
 */

function previewableUpdate(update: SessionUpdate): boolean {
  return (
    update.kind !== "available_commands" &&
    update.kind !== "permission_request" &&
    update.kind !== "permission_resolved"
  );
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
    if (permission) {
      items.push({ task, reason: permission.title, priority: 0, permission });
    } else if (task.status === "needs_review") {
      items.push({ task, reason: "finished — review changes", priority: 1 });
    } else if (task.status === "blocked") {
      items.push({ task, reason: task.blockedReason ?? "blocked", priority: 2 });
    } else if (task.status === "interrupted") {
      items.push({ task, reason: "session lost on daemon restart", priority: 3 });
    }
  }
  return items.sort((a, b) => a.priority - b.priority || b.task.updatedAt - a.task.updatedAt);
}

interface Props {
  state: DaemonState;
  onOpenTask: (id: string) => void;
}

export default function AttentionRail({ state, onOpenTask }: Props) {
  const pinned = useUi((s) => s.pinnedTaskIds);
  const togglePin = useUi((s) => s.togglePinnedTask);
  const queue = attentionQueue(state);
  const attentionIds = useMemo(() => new Set(queue.map((item) => item.task.id)), [queue]);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const permissions = useMemo(
    () =>
      new Map(queue.flatMap((item) => (item.permission ? [[item.task.id, item.permission]] : []))),
    [queue],
  );
  const reasons = useMemo(() => new Map(queue.map((item) => [item.task.id, item.reason])), [queue]);

  const live = useMemo(() => {
    const tasks = state.snapshot.tasks.filter((t) => t.status !== "done");
    return tasks.sort((a, b) => {
      const ap = attentionIds.has(a.id) ? 0 : 1;
      const bp = attentionIds.has(b.id) ? 0 : 1;
      return ap - bp || b.updatedAt - a.updatedAt;
    });
  }, [state.snapshot.tasks, attentionIds]);

  // Stable callbacks — avoid inline arrows that create new refs per task per render.
  const handlePin = useCallback(
    (taskId: string) => () => togglePin(taskId),
    [togglePin],
  );
  const handleOpen = useCallback(
    (taskId: string) => () => onOpenTask(taskId),
    [onOpenTask],
  );

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden bg-card/90">
      <div className="flex h-11 items-center justify-between px-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Sessions
        </span>
        {queue.length > 0 && (
          <span className="tnum flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive/90 px-1.5 text-xs font-semibold text-destructive-foreground">
            {queue.length}
          </span>
        )}
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-2.5">
          {live.length === 0 ? (
            <div className="mt-10 px-4 text-center text-sm leading-relaxed text-muted-foreground">
              <p className="mb-1 text-foreground">All quiet.</p>
              No live sessions.
            </div>
          ) : (
            live.map((task) => (
              <SessionRailCard
                key={task.id}
                task={task}
                updates={state.sessionUpdates[task.id]}
                pinned={pinnedSet.has(task.id)}
                attention={attentionIds.has(task.id)}
                reason={reasons.get(task.id)}
                permission={permissions.get(task.id)}
                onPin={handlePin(task.id)}
                onOpen={handleOpen(task.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}

/**
 * Memoized card — only re-renders when its specific task data changes.
 * Coalesces its own updates internally so the parent doesn't have to
 * pre-compute for every task on every render.
 */
const SessionRailCard = memo(function SessionRailCard({
  task,
  updates,
  pinned,
  attention,
  reason,
  permission,
  onPin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[] | undefined;
  pinned: boolean;
  attention: boolean;
  reason?: string;
  permission?: PermissionUpdate;
  onPin: () => void;
  onOpen: () => void;
}) {
  const badge = taskBadge(task.status);
  const recent = useMemo(
    () => (updates ? coalesceUpdates(updates).filter(previewableUpdate).slice(-4) : []),
    [updates],
  );

  return (
    <Card
      className={cn(
        "group flex cursor-pointer flex-col border-l-2 bg-card/70 p-3 transition-colors hover:border-primary/60 hover:bg-secondary/20",
        taskEdge(task.status),
        attention && "border-warn/40 bg-card",
      )}
      onClick={onOpen}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-semibold text-foreground">{task.project}</span>
        <span className="shrink-0 font-mono">{task.agent}</span>
        <span className="tnum ml-auto shrink-0">{elapsed(task.createdAt)}</span>
        <button
          type="button"
          className={cn(
            "rounded p-0.5 opacity-70 hover:bg-secondary hover:opacity-100",
            pinned && "text-primary opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          title={pinned ? "Unpin from Mission Control" : "Pin to Mission Control"}
        >
          <Pin className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 opacity-70 hover:bg-secondary hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title="Open full detail"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{task.prompt}</p>
      {reason && <p className="mt-1 truncate text-xs text-warn/90">{reason}</p>}

      {recent.length > 0 && (
        <div className="mt-2 max-h-24 min-w-0 overflow-hidden rounded-md border border-border/50 bg-background/35 px-2.5 py-2">
          <div
            className="flex min-w-0 flex-col gap-1 text-xs leading-relaxed text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            {recent.map((u, i) => (
              <StreamLine key={streamKey(u, i)} update={u} compact />
            ))}
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {task.filesChanged > 0 && (
          <span className="tnum text-xs text-muted-foreground">{task.filesChanged} files</span>
        )}
      </div>

      {permission && (
        <div className="mt-2 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
          {permission.options.map((opt) => (
            <Button
              key={opt}
              size="sm"
              variant={opt === "deny" ? "destructive" : "default"}
              onClick={() =>
                void daemon.request("session.permission", {
                  outcome: opt,
                  request_id: permission.request_id,
                  task_id: task.id,
                })
              }
            >
              {opt}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
});
