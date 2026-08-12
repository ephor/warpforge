/**
 * Normalized backlog work items. Every source (local, Linear, GitHub) renders
 * through this one shape — the table knows nothing about providers.
 */
import type { RowData } from "@tanstack/react-table";

import type { BacklogItem } from "@/protocol";

export type WorkItemSource = "local" | "linear" | "github";

export type WorkItemStatus = "todo" | "in_progress" | "waiting" | "done" | "cancelled";

export type WorkItemPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface WorkItem {
  /** Stable within its source. Rendered id prefixes the source so mixed tables stay unique. */
  id: string;
  /**
   * Rendered identifier. Local items use `#1/#2…`; external sources use
   * their native numbering (GHL-123, #456). Empty for local until stored.
   */
  number?: string;
  title: string;
  source: WorkItemSource;
  project: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  createdAt: number;
  updatedAt: number;
  /** Short human label of the source (repo/team). Null for local. */
  sourceLabel?: string | null;
  /** External URL, if the item lives in a remote tracker. */
  url?: string | null;
  /** Notes body. Local items support free text; external sources mirror description. */
  body?: string | null;
  /**
   * Provider-native status label from the last sync. GitHub's status model is
   * project-specific, so this is shown as-is and never written back.
   */
  remoteStatus?: string | null;
  /** Daemon task this item became, if it was started. */
  taskId?: string | null;
  assignee?: string | null;
}

export const WORK_ITEM_SOURCES: readonly WorkItemSource[] = ["local", "linear", "github"] as const;

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
] as const;

export const WORK_ITEM_PRIORITIES: readonly WorkItemPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

/** Columns the daemon knows how to sort on (`backlog::page` / `Store::list_backlog`). */
export type BacklogSortKey =
  | "number"
  | "title"
  | "status"
  | "priority"
  | "source"
  | "assignee"
  | "updatedAt";

/**
 * Everything the daemon needs to answer one page. Sorting, paging and filtering
 * all happen server-side, so this object *is* the query — it goes into the
 * React Query key verbatim, and any change to it is a new fetch.
 */
export interface BacklogParams {
  page: number;
  pageSize: number;
  sortBy: BacklogSortKey;
  sortDesc: boolean;
  search: string;
  status: WorkItemStatus | null;
  source: WorkItemSource | null;
  priority: WorkItemPriority | null;
}

export const DEFAULT_BACKLOG_PARAMS: BacklogParams = {
  page: 0,
  pageSize: 10,
  sortBy: "updatedAt",
  sortDesc: true,
  search: "",
  status: null,
  source: null,
  priority: null,
};

/** Whether anything narrows the listing, i.e. whether "Reset" is worth showing. */
export function hasActiveFilters(params: BacklogParams): boolean {
  return (
    params.search !== "" ||
    params.status !== null ||
    params.source !== null ||
    params.priority !== null
  );
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Wire row → table row. The daemon types these as plain strings. */
export function toWorkItem(item: BacklogItem): WorkItem {
  return {
    id: item.id,
    number: item.externalId ?? `#${item.number}`,
    title: item.title,
    source: oneOf(WORK_ITEM_SOURCES, item.source, "local"),
    project: item.project,
    status: oneOf(WORK_ITEM_STATUSES, item.status, "todo"),
    priority: oneOf(WORK_ITEM_PRIORITIES, item.priority, "none"),
    createdAt: item.createdAt * 1000,
    updatedAt: item.updatedAt * 1000,
    sourceLabel: item.source === "local" ? "Local" : item.source,
    url: item.url ?? null,
    body: item.body,
    remoteStatus: item.remoteStatus ?? null,
    taskId: item.taskId ?? null,
    assignee: item.assignee ?? null,
  };
}

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Human label, used by the column-visibility menu. */
    label?: string;
  }

  /**
   * Row actions travel here rather than in a closure inside the column defs,
   * which lets `backlogColumns` stay a module constant. TanStack reads
   * `options.meta` on every render but never rebuilds the table for it.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    /** Start (or resume) the agent task backing this item. */
    onStartTask?: (item: WorkItem) => void;
    /** Open the daemon task this item already became. */
    onOpenTask?: (taskId: string) => void;
  }
}
