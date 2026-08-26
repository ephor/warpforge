import { ExternalLink, Flag, Play, UserRound } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { openExternalLink } from "@/lib/externalLinks";
import { cn } from "@/lib/utils";

import { PRIORITY_LABEL, priorityTone, SOURCE_LABEL, SourceDot, STATUS_META } from "./labels";
import type { WorkItem } from "./types";

export interface BacklogRowActions {
  onOpen: (item: WorkItem) => void;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
  /** Set of task IDs the daemon still knows about. Used to downgrade a stale
   *  "Open task" link to "Start task" when the referenced task was deleted. */
  liveTaskIds?: ReadonlySet<string>;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/**
 * One backlog item on one line. Every field after the title has a fixed width
 * so the whole list reads down its columns instead of ragging around each
 * title's length — the width is there, and stacking the metadata under the
 * title wasted it. Narrow windows drop the least useful columns first.
 *
 * The row itself is the button that opens the details; the tracker link and
 * the task action sit outside it, so clicking them is not clicking the row.
 */
export const BacklogRow = React.memo(function BacklogRow({
  item,
  actions,
}: {
  item: WorkItem;
  actions: BacklogRowActions;
}) {
  const status = STATUS_META[item.status];
  const StatusIcon = status.icon;

  return (
    <div className="group flex h-9 min-w-0 items-center border-b border-border/40 pr-2 hover:bg-secondary/40">
      <button
        type="button"
        onClick={() => actions.onOpen(item)}
        title={item.title}
        className="flex h-full min-w-0 flex-1 items-center gap-3 pl-3 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <SourceDot source={item.source} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{item.title}</span>

        <span
          className={cn(
            "hidden w-[7.5rem] shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[11px] sm:inline-flex",
            status.className,
          )}
        >
          <StatusIcon className="size-3 shrink-0" />
          <span className="truncate">{status.label}</span>
        </span>

        <span
          className={cn(
            "hidden w-16 shrink-0 items-center gap-1 text-[11px] lg:inline-flex",
            item.priority === "none" ? "text-muted-foreground/50" : priorityTone(item.priority),
          )}
        >
          <Flag className="size-3 shrink-0" />
          <span className="truncate">{PRIORITY_LABEL[item.priority]}</span>
        </span>

        <span className="hidden w-32 shrink-0 truncate text-[11px] text-muted-foreground xl:block">
          {SOURCE_LABEL[item.source]}
          {item.number && <span className="tnum text-muted-foreground/60"> {item.number}</span>}
        </span>

        <span className="hidden w-28 shrink-0 items-center gap-1 text-[11px] text-muted-foreground md:inline-flex">
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{item.assignee || "Unassigned"}</span>
        </span>

        <span
          className="tnum w-16 shrink-0 text-right text-[11px] text-muted-foreground"
          title={new Date(item.updatedAt).toLocaleString()}
        >
          {relativeTime(item.updatedAt)}
        </span>
      </button>

      {/* Reserved width, not conditional rendering: an action appearing on
          hover must not shift the columns to its left. */}
      <div className="flex w-[4.5rem] shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {item.url && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title={`Open ${item.number} in ${item.source}`}
            onClick={() => void openExternalLink(item.url!)}
          >
            <ExternalLink className="size-3.5" />
            <span className="sr-only">Open in tracker</span>
          </Button>
        )}
        {item.taskId &&
        (actions.liveTaskIds === undefined || actions.liveTaskIds.has(item.taskId))
          ? actions.onOpenTask && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => actions.onOpenTask?.(item.taskId as string)}
              >
                Open task
              </Button>
            )
          : actions.onStartTask && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => actions.onStartTask?.(item)}
                title="Start an agent task from this item"
              >
                <Play className="size-3.5" />
                <span className="sr-only">Start task</span>
              </Button>
            )}
      </div>
    </div>
  );
});
