import { ChevronDown, ChevronUp, FilePen, ListTodo, Pin, Wrench } from "lucide-react";
import { memo, useMemo } from "react";

import { AgentBadge } from "@/components/AgentBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PermissionUpdate } from "@/lib/sessionPermissions";
import { latestSessionPreview } from "@/lib/sessionPreview";
import { elapsed } from "@/lib/status";
import { statusEdge } from "@/lib/statusMeta";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { SessionUpdate, TaskInfo } from "../protocol";

export interface SessionRailCardProps {
  task: TaskInfo;
  parentTask?: TaskInfo;
  updates: SessionUpdate[] | undefined;
  pinned: boolean;
  attention: boolean;
  reason?: string;
  permission?: PermissionUpdate;
  focused?: boolean;
  timeMode: "created" | "updated";
  expanded: boolean;
  onPin: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onTogglePreview: (taskId: string) => void;
}

/**
 * Only the card whose task or update array changed re-renders. In particular,
 * the callbacks are shared by every card rather than recreated while mapping.
 */
const SessionRailCard = memo(function SessionRailCard({
  task,
  parentTask,
  updates,
  pinned,
  attention,
  reason,
  permission,
  focused,
  timeMode,
  expanded,
  onPin,
  onOpen,
  onTogglePreview,
}: SessionRailCardProps) {
  const latestUpdate = updates?.[updates.length - 1];
  const activelyStreaming =
    task.status === "running" && !permission && latestUpdate?.kind !== "turn_ended";
  const preview = useMemo(
    () => latestSessionPreview(updates, { active: activelyStreaming, expanded }),
    [activelyStreaming, expanded, updates],
  );
  const timestamp = timeMode === "created" ? task.createdAt : task.updatedAt;
  const timeLabel = timeMode === "created" ? "Created" : "Updated";

  return (
    <Card
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-md border-l-2 bg-card/60 p-2.5 shadow-none transition-colors hover:bg-secondary/20",
        statusEdge(permission ? "permission" : task.status),
        attention && "bg-card",
        focused && "ring-1 ring-primary/70",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        onClick={() => onOpen(task.id)}
        aria-label={`Open ${task.project} session: ${taskLabel(task)}`}
        data-task-id={task.id}
      />
      {/* Row 1: status + project (left) · agent · time (right) — the shared card grammar */}
      <div className="pointer-events-none relative z-10 flex items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={permission ? "permission" : task.status} size="xs" />
        <span className="min-w-0 truncate font-semibold text-foreground">{task.project}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <AgentBadge agentId={task.agent} />
          <span aria-hidden className="h-1 w-1 rounded-full bg-muted-foreground/40" />
          <span
            className="tnum"
            aria-label={`${timeLabel} ${elapsed(timestamp)} ago`}
            title={`${timeLabel} ${elapsed(timestamp)} ago`}
          >
            {elapsed(timestamp)}
          </span>
        </span>
      </div>
      {/* Row 2: title (left) · pin toggle (right) */}
      <div className="pointer-events-none relative z-10 mt-1.5 flex items-start gap-2">
        <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug">
          {taskLabel(task)}
        </p>
        <button
          type="button"
          aria-label={pinned ? "Unpin from Mission Control" : "Pin to Mission Control"}
          className={cn(
            "pointer-events-auto shrink-0 rounded p-0.5 opacity-70 hover:bg-secondary hover:opacity-100",
            pinned && "text-primary opacity-100",
          )}
          onClick={() => onPin(task.id)}
          title={pinned ? "Unpin from Mission Control" : "Pin to Mission Control"}
        >
          <Pin className="size-3.5" />
        </button>
      </div>
      {parentTask && (
        <p
          className="pointer-events-none relative z-10 mt-1 truncate text-[11px] text-muted-foreground"
          title={`${parentTask.prompt} → ${task.prompt}`}
        >
          <span className="font-medium text-foreground/75">{taskLabel(parentTask)}</span>
          <span aria-hidden="true"> → </span>
          <AgentBadge agentId={task.agent} size="xs" className="align-bottom" />
        </p>
      )}
      {reason && (
        <p className="pointer-events-none relative z-10 mt-1 truncate text-xs text-muted-foreground">
          {reason}
        </p>
      )}

      {preview && !permission && (
        <div className="pointer-events-none relative z-10 mt-2 min-w-0 border-t border-border/60 pt-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            {preview.kind === "tool" && <Wrench className="size-3" />}
            {preview.kind === "file" && <FilePen className="size-3" />}
            {preview.kind === "plan" && <ListTodo className="size-3" />}
            {preview.label}
          </div>
          <p
            className={cn(
              "break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]",
              preview.kind === "thought" && "italic",
              (preview.kind === "tool" || preview.kind === "file") && "font-mono",
            )}
            title={preview.text}
          >
            {preview.text}
          </p>
          {(preview.truncated || expanded) && (
            <button
              type="button"
              className="pointer-events-auto mt-1.5 flex items-center gap-1 rounded-sm text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-expanded={expanded}
              onClick={() => onTogglePreview(task.id)}
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {task.filesChanged > 0 && (
        <div className="pointer-events-none relative z-10 mt-2 flex items-center gap-2">
          <span className="tnum text-xs text-muted-foreground">{task.filesChanged} files</span>
        </div>
      )}

      {permission && (
        <div className="pointer-events-none relative z-10 mt-2 flex flex-wrap gap-1.5">
          {permission.options.map((option) => (
            <Button
              key={option}
              aria-label={`${option} permission for ${task.project}`}
              className="pointer-events-auto"
              size="sm"
              variant={option === "deny" ? "destructive" : "default"}
              onClick={() => {
                void daemon.request("session.permission", {
                  outcome: option,
                  request_id: permission.request_id,
                  task_id: task.id,
                });
              }}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
});

export default SessionRailCard;
