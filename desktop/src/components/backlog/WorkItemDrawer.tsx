import * as SelectPrimitive from "@radix-ui/react-select";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Flag, Play, UserRound, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { daemon } from "@/daemon";
import { openExternalLink } from "@/lib/externalLinks";
import { statusLabel, taskStatusVisual } from "@/lib/statusMeta";
import { inlineHtmlImages } from "@/lib/trackerMarkdown";
import { cn } from "@/lib/utils";
import type { TaskInfo } from "@/protocol";

import { relativeTime } from "./BacklogRow";
import { PRIORITY_LABEL, SOURCE_LABEL, SourceDot, STATUS_META } from "./labels";
import { TrackerImage } from "./TrackerImage";
import {
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
} from "./types";
import { useMe } from "./use-tracker";

/** Radix Select forbids an empty item value, so "nobody" needs a sentinel. */
const UNASSIGNED = "__unassigned__";

export interface WorkItemDrawerProps {
  item: WorkItem | null;
  onClose: () => void;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
  /** The task this item became, when the daemon still has it. */
  linkedTask?: TaskInfo | null;
}

/**
 * Details for one backlog item, in a sheet over the list rather than a page of
 * its own — closing it leaves the list exactly as it was, scroll and filters
 * included, which is the whole reason the row no longer navigates away.
 */
