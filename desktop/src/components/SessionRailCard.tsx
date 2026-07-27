import {
  ArrowRight,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  FilePen,
  ListTodo,
  Moon,
  Pin,
  Sun,
  Undo2,
  Wrench,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentAvatarGroup } from "@/components/AgentAvatar";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PermissionUpdate } from "@/lib/sessionPermissions";
import { latestSessionPreview } from "@/lib/sessionPreview";
import { buildSnoozePresets } from "@/lib/snooze";
import { elapsed } from "@/lib/status";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { SessionUpdate, TaskInfo } from "../protocol";

export type ShelfId = "needs-you" | "working" | "snoozed" | "settled";
type LifecycleAction = "snooze" | "unsnooze" | "settle" | "unsettle";

export interface SessionRailCardProps {
  task: TaskInfo;
  shelf: ShelfId;
  parentTask?: TaskInfo;
  updates: SessionUpdate[] | undefined;
  pinned: boolean;
  attention: boolean;
  reason?: string;
  permission?: PermissionUpdate;
  focused?: boolean;
  woke?: boolean;
  timeMode: "created" | "updated";
  expanded: boolean;
  previewMode?: "auto" | "hidden";
  childAgents?: string[];
  onPin: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onTogglePreview: (taskId: string) => void;
}

function canSettle(task: TaskInfo, permission: PermissionUpdate | undefined): boolean {
  if (task.status === "running") return false;
  if (permission) return false;
  return true;
}

function canSnooze(permission: PermissionUpdate | undefined): boolean {
  if (permission) return false;
  return true;
}

function isForegrounded(
  shelf: ShelfId,
  task: TaskInfo,
  permission: PermissionUpdate | undefined,
  woke: boolean,
): boolean {
  if (shelf === "needs-you") return true;
  if (shelf === "working") {
    if (permission) return true;
    if (task.status === "running") return true;
    if (
      task.status === "needs_review" ||
      task.status === "blocked" ||
      task.status === "interrupted"
    )
      return true;
    if (woke) return true;
    return false;
  }
  return true;
}

