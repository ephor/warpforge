import { ExternalLink, Flag, Play, UserRound } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PRIORITY_LABEL, priorityTone, SOURCE_LABEL, SourceDot, STATUS_META } from "./labels";
import type { WorkItem } from "./types";

export interface BacklogRowActions {
  onOpen: (item: WorkItem) => void;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/**
 * One backlog item as two lines: what it is, then how it is filed. The whole
 * row is the button that opens the details drawer; the tracker link and the
 * task action sit outside it, so a click on them is not a click on the row.
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
    <div className="group flex min-w-0 items-center gap-2 border-b border-border/50 pr-2 hover:bg-secondary/40">
      <button
        type="button"
        onClick={() => actions.onOpen(item)}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SourceDot source={item.source} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {item.title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <UserRound className="size-3" />
            {item.assignee || "Unassigned"}
          </span>
          <span
            className="tnum shrink-0 text-[11px] text-muted-foreground"
            title={new Date(item.updatedAt).toLocaleString()}
          >
            {relativeTime(item.updatedAt)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px",
              status.className,
            )}
          >
            <StatusIcon className="size-3" />
            {status.label}
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1",
              item.priority === "none" ? "text-muted-foreground/60" : priorityTone(item.priority),
            )}
          >
            <Flag className="size-3" />
            {PRIORITY_LABEL[item.priority]}
          </span>
          <span className="shrink-0">{SOURCE_LABEL[item.source]}</span>
          {item.number && <span className="tnum shrink-0 truncate">{item.number}</span>}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {item.url && (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title={`Open ${item.number} in ${item.source}`}
          >
            <a href={item.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open in tracker</span>
            </a>
          </Button>
        )}
        {item.taskId
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
