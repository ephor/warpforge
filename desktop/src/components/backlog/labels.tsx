/** How the backlog's enum values are named and coloured, in one place. */
import { CircleCheck, CircleDot, Clock, List } from "lucide-react";

import { cn } from "@/lib/utils";

import type { WorkItemPriority, WorkItemSource, WorkItemStatus } from "./types";

export const STATUS_META: Record<
  WorkItemStatus,
  { label: string; className: string; icon: React.FC<{ className?: string }> }
> = {
  todo: {
    label: "To do",
    className: "border-border bg-secondary text-secondary-foreground",
    icon: CircleDot,
  },
  in_progress: {
    label: "In progress",
    className: "border-primary/40 bg-primary/10 text-primary",
    icon: List,
  },
  waiting: { label: "Waiting", className: "border-warn/40 bg-warn/10 text-warn", icon: Clock },
  done: { label: "Done", className: "border-ok/40 bg-ok/10 text-ok", icon: CircleCheck },
  cancelled: {
    label: "Cancelled",
    className: "border-muted bg-muted/40 text-muted-foreground",
    icon: CircleDot,
  },
};

export const PRIORITY_LABEL: Record<WorkItemPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

export const SOURCE_LABEL: Record<WorkItemSource, string> = {
  local: "Local",
  github: "GitHub",
  linear: "Linear",
};

export const SOURCE_DOT: Record<WorkItemSource, string> = {
  local: "bg-muted-foreground/60",
  github: "bg-ok",
  linear: "bg-primary",
};

export function priorityTone(priority: WorkItemPriority): string {
  switch (priority) {
    case "urgent":
      return "text-destructive";
    case "high":
      return "text-warn";
    case "medium":
      return "text-ok";
    default:
      return "text-muted-foreground";
  }
}

export function SourceDot({ source }: { source: WorkItemSource }) {
  return (
    <span
      title={source}
      className={cn("size-1.5 shrink-0 rounded-full", SOURCE_DOT[source])}
      aria-hidden
    />
  );
}
