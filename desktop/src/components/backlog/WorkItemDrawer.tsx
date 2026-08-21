import * as SelectPrimitive from "@radix-ui/react-select";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Flag, Play, UserRound, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { daemon } from "@/daemon";
import { cn } from "@/lib/utils";

import { PRIORITY_LABEL, SOURCE_LABEL, SourceDot, STATUS_META } from "./labels";
import {
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
} from "./types";

export interface WorkItemDrawerProps {
  item: WorkItem | null;
  onClose: () => void;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
}

/**
 * Details for one backlog item, in a sheet over the list rather than a page of
 * its own — closing it leaves the list exactly as it was, scroll and filters
 * included, which is the whole reason the row no longer navigates away.
 */
export function WorkItemDrawer({ item, onClose, onStartTask, onOpenTask }: WorkItemDrawerProps) {
  return (
    <Dialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        hideClose
        className="fixed inset-y-0 right-0 left-auto top-0 flex h-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 bg-popover p-0 shadow-2xl data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 w-[min(28rem,calc(100vw-3rem))]"
      >
        {item && <WorkItemDetails item={item} onClose={onClose} {...{ onOpenTask, onStartTask }} />}
      </DialogContent>
    </Dialog>
  );
}

function WorkItemDetails({
  item,
  onClose,
  onStartTask,
  onOpenTask,
}: {
  item: WorkItem;
  onClose: () => void;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const queryClient = useQueryClient();
  // Optimistic locally so the chip answers the click; the listing refetch
  // behind it is what makes the change durable.
  const [status, setStatus] = React.useState<WorkItemStatus>(item.status);
  const [priority, setPriority] = React.useState<WorkItemPriority>(item.priority);
  const statusMeta = STATUS_META[status];
  const StatusIcon = statusMeta.icon;

  // A tracker owns the status of the issues it sent us: writing one here would
  // be overwritten by the next sync, so the chip is a chip, not a control.
  const statusIsRemote = item.source !== "local";

  const save = React.useCallback(
    async (patch: { status?: WorkItemStatus; priority?: WorkItemPriority }) => {
      const previous = { priority, status };
      if (patch.status) setStatus(patch.status);
      if (patch.priority) setPriority(patch.priority);
      try {
        await daemon.updateBacklog({ itemId: item.id, project: item.project, ...patch });
        await queryClient.invalidateQueries({ queryKey: ["backlog", item.project] });
      } catch (error) {
        setStatus(previous.status);
        setPriority(previous.priority);
        toast.error("Could not save the work item", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [item.id, item.project, priority, queryClient, status],
  );

  return (
    <>
      <DialogDescription className="sr-only">
        Details for work item {item.number ?? item.title}
      </DialogDescription>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <SourceDot source={item.source} />
        <span className="truncate text-xs text-muted-foreground">
          {SOURCE_LABEL[item.source]}
          {item.number && <span className="tnum"> · {item.number}</span>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {item.url && (
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              title="Open in tracker"
            >
              <a href={item.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
                <span className="sr-only">Open in tracker</span>
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label="Close work item"
            title="Close (Esc)"
            type="button"
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <DialogTitle className="text-base font-medium leading-snug text-foreground">
          {item.title}
        </DialogTitle>

        <div className="flex flex-wrap items-center gap-1.5">
          {statusIsRemote ? (
            <span
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs",
                statusMeta.className,
              )}
              title={`${SOURCE_LABEL[item.source]} owns this status`}
            >
              <StatusIcon className="size-3.5" />
              {item.remoteStatus || statusMeta.label}
            </span>
          ) : (
            <FieldChip
              ariaLabel="Status"
              value={status}
              options={WORK_ITEM_STATUSES.map((value) => ({
                value,
                label: STATUS_META[value].label,
              }))}
              onValueChange={(next) => void save({ status: next })}
              triggerClassName={cn("font-medium", statusMeta.className)}
            >
              <StatusIcon className="size-3.5 shrink-0" />
              <span className="truncate">{statusMeta.label}</span>
            </FieldChip>
          )}

          <FieldChip
            ariaLabel="Priority"
            value={priority}
            options={WORK_ITEM_PRIORITIES.map((value) => ({
              value,
              label: PRIORITY_LABEL[value],
            }))}
            onValueChange={(next) => void save({ priority: next })}
            triggerClassName="border-transparent bg-transparent text-muted-foreground hover:bg-secondary"
          >
            <Flag className="size-3.5 shrink-0" />
            <span className="truncate">{PRIORITY_LABEL[priority]}</span>
          </FieldChip>

          <span className="inline-flex h-7 items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <UserRound className="size-3.5" />
            {item.assignee || "Unassigned"}
          </span>
        </div>

        {item.body ? (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
            {item.body}
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground/60">No description.</p>
        )}

        <dl className="mt-auto grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 pt-2 text-[11px] text-muted-foreground">
          <dt>Created</dt>
          <dd className="tnum">{new Date(item.createdAt).toLocaleString()}</dd>
          <dt>Updated</dt>
          <dd className="tnum">{new Date(item.updatedAt).toLocaleString()}</dd>
        </dl>
      </div>

      <footer className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border/60 px-4">
        {item.taskId ? (
          <Button
            type="button"
            size="sm"
            className="h-8"
            onClick={() => onOpenTask?.(item.taskId as string)}
            disabled={!onOpenTask}
          >
            Open task
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => onStartTask?.(item)}
            disabled={!onStartTask}
          >
            <Play className="size-3.5" />
            Start task
          </Button>
        )}
      </footer>
    </>
  );
}

/** Chip trigger styled like the row's cell, opening the standard Select. */
function FieldChip<T extends string>({
  ariaLabel,
  value,
  options,
  triggerClassName,
  onValueChange,
  children,
}: {
  ariaLabel: string;
  value: T;
  options: { value: T; label: string }[];
  triggerClassName?: string;
  onValueChange: (value: T) => void;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as T)}>
      <SelectPrimitive.Trigger
        type="button"
        aria-label={ariaLabel}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs transition-colors",
          "hover:text-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground",
          triggerClassName,
        )}
      >
        {children}
      </SelectPrimitive.Trigger>
      <SelectContent className="min-w-[10rem]" align="start" sideOffset={4}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
