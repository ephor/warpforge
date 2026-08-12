import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, Flag, Play, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PRIORITY_LABEL, priorityTone, SOURCE_LABEL, SourceDot, STATUS_META } from "./labels";
import type { WorkItem } from "./types";

function formatTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

/**
 * Column definitions only. Sorting, paging and filtering are the daemon's job
 * (see `BacklogView`), so nothing here declares a sort or filter function —
 * `enableSorting` merely says whether the header offers the control.
 *
 * A module constant, deliberately: TanStack rebuilds its whole column and cell
 * model whenever this array's identity changes, so a `columns` recreated per
 * render re-renders every cell on every keystroke. The row actions therefore
 * arrive through `table.options.meta` (read at render time, no rebuild) rather
 * than being closed over here.
 */
export const backlogColumns: ColumnDef<WorkItem>[] = [
  {
    id: "number",
    accessorKey: "number",
    header: "#",
    cell: ({ row }) => (
      <span className="tnum text-xs text-muted-foreground">{row.original.number}</span>
    ),
    meta: { label: "Number" },
    size: 72,
  },
  {
    id: "title",
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-2">
        <SourceDot source={row.original.source} />
        <span className="truncate text-[13px] font-medium text-foreground">
          {row.original.title}
        </span>
      </div>
    ),
    meta: { label: "Title" },
    // No `size`: the title column absorbs the leftover width.
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const meta = STATUS_META[row.original.status];
      return (
        <Badge variant="outline" className={cn(meta.className, "rounded-md")}>
          {meta.label}
        </Badge>
      );
    },
    meta: { label: "Status" },
    size: 120,
  },
  {
    id: "priority",
    accessorKey: "priority",
    header: "Priority",
    cell: ({ row }) => {
      const priority = row.original.priority;
      return (
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            priority === "none" ? "text-muted-foreground/60" : priorityTone(priority),
          )}
        >
          <Flag className="size-3" />
          {PRIORITY_LABEL[priority]}
        </span>
      );
    },
    meta: { label: "Priority" },
    size: 110,
  },
  {
    id: "source",
    accessorKey: "source",
    header: "Source",
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SourceDot source={row.original.source} />
        {SOURCE_LABEL[row.original.source]}
      </span>
    ),
    meta: { label: "Source" },
    size: 110,
  },
  {
    id: "assignee",
    accessorKey: "assignee",
    header: "Assignee",
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <UserRound className="size-3" />
        {row.original.assignee || "Unassigned"}
      </span>
    ),
    meta: { label: "Assignee" },
    size: 140,
  },
  {
    id: "updatedAt",
    accessorKey: "updatedAt",
    header: "Updated",
    cell: ({ row }) => (
      <span
        className="tnum shrink-0 text-xs text-muted-foreground"
        title={new Date(row.original.updatedAt).toLocaleString()}
      >
        {formatTime(row.original.updatedAt)} ago
      </span>
    ),
    meta: { label: "Updated" },
    size: 100,
  },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row, table }) => {
      const item = row.original;
      const { onOpenTask, onStartTask } = table.options.meta ?? {};
      return (
        <div className="flex items-center justify-end gap-0.5">
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
            ? onOpenTask && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenTask(item.taskId as string)}
                >
                  Open task
                </Button>
              )
            : onStartTask && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  onClick={() => onStartTask(item)}
                  title="Start an agent task from this item"
                >
                  <Play className="size-3.5" />
                  <span className="sr-only">Start task</span>
                </Button>
              )}
        </div>
      );
    },
    meta: { label: "Actions" },
    enableSorting: false,
    enableHiding: false,
    size: 96,
  },
];
