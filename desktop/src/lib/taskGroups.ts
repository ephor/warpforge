import type { TaskInfo, TaskStatus } from "@/protocol";

export type BoardLane = "queue" | "active" | "review" | "history";

export interface TaskTree {
  task: TaskInfo;
  children: TaskTree[];
}

const lanePriority: Record<BoardLane, number> = {
  active: 2,
  history: 0,
  queue: 1,
  review: 3,
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
    return {
      children: (children.get(task.id) ?? [])
        .filter((child) => !nextPath.has(child.id))
        .map((child) => build(child, nextPath)),
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

/** Place a whole orchestration group in its most urgent lane. */
export function treeLane(tree: TaskTree): BoardLane {
  return flattenTaskTree(tree).reduce<BoardLane>((lane, task) => {
    const candidate = statusLane(task.status);
    return lanePriority[candidate] > lanePriority[lane] ? candidate : lane;
  }, "history");
}

export function treeMatches(tree: TaskTree, predicate: (task: TaskInfo) => boolean): boolean {
  return flattenTaskTree(tree).some(predicate);
}
