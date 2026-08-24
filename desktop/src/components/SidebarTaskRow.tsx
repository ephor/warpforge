import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Eye,
  FileDiff,
  FolderTree,
  GitBranch,
  Layers,
  MessageCircleQuestion,
  MoreHorizontal,
  Pin,
  Trash2,
  Undo2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentLogo } from "@/components/AgentLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { daemon } from "@/daemon";
import { agentDisplayName } from "@/lib/agentNames";
import { buildSnoozePresets } from "@/lib/snooze";
import { elapsed } from "@/lib/status";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";
import type { TaskInfo } from "@/protocol";

import {
  SIDEBAR_INDENT_PX,
  SIDEBAR_STATE_META,
  isSnoozed,
  snoozeWakeLabel,
  type SidebarStateIcon,
  type SidebarTaskState,
} from "./Sidebar.logic";

/**
 * One task row. Anatomy, left to right:
 *
 *   [twisty] [status glyph] title …                 [agent] [elapsed]
 *                                                   └ swapped for row actions
 *                                                     on hover / focus
 *
 * The right slot is a single fixed-width lane: resting metadata fades out and
 * the actions fade in over it, so hovering never reflows the row and the
 * affordances add no permanent visual noise (t3code's `group/v2-row` pattern).
 *
 * The glyph slot is usually *empty*. Only four states draw into it (see
 * `SIDEBAR_STATE_META.rowGlyph`); everything else is title plus relative time.
 * The lane is still reserved on every row, because a ragged left edge would
 * cost more calm than the glyphs ever did — and holding one axis is what makes
 * the rare glyph read instantly.
 */

const STATE_ICON: Record<SidebarStateIcon, LucideIcon> = {
  blocked: CircleAlert,
  done: CircleCheck,
  failed: Unplug,
  idle: Circle,
  needs_answer: MessageCircleQuestion,
  queued: Clock,
  review: Eye,
  settled: Check,
  snoozed: AlarmClock,
  working: CircleDashed,
};

/** Reserved lane for the disclosure twisty so every glyph stays on one axis. */
const TWISTY_LANE = "pl-6";