function formatWakeTime(until: number): string {
  const now = Date.now();
  const untilMs = until * 1000;
  const diffMs = untilMs - now;
  if (diffMs <= 0) return "now";
  const diffMin = Math.ceil(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.ceil(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.ceil(diffHr / 24)}d`;
}

const SessionRailCard = memo(function SessionRailCard({
  task,
  shelf,
  parentTask,
  updates,
  pinned,
  attention,
  reason,
  permission,
  focused,
  woke,
  timeMode,
  expanded,
  previewMode = "auto",
  childAgents,
  onPin,
  onOpen,
  onTogglePreview,
}: SessionRailCardProps) {
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const latestUpdate = updates?.[updates.length - 1];
  const activelyStreaming =
    task.status === "running" && !permission && latestUpdate?.kind !== "turn_ended";
  const shouldShowPreview = previewMode === "auto" && (expanded || activelyStreaming);
  const preview = useMemo(
    () =>
      shouldShowPreview
        ? latestSessionPreview(updates, { active: activelyStreaming, expanded })
        : null,
    [activelyStreaming, expanded, shouldShowPreview, updates],
  );
  const timestamp = timeMode === "created" ? task.createdAt : task.updatedAt;
  const timeLabel = timeMode === "created" ? "Created" : "Updated";
  const foregrounded = isForegrounded(shelf, task, permission, woke ?? false);
  const settleable = shelf !== "snoozed" && shelf !== "settled" && canSettle(task, permission);
  const snoozeable = shelf !== "snoozed" && shelf !== "settled" && canSnooze(permission);
  const hasLifecycleActions =
    shelf === "snoozed" || shelf === "settled" || settleable || snoozeable;

  const runLifecycle = useCallback(
    async (action: LifecycleAction, rpcMethod: string, rpcParams: Record<string, unknown>) => {
      if (pendingAction) return;
      setPendingAction(action);
      try {
        await daemon.request(rpcMethod, rpcParams);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(message);
      } finally {
        setPendingAction(null);
      }
    },
    [pendingAction],
  );

  const handleSnooze = useCallback(
    (until: number) => {
      void runLifecycle("snooze", "task.snooze", { task_id: task.id, until });
    },
    [runLifecycle, task.id],
  );

  const handleWakeNow = useCallback(() => {
    void runLifecycle("unsnooze", "task.unsnooze", { task_id: task.id });
  }, [runLifecycle, task.id]);

  const handleSettle = useCallback(() => {
    void runLifecycle("settle", "task.settle", { task_id: task.id });
  }, [runLifecycle, task.id]);

  const handleUnsettle = useCallback(() => {
    void runLifecycle("unsettle", "task.unsettle", { task_id: task.id });
  }, [runLifecycle, task.id]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- snoozeMenuOpen forces fresh presets on menu open
  const snoozePresets = useMemo(() => buildSnoozePresets(Date.now()), [snoozeMenuOpen]);

  return (
    <Card
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-md border-border/55 bg-card/30 px-2.5 py-2 shadow-none transition-[background-color,border-color,opacity] hover:border-border hover:bg-secondary/25",
        attention && "bg-card/55",
        focused && "border-primary/45 bg-secondary/30 ring-1 ring-inset ring-primary/30",
        !foregrounded && "opacity-65 hover:opacity-100",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        onClick={() => onOpen(task.id)}
        aria-label={`Open ${task.project} session: ${taskLabel(task)}`}
        data-task-id={task.id}
      />
      {/* Row 1: status + project (left) · agent · time (right) */}
      <div className="pointer-events-none relative z-10 flex items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={permission ? "permission" : task.status} size="xs" />
        {woke && (
          <span
            data-testid="woke-badge"
            className="inline-flex items-center gap-0.5 rounded-full bg-warn/15 px-1.5 py-px text-[10px] font-semibold text-warn"
          >
            <Sun className="size-2.5" />
            Woke
          </span>
        )}
        <span className="min-w-0 truncate font-semibold text-foreground">{task.project}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <AgentAvatarGroup agentId={task.agent} childAgents={childAgents} />
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
        <p
          className={cn(
            "min-w-0 flex-1 text-[13px] font-medium leading-snug",
            focused ? "line-clamp-2" : "line-clamp-1",
          )}
        >
          {taskLabel(task)}
        </p>
        <button
          type="button"
          aria-label={pinned ? "Unpin from Mission Control" : "Pin to Mission Control"}
          className={cn(
            "pointer-events-auto shrink-0 rounded p-0.5 opacity-70 hover:bg-secondary hover:opacity-100",
            pinned && "text-primary opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin(task.id);
          }}
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
          <AgentAvatarGroup agentId={task.agent} childAgents={childAgents} />
        </p>
      )}
      {reason && (
        <p className="pointer-events-none relative z-10 mt-1 truncate text-xs text-muted-foreground">
          {reason}
        </p>
      )}

      {shelf === "snoozed" && task.snoozedUntil != null && (
        <p className="pointer-events-none relative z-10 mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="size-3" />
          Wakes in {formatWakeTime(task.snoozedUntil)}
        </p>
      )}

      {preview && !permission && (
        <div className="pointer-events-none relative z-10 mt-1.5 min-w-0 border-t border-border/45 pt-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            {preview.kind === "tool" && <Wrench className="size-3" />}
            {preview.kind === "file" && <FilePen className="size-3" />}
            {preview.kind === "plan" && <ListTodo className="size-3" />}
            <span>Latest activity</span>
          </div>
          <p
            className={cn(
              "text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]",
              expanded ? "break-words" : "line-clamp-2",
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
              onClick={(e) => {
                e.stopPropagation();
                onTogglePreview(task.id);
              }}
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {(task.filesChanged > 0 || hasLifecycleActions) && (
        <div className="relative z-10 mt-1.5 flex min-h-6 items-center gap-2">
          {task.filesChanged > 0 && (
            <span className="pointer-events-none tnum text-[11px] text-muted-foreground">
              {task.filesChanged} files
            </span>
          )}
          <LifecycleActions
            shelf={shelf}
            pendingAction={pendingAction}
            settleable={settleable}
            snoozeable={snoozeable}
            snoozeMenuOpen={snoozeMenuOpen}
            onSnoozeMenuOpenChange={setSnoozeMenuOpen}
            snoozePresets={snoozePresets}
            onSnooze={handleSnooze}
            onWakeNow={handleWakeNow}
            onSettle={handleSettle}
            onUnsettle={handleUnsettle}
          />
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
              onClick={(e) => {
                e.stopPropagation();
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

interface LifecycleActionsProps {
  shelf: ShelfId;
  pendingAction: LifecycleAction | null;
  settleable: boolean;
  snoozeable: boolean;
  snoozeMenuOpen: boolean;
  onSnoozeMenuOpenChange: (open: boolean) => void;
  snoozePresets: ReturnType<typeof buildSnoozePresets>;
  onSnooze: (until: number) => void;
  onWakeNow: () => void;
  onSettle: () => void;
  onUnsettle: () => void;
}

function LifecycleActions({
  shelf,
  pendingAction,
  settleable,
  snoozeable,
  snoozeMenuOpen,
  onSnoozeMenuOpenChange,
  snoozePresets,
  onSnooze,
  onWakeNow,
  onSettle,
  onUnsettle,
}: LifecycleActionsProps) {
  const isBusy = pendingAction !== null;

  if (shelf === "snoozed") {
    return (
      <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation();
            onWakeNow();
          }}
        >
          <ArrowRight className="size-3" />
          Show now
        </button>
        {pendingAction === "unsnooze" && (
          <span className="text-[10px] text-muted-foreground">…</span>
        )}
      </div>
    );
  }

  if (shelf === "settled") {
    return (
      <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation();
            onUnsettle();
          }}
        >
          <Undo2 className="size-3" />
          Return to active
        </button>
        {pendingAction === "unsettle" && (
          <span className="text-[10px] text-muted-foreground">…</span>
        )}
      </div>
    );
  }

  return (
    <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
      {snoozeable && (
        <DropdownMenu modal={false} open={snoozeMenuOpen} onOpenChange={onSnoozeMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-lifecycle="snooze-trigger"
              className="flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
              disabled={isBusy}
              onClick={(e) => e.stopPropagation()}
            >
              <Moon className="size-3" />
              Remind later
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              align="start"
              className="w-48"
              data-lifecycle="snooze-menu"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {snoozePresets.map((preset) => (
                <DropdownMenuItem
                  key={preset.id}
                  data-snooze-preset={preset.id}
                  onSelect={() => onSnooze(preset.until)}
                >
                  {preset.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      )}

      {settleable && (
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation();
            onSettle();
          }}
        >
          <CheckCheck className="size-3" />
          Mark handled
        </button>
      )}

      {pendingAction && pendingAction !== "unsnooze" && pendingAction !== "unsettle" && (
        <span className="text-[10px] text-muted-foreground">…</span>
      )}
    </div>
  );
}

export default SessionRailCard;