export function WorkItemDrawer({
  item,
  onClose,
  onStartTask,
  onOpenTask,
  linkedTask,
}: WorkItemDrawerProps) {
  return (
    <Dialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        hideClose
        className="fixed inset-y-0 right-0 left-auto top-0 flex h-full w-[min(56rem,calc(100vw-4rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 bg-popover p-0 shadow-2xl data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
      >
        {item && (
          <WorkItemDetails
            item={item}
            onClose={onClose}
            linkedTask={linkedTask}
            onOpenTask={onOpenTask}
            onStartTask={onStartTask}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkItemDetails({
  item,
  onClose,
  onStartTask,
  onOpenTask,
  linkedTask,
}: {
  item: WorkItem;
  onClose: () => void;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
  linkedTask?: TaskInfo | null;
}) {
  const queryClient = useQueryClient();
  // Optimistic locally so the chip answers the click; the listing refetch
  // behind it is what makes the change durable.
  const [status, setStatus] = React.useState<WorkItemStatus>(item.status);
  const [priority, setPriority] = React.useState<WorkItemPriority>(item.priority);
  const [assignee, setAssignee] = React.useState<string | null>(item.assignee ?? null);
  const me = useMe();
  const statusMeta = STATUS_META[status];
  const StatusIcon = statusMeta.icon;

  // A tracker owns the status of the issues it sent us: writing one here would
  // be overwritten by the next sync, so the chip is a chip, not a control.
  const statusIsRemote = item.source !== "local";

  const save = React.useCallback(
    async (patch: {
      status?: WorkItemStatus;
      priority?: WorkItemPriority;
      /** `""` unassigns; an absent field leaves the assignee alone. */
      assignee?: string;
    }) => {
      const previous = { assignee, priority, status };
      if (patch.status) setStatus(patch.status);
      if (patch.priority) setPriority(patch.priority);
      if (patch.assignee !== undefined) setAssignee(patch.assignee || null);
      try {
        await daemon.updateBacklog({ itemId: item.id, project: item.project, ...patch });
        await queryClient.invalidateQueries({ queryKey: ["backlog", item.project] });
      } catch (error) {
        setStatus(previous.status);
        setPriority(previous.priority);
        setAssignee(previous.assignee);
        toast.error("Could not save the work item", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [assignee, item.id, item.project, priority, queryClient, status],
  );

  return (
    <>
      <DialogDescription className="sr-only">
        Details for work item {item.number ?? item.title}
      </DialogDescription>
      {/* The title is what the panel is about, so it is the panel's heading;
          which tracker it came from is metadata, and reads with the rest of it
          below. */}
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border/60 px-6 py-2">
        <DialogTitle
          className="min-w-0 flex-1 text-base font-medium leading-snug text-foreground"
          title={item.title}
        >
          {item.title}
        </DialogTitle>
        <div className="flex shrink-0 items-center gap-0.5">
          {item.url && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              title="Open in tracker"
              onClick={() => void openExternalLink(item.url!)}
            >
              <ExternalLink className="size-4" />
              <span className="sr-only">Open in tracker</span>
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

      {/* The panel is wide so a long issue body has room, but prose is capped
          at a readable measure rather than run edge to edge. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
            <SourceDot source={item.source} />
            {SOURCE_LABEL[item.source]}
            {item.number && <span className="tnum"> · {item.number}</span>}
          </span>
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

          {/* A tracker owns who its issues are on — a sync would overwrite an
              edit made here — so only a local item gets the control. */}
          {item.source === "local" && me ? (
            <FieldChip
              ariaLabel="Assignee"
              value={assignee ?? UNASSIGNED}
              options={[
                { value: me, label: me },
                { value: UNASSIGNED, label: "Unassigned" },
              ]}
              onValueChange={(next) => void save({ assignee: next === UNASSIGNED ? "" : next })}
              triggerClassName="border-transparent bg-transparent text-muted-foreground hover:bg-secondary"
            >
              <UserRound className="size-3.5 shrink-0" />
              <span className="truncate">{assignee ?? "Unassigned"}</span>
            </FieldChip>
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <UserRound className="size-3.5" />
              {item.assignee || "Unassigned"}
            </span>
          )}
        </div>

        {item.body ? (
          // Tracker descriptions are markdown; rendering them as plain text
          // turned every link and checklist in them into noise.
          <Markdown
            density="comfortable"
            renderImage={TrackerImage}
            className="max-w-[80ch] text-foreground/90"
          >
            {inlineHtmlImages(item.body)}
          </Markdown>
        ) : (
          <p className="text-[13px] text-muted-foreground/60">No description.</p>
        )}

        {linkedTask && <LinkedTaskSummary task={linkedTask} />}
      </div>

      {/* Timestamps ride in the footer rather than closing the description:
          they are the least-read thing here, and putting them on the action
          bar's empty half costs no vertical space at all. */}
      <footer className="flex h-14 shrink-0 items-center justify-between gap-4 border-t border-border/60 px-6">
        <dl className="flex min-w-0 flex-wrap items-baseline gap-x-4 text-[11px] text-muted-foreground">
          <div className="flex items-baseline gap-1.5">
            <dt>Created</dt>
            <dd className="tnum" title={new Date(item.createdAt).toLocaleString()}>
              {relativeTime(item.createdAt)}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt>Updated</dt>
            <dd className="tnum" title={new Date(item.updatedAt).toLocaleString()}>
              {relativeTime(item.updatedAt)}
            </dd>
          </div>
        </dl>
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

const TASK_TONE: Record<string, string> = {
  destructive: "bg-destructive",
  neutral: "bg-muted-foreground/60",
  ok: "bg-ok",
  warn: "bg-warn",
};

/**
 * What became of this item, when it became something. Enough to decide whether
 * opening the task is worth the trip; the task screen has the rest.
 */
function LinkedTaskSummary({ task }: { task: TaskInfo }) {
  const visual = taskStatusVisual(task.status);
  return (
    <div className="flex min-w-0 max-w-[80ch] items-center gap-2 rounded-md border border-border/70 bg-background/30 px-3 py-2 text-xs">
      <span className={cn("size-1.5 shrink-0 rounded-full", TASK_TONE[visual.tone])} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">{task.title || task.prompt}</span>
      <span className="shrink-0 text-muted-foreground">{statusLabel(task.status)}</span>
      {task.filesChanged > 0 && (
        <span className="tnum shrink-0 text-muted-foreground/70">
          {task.filesChanged} file{task.filesChanged === 1 ? "" : "s"}
        </span>
      )}
      <span className="tnum shrink-0 text-muted-foreground/70">
        {relativeTime(task.updatedAt * 1000)}
      </span>
    </div>
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
