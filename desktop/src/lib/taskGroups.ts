import type { TaskInfo, TaskStatus } from "@/protocol";

export interface TaskTree {
  task: TaskInfo;
  children: TaskTree[];
}

export interface TaskGroupIndex {
  forest: TaskTree[];
  rootByTaskId: Map<string, TaskTree>;
}

/**
 * "There is something to look at." The replacement for the old `needs_review`
 * status: same fact, read off the field that always carried it. A `waiting`
 * task with no diff is simply a conversation the user has not replied to yet.
 */
export function awaitsReview(task: TaskInfo): boolean {
  return task.status === "waiting" && task.filesChanged > 0;
}

/**
 * Finished turns with nothing to look at: the agent parked the task in
 * `waiting`, no diff came out of it, and the user has not replied. These are
 * what "Settle finished turns" bulk-settles in one click — the same reversible
 * settle as the per-row button. Snoozed rows keep their wake countdown, and
 * anything the user already settled is naturally out.
 */
export function settleableTasks(tasks: TaskInfo[], nowSec: number): TaskInfo[] {
  const snoozed = (task: TaskInfo) =>
    typeof task.snoozedAt === "number" &&
    typeof task.snoozedUntil === "number" &&
    task.snoozedUntil > nowSec;
  return tasks.filter(
    (task) =>
      task.status === "waiting" &&
      task.filesChanged === 0 &&
      task.settledOverride !== true &&
      !snoozed(task),
  );
}

/**
 * A task the user is finished with: the agent completed it, or the user marked
 * it handled. These are archive material — they still resolve to a state and
 * stay reachable, but they do not belong in a live tree or a live count.
 *
 * Two mechanisms, one meaning, which is why every "is this still work?" check
 * has to consult both. Filtering on `status !== "done"` alone silently counts
 * everything the user settled by hand.
 */
export function isSettledTask(task: TaskInfo): boolean {
  return task.status === "done" || task.settledOverride === true;
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

/**
 * Lead of an orchestration group: tagged `orchestrator-chat` at creation
 * (catches the lead before workers spawn), has children, or runs a workflow.
 */
export function isOrchestratorTask(task: TaskInfo, childCount = 0): boolean {
  return (
    task.tags.includes("orchestrator-chat") || childCount > 0 || task.workflowRun != null
  );
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
  if (tasks.some(awaitsReview)) return "review";
  if (tasks.some((task) => task.status === "running" || task.status === "queued")) return "running";
  return tree.task.status;
}
