import {
  latestPendingPermission,
  prunePermissionCache,
  type PermissionUpdate,
} from "@/lib/sessionPermissions";
import type { SessionUpdate } from "@/protocol";
import type { TaskInfo, TaskStatus } from "@/protocol";

export interface AttentionItem {
  task: TaskInfo;
  reason: string;
  priority: number;
  permission?: PermissionUpdate;
}

export type RailFilterMode = "attention" | "running" | "all";
export type RailSortMode = "updated" | "created" | "status" | "project";

export const STATUS_RANK: Record<TaskStatus, number> = {
  needs_review: 1,
  blocked: 2,
  interrupted: 3,
  running: 4,
  idle: 5,
  queued: 6,
  done: 7,
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  needs_review: "Needs review",
  blocked: "Blocked",
  interrupted: "Interrupted",
  running: "Running",
  idle: "Idle",
  queued: "Queued",
  done: "Done",
};

export function taskStatusRank(task: TaskInfo, permission?: PermissionUpdate): number {
  if (permission) return 0;
  return STATUS_RANK[task.status];
}

export function buildAttentionQueue(
  tasks: TaskInfo[],
  sessionUpdates: Record<string, SessionUpdate[]>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  prunePermissionCache(new Set(tasks.map((task) => task.id)));
  for (const task of tasks) {
    const perm = latestPendingPermission(task.id, sessionUpdates[task.id]);
    if (perm) {
      items.push({ permission: perm, priority: 0, reason: perm.title, task });
    } else if (task.status === "needs_review") {
      items.push({ priority: 1, reason: "finished — review changes", task });
    } else if (task.status === "blocked") {
      items.push({ priority: 2, reason: task.blockedReason ?? "blocked", task });
    } else if (task.status === "interrupted") {
      items.push({ priority: 3, reason: "session lost on daemon restart", task });
    }
  }
  return items.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.task.updatedAt - a.task.updatedAt ||
      a.task.id.localeCompare(b.task.id),
  );
}

export function selectRailTasks(
  tasks: readonly TaskInfo[],
  attentionById: ReadonlyMap<string, AttentionItem>,
  filter: RailFilterMode,
  query: string,
  sort: RailSortMode,
): TaskInfo[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = tasks.filter((task) => {
    if (task.status === "done") return false;
    if (filter === "attention" && !attentionById.has(task.id)) return false;
    if (filter === "running" && task.status !== "running") return false;
    return (
      !normalizedQuery ||
      task.prompt.toLocaleLowerCase().includes(normalizedQuery) ||
      task.project.toLocaleLowerCase().includes(normalizedQuery)
    );
  });

  return filtered.sort((a, b) => {
    if (sort === "created") {
      return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
    }
    if (sort === "project") {
      return (
        a.project.localeCompare(b.project) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
      );
    }
    if (sort === "status") {
      const aRank = taskStatusRank(a, attentionById.get(a.id)?.permission);
      const bRank = taskStatusRank(b, attentionById.get(b.id)?.permission);
      return aRank - bRank || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
    }
    return (
      b.updatedAt - a.updatedAt ||
      taskStatusRank(a, attentionById.get(a.id)?.permission) -
        taskStatusRank(b, attentionById.get(b.id)?.permission) ||
      a.id.localeCompare(b.id)
    );
  });
}

export interface RailPartition {
  needsYou: TaskInfo[];
  working: TaskInfo[];
  snoozed: TaskInfo[];
  settled: TaskInfo[];
  wokeIds: string[];
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidSnooze(task: TaskInfo): boolean {
  return isValidTimestamp(task.snoozedUntil) && isValidTimestamp(task.snoozedAt);
}

function shelfSort(tasks: TaskInfo[]): TaskInfo[] {
  return tasks.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function partitionRailTasks(
  tasks: readonly TaskInfo[],
  attentionById: ReadonlyMap<string, AttentionItem>,
  nowSeconds: number,
): RailPartition {
  const needsYou: TaskInfo[] = [];
  const working: TaskInfo[] = [];
  const snoozed: TaskInfo[] = [];
  const settled: TaskInfo[] = [];
  const wokeIds: string[] = [];

  for (const task of tasks) {
    if (task.status === "done") continue;

    if (isValidSnooze(task) && task.snoozedUntil! > nowSeconds) {
      snoozed.push(task);
      continue;
    }

    if (task.settledOverride === true) {
      settled.push(task);
      continue;
    }

    if (attentionById.has(task.id)) {
      needsYou.push(task);
      if (isValidSnooze(task) && task.snoozedUntil! <= nowSeconds) {
        wokeIds.push(task.id);
      }
      continue;
    }

    if (isValidSnooze(task) && task.snoozedUntil! <= nowSeconds) {
      wokeIds.push(task.id);
      working.push(task);
      continue;
    }

    working.push(task);
  }

  return {
    needsYou: shelfSort(needsYou),
    working: shelfSort(working),
    snoozed: shelfSort(snoozed),
    settled: shelfSort(settled),
    wokeIds: wokeIds.sort(),
  };
}
