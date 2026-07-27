import type { TaskInfo, TaskStatus } from "@/protocol";

export type BoardLane = "queue" | "active" | "review" | "history";

export interface TaskTree {
  task: TaskInfo;
  children: TaskTree[];
}

export interface TaskGroupIndex {
  forest: TaskTree[];
  rootByTaskId: Map<string, TaskTree>;
}

export interface TaskGroupCounts {
  blocked: number;
  done: number;
  review: number;
  running: number;
}

export type TaskLifecycle = "active" | "later" | "handled";
export type BoardLifecycleFilter = "all" | "attention" | "later" | "handled";

export interface TaskLifecycleCounts {
  handled: number;
  later: number;
}

const lanePriority: Record<BoardLane, number> = {
  active: 3,
  history: 0,
  queue: 1,
  review: 2,
};

export function statusLane(status: TaskStatus): BoardLane {
  if (status === "needs_review" || status === "blocked" || status === "interrupted") {
    return "review";
  }
  if (status === "running" || status === "idle") {
    return "active";
  }
  if (status === "queued") {
    return "queue";
  }
  return "history";
}

export function taskLifecycle(task: TaskInfo, nowSeconds: number): TaskLifecycle {
  if (
    typeof task.snoozedAt === "number" &&
    Number.isFinite(task.snoozedAt) &&
    task.snoozedAt > 0 &&
    typeof task.snoozedUntil === "number" &&
    Number.isFinite(task.snoozedUntil) &&
    task.snoozedUntil > nowSeconds
  ) {
    return "later";
  }
  if (task.settledOverride === true) return "handled";
  return "active";
}

export function taskNeedsAttention(task: TaskInfo): boolean {
  return (
    task.status === "needs_review" || task.status === "blocked" || task.status === "interrupted"
  );
}

/**
 * Build a forest from the daemon's explicit parentTaskId relation. Missing
 * parents remain ordinary roots, which keeps old snapshots and deleted parents
 * usable. Cycles are also promoted to roots instead of disappearing.
 */
export function buildTaskForest(tasks: TaskInfo[]): TaskTree[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, TaskInfo[]>();

  for (const task of tasks) {
    if (task.parentTaskId && byId.has(task.parentTaskId) && task.parentTaskId !== task.id) {
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task);
      children.set(task.parentTaskId, siblings);
    }
  }

  const roots = tasks.filter(
    (task) => !task.parentTaskId || !byId.has(task.parentTaskId) || task.parentTaskId === task.id,
  );
  const visited = new Set<string>();
  const build = (task: TaskInfo, path: Set<string>): TaskTree => {
    visited.add(task.id);
    const nextPath = new Set(path).add(task.id);
    const taskChildren: TaskTree[] = [];
    for (const child of children.get(task.id) ?? []) {
      if (!nextPath.has(child.id)) taskChildren.push(build(child, nextPath));
    }
    return {
      children: taskChildren,
      task,
    };
  };

  const forest = roots.map((task) => build(task, new Set()));
  // A pure cycle has no natural root. Preserve every task by promoting one
  // Unseen member; the path guard prevents recursion through the cycle.
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      forest.push(build(task, new Set()));
    }
  }
  return forest;
}

export function flattenTaskTree(tree: TaskTree): TaskInfo[] {
  return [tree.task, ...tree.children.flatMap(flattenTaskTree)];
}

/** Index every task by its explicit orchestration root. */
export function buildTaskGroupIndex(tasks: TaskInfo[]): TaskGroupIndex {
  const forest = buildTaskForest(tasks);
  const rootByTaskId = new Map<string, TaskTree>();
  for (const root of forest) {
    for (const task of flattenTaskTree(root)) rootByTaskId.set(task.id, root);
  }
  return { forest, rootByTaskId };
}

/** Resolve persisted pins to unique roots while preserving pin order. */
export function resolvePinnedTaskGroups(index: TaskGroupIndex, pinnedIds: string[]): TaskTree[] {
  const seen = new Set<string>();
  const groups: TaskTree[] = [];
  for (const id of pinnedIds) {
    const root = index.rootByTaskId.get(id);
    if (!root || seen.has(root.task.id)) continue;
    seen.add(root.task.id);
    groups.push(root);
  }
  return groups;
}

