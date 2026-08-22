/**
 * Normalized backlog work items. Every source (local, Linear, GitHub) renders
 * through this one shape — the list knows nothing about providers.
 */
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

/** How each sort key reads in the toolbar. */
export const BACKLOG_SORT_LABEL: Record<BacklogSortKey, string> = {
  number: "Number",
  title: "Title",
  status: "Status",
  priority: "Priority",
  source: "Source",
  assignee: "Assignee",
  updatedAt: "Updated",
};

/**
 * Everything the daemon needs to answer the listing. Sorting and filtering
 * happen server-side, so this object *is* the query — it goes into the React
 * Query key verbatim, and any change to it is a new fetch from the top. The
 * page is deliberately absent: it belongs to the infinite query's cursor, not
 * to view state anyone can set.
 */
export interface BacklogParams {
  pageSize: number;
  sortBy: BacklogSortKey;
  sortDesc: boolean;
  search: string;
  status: WorkItemStatus | null;
  source: WorkItemSource | null;
  priority: WorkItemPriority | null;
  /**
   * Whoever the item is assigned to, matched as a substring by both storage
   * backends. Holds the assignee exactly as the tracker wrote it — a GitHub
   * login, a Linear display name — so it is a plain string rather than an
   * enum like the other filters.
   */
  assignee: string | null;
}

export const DEFAULT_BACKLOG_PARAMS: BacklogParams = {
  pageSize: 30,
  sortBy: "updatedAt",
  sortDesc: true,
  search: "",
  status: null,
  source: null,
  priority: null,
  assignee: null,
};

/** Whether anything narrows the listing, i.e. whether "Reset" is worth showing. */
export function hasActiveFilters(params: BacklogParams): boolean {
  return (
    params.search !== "" ||
    params.status !== null ||
    params.source !== null ||
    params.priority !== null ||
    params.assignee !== null
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