/** Self-ticking so a running row's timer costs one span, not a list re-render. */
function LiveElapsed({ since }: { since: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{elapsed(since)}</>;
}

function TooltipLine({
  icon: Icon,
  children,
  tone,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2", tone)}>
      <Icon aria-hidden className="mt-px size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/**
 * Everything that does not fit on the row: project, worktree, agent, size of
 * the change, and why the task is stuck. Exported so the content can be
 * asserted without driving a Radix hover.
 */
export function SidebarTaskTooltipBody({
  task,
  state,
  childCount,
  nowSec,
}: {
  task: TaskInfo;
  state: SidebarTaskState;
  childCount: number;
  nowSec: number;
}) {
  const meta = SIDEBAR_STATE_META[state];
  const StateIcon = STATE_ICON[meta.icon];
  const worktree = task.worktree ?? null;
  return (
    <div className="flex max-w-[17rem] flex-col gap-2 p-1">
      <div className="text-[13px] font-medium leading-snug text-foreground">{taskLabel(task)}</div>
      <div className="grid gap-1.5 text-[11px] text-muted-foreground">
        <TooltipLine icon={StateIcon} tone={meta.toneClass}>
          <span className="text-foreground/85">{meta.label}</span>
          <span className="text-muted-foreground/60"> · </span>
          <span className="tnum text-muted-foreground/80">{elapsed(task.updatedAt)} ago</span>
        </TooltipLine>
        <TooltipLine icon={FolderTree}>{task.project}</TooltipLine>
        {worktree && (
          <TooltipLine icon={GitBranch}>
            <span className="font-mono text-[10px]">{worktree}</span>
          </TooltipLine>
        )}
        <div className="flex min-w-0 items-start gap-2">
          <AgentLogo
            agentId={task.agent}
            displayName={task.agent}
            className="mt-px size-3.5 opacity-80"
          />
          <span className="min-w-0 flex-1 break-words">{agentDisplayName(task.agent)}</span>
        </div>
        {childCount > 0 && (
          <TooltipLine icon={Layers}>
            {childCount} subtask{childCount === 1 ? "" : "s"}
          </TooltipLine>
        )}
        {task.filesChanged > 0 && (
          <TooltipLine icon={FileDiff}>
            <span className="tnum">{task.filesChanged}</span> file
            {task.filesChanged === 1 ? "" : "s"} changed
          </TooltipLine>
        )}
        {isSnoozed(task, nowSec) && (
          <TooltipLine icon={AlarmClock} tone="text-info">
            back in <span className="tnum">{snoozeWakeLabel(task.snoozedUntil!, nowSec)}</span>
          </TooltipLine>
        )}
        {task.blockedReason && (
          <TooltipLine icon={CircleAlert} tone="text-destructive">
            {task.blockedReason}
          </TooltipLine>
        )}
      </div>
    </div>
  );
}

const ACTION_BUTTON =
  "grid size-[22px] shrink-0 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function RowActions({
  task,
  state,
  pinned,
  onPin,
}: {
  task: TaskInfo;
  state: SidebarTaskState;
  pinned: boolean;
  onPin: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const label = taskLabel(task);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reopening must recompute "1 hour from now"
  const presets = useMemo(() => buildSnoozePresets(Date.now()), [snoozeOpen]);

  const run = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await daemon.request(method, params);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return (
    <div
      className={cn(
        "absolute inset-y-0 right-1 flex items-center gap-px opacity-0 transition-opacity",
        "pointer-events-none group-hover/row:pointer-events-auto group-hover/row:opacity-100",
        "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100",
      )}
    >
      {state === "snoozed" ? (
        <button
          type="button"
          disabled={busy}
          aria-label={`Wake now: ${label}`}
          title="Wake now"
          className={ACTION_BUTTON}
          onClick={() => void run("task.unsnooze", { task_id: task.id })}
        >
          <AlarmClockOff className="size-3.5" />
        </button>
      ) : state === "settled" ? (
        <button
          type="button"
          disabled={busy}
          aria-label={`Return to active: ${label}`}
          title="Return to active"
          className={ACTION_BUTTON}
          onClick={() => void run("task.unsettle", { task_id: task.id })}
        >
          <Undo2 className="size-3.5" />
        </button>
      ) : (
        <>
          <DropdownMenu modal={false} open={snoozeOpen} onOpenChange={setSnoozeOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remind later: ${label}`}
                title="Remind later"
                className={ACTION_BUTTON}
              >
                <Clock className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent align="end" className="w-44">
                {presets.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    data-snooze-preset={preset.id}
                    onSelect={() =>
                      void run("task.snooze", { task_id: task.id, until: preset.until })
                    }
                  >
                    <span className="flex-1">{preset.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
          {task.status !== "running" && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Mark handled: ${label}`}
              title="Mark handled"
              className={ACTION_BUTTON}
              onClick={() => void run("task.settle", { task_id: task.id })}
            >
              <Check className="size-3.5" />
            </button>
          )}
        </>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Task actions: ${label}`}
            title="More"
            className={ACTION_BUTTON}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => onPin(task.id)}>
              <Pin className="size-3.5 opacity-70" />
              {pinned ? "Unpin from Mission Control" : "Pin to Mission Control"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void daemon.archiveTask(task.id)}>
              <Archive className="size-3.5 opacity-70" />
              Archive task
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                if (window.confirm(`Delete "${label}"? This cannot be undone.`)) {
                  void daemon.deleteTask(task.id);
                }
              }}
            >
              <Trash2 className="size-3.5 opacity-70" />
              Delete task
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </div>
  );
}

export interface SidebarTaskRowProps {
  task: TaskInfo;
  state: SidebarTaskState;
  depth: number;
  active: boolean;
  childCount: number;
  expanded: boolean;
  pinned: boolean;
  nowSec: number;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onPin: (id: string) => void;
}

export const SidebarTaskRow = memo(function SidebarTaskRow({
  task,
  state,
  depth,
  active,
  childCount,
  expanded,
  pinned,
  nowSec,
  onOpen,
  onToggle,
  onPin,
}: SidebarTaskRowProps) {
  const label = taskLabel(task);
  const meta = SIDEBAR_STATE_META[state];
  const StateIcon = STATE_ICON[meta.icon];
  const receded = state === "snoozed" || state === "settled" || state === "done";

  return (
    <div
      className={cn("group/row relative", depth > 0 && "border-l border-primary/25 pl-[3px]")}
      style={depth > 0 ? { marginLeft: depth * SIDEBAR_INDENT_PX } : undefined}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-task-id={task.id}
            data-task-state={state}
            onClick={() => onOpen(task.id)}
            aria-label={`Open task: ${label}`}
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left transition-colors",
              TWISTY_LANE,
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            {/* No spacer when a row has no glyph: a silent row starts at the
                lane edge rather than reserving an empty icon column. Most rows
                are silent by design, so reserving it indented the whole list
                for the sake of a minority. */}
            {meta.rowGlyph && (
              <StateIcon
                aria-hidden
                data-task-glyph={state}
                className={cn(
                  "size-3.5 shrink-0",
                  meta.toneClass,
                  meta.live && "animate-[spin_3s_linear_infinite] motion-reduce:animate-none",
                )}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] leading-none",
                active ? "font-medium text-foreground" : meta.titleClass,
                depth > 0 && "text-[12px]",
              )}
            >
              {label}
            </span>
            <span className="relative ml-auto flex h-6 w-[4.5rem] shrink-0 items-center justify-end gap-1.5 pl-1 transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0">
              {childCount > 0 && (
                <span className="tnum text-[10px] text-muted-foreground/45">{childCount}</span>
              )}
              <AgentLogo
                agentId={task.agent}
                displayName={task.agent}
                className={cn("size-3.5", receded && "opacity-40 grayscale")}
              />
              {state === "snoozed" ? (
                <span className="tnum text-[11px] text-info/80">
                  {snoozeWakeLabel(task.snoozedUntil!, nowSec)}
                </span>
              ) : (
                <span className="tnum text-[11px] text-muted-foreground/50">
                  {meta.live ? <LiveElapsed since={task.updatedAt} /> : elapsed(task.updatedAt)}
                </span>
              )}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" sideOffset={10} className="p-2">
          <SidebarTaskTooltipBody
            task={task}
            state={state}
            childCount={childCount}
            nowSec={nowSec}
          />
        </TooltipContent>
      </Tooltip>

      {childCount > 0 && (
        <button
          type="button"
          data-expand={task.id}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${childCount} subtask${childCount === 1 ? "" : "s"} of ${label}`}
          onClick={() => onToggle(task.id)}
          className="absolute left-0.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      )}

      <RowActions task={task} state={state} pinned={pinned} onPin={onPin} />
    </div>
  );
});