/** Whether any persisted pin resolves to the orchestration group containing taskId. */
export function isTaskGroupPinned(
  index: TaskGroupIndex,
  pinnedIds: readonly string[],
  taskId: string,
): boolean {
  const root = index.rootByTaskId.get(taskId);
  if (!root) return false;
  return pinnedIds.some((id) => index.rootByTaskId.get(id)?.task.id === root.task.id);
}

/**
 * Pin or unpin a whole orchestration group. New pins are root-normalized;
 * unpinning also clears legacy child/descendant pins for that group.
 */
export function setTaskGroupPinned(
  index: TaskGroupIndex,
  pinnedIds: readonly string[],
  taskId: string,
  pinned: boolean,
): string[] {
  const root = index.rootByTaskId.get(taskId);
  if (!root) return [...pinnedIds];

  const memberIds = new Set(flattenTaskTree(root).map((task) => task.id));
  const remaining = pinnedIds.filter((id) => !memberIds.has(id));
  return pinned ? [...remaining, root.task.id] : remaining;
}

/** Keep the current tab unless an explicit attention target belongs to this group. */
export function resolveGroupTaskId(
  tree: TaskTree,
  currentId: string | null,
  attentionTargetId: string | null,
): string {
  const ids = new Set(flattenTaskTree(tree).map((task) => task.id));
  if (attentionTargetId && ids.has(attentionTargetId)) return attentionTargetId;
  if (currentId && ids.has(currentId)) return currentId;
  return tree.task.id;
}

export function taskGroupCounts(tree: TaskTree): TaskGroupCounts {
  return flattenTaskTree(tree)
    .slice(1)
    .reduce<TaskGroupCounts>(
      (counts, task) => {
        if (task.status === "blocked" || task.status === "interrupted") counts.blocked += 1;
        else if (task.status === "needs_review") counts.review += 1;
        else if (task.status === "running" || task.status === "queued") counts.running += 1;
        else if (task.status === "done") counts.done += 1;
        return counts;
      },
      { blocked: 0, done: 0, review: 0, running: 0 },
    );
}

export function taskLifecycleCounts(tree: TaskTree, nowSeconds: number): TaskLifecycleCounts {
  return flattenTaskTree(tree).reduce<TaskLifecycleCounts>(
    (counts, task) => {
      const lifecycle = taskLifecycle(task, nowSeconds);
      if (lifecycle === "later") counts.later += 1;
      if (lifecycle === "handled") counts.handled += 1;
      return counts;
    },
    { handled: 0, later: 0 },
  );
}

export function treeMatchesLifecycle(
  tree: TaskTree,
  filter: BoardLifecycleFilter,
  nowSeconds: number,
): boolean {
  if (filter === "all") return true;
  const tasks = flattenTaskTree(tree);
  if (filter === "attention") return tasks.some(taskNeedsAttention);
  return tasks.some((task) => taskLifecycle(task, nowSeconds) === filter);
}

export type TaskGroupStatus = "blocked" | "permission" | "review" | "running" | TaskStatus;

/** Human attention bubbles from descendants before ordinary activity. */
export function taskGroupStatus(
  tree: TaskTree,
  permissionTaskIds?: ReadonlySet<string>,
): TaskGroupStatus {
  const tasks = flattenTaskTree(tree);
  if (tasks.some((task) => task.status === "blocked" || task.status === "interrupted")) {
    return "blocked";
  }
  if (permissionTaskIds && tasks.some((task) => permissionTaskIds.has(task.id))) {
    return "permission";
  }
  if (tasks.some((task) => task.status === "needs_review")) return "review";
  if (tasks.some((task) => task.status === "running" || task.status === "queued")) return "running";
  return tree.task.status;
}

/**
 * Place a whole orchestration group in its most urgent lane.
 *
 * Live execution from any member keeps the orchestration in Active. Review and
 * blocked descendants remain visible in the group summary and attention filter
 * without hiding work that is still running.
 */
export function treeLane(tree: TaskTree): BoardLane {
  return flattenTaskTree(tree).reduce<BoardLane>((lane, task) => {
    const candidate = statusLane(task.status);
    return lanePriority[candidate] > lanePriority[lane] ? candidate : lane;
  }, "history");
}

export function treeMatches(tree: TaskTree, predicate: (task: TaskInfo) => boolean): boolean {
  return flattenTaskTree(tree).some(predicate);
}
