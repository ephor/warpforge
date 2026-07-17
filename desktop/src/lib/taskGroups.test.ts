import { describe, expect, it } from "vitest";

import type { TaskInfo, TaskStatus } from "@/protocol";

import {
  buildTaskForest,
  buildTaskGroupIndex,
  flattenTaskTree,
  resolvePinnedTaskGroups,
  resolveGroupTaskId,
  taskGroupStatus,
  treeLane,
  treeMatches,
} from "./taskGroups";

function task(id: string, status: TaskStatus, parentTaskId?: string): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id,
    parentTaskId,
    project: "warpforge",
    prompt: id,
    status,
    tags: [],
    updatedAt: 1,
  };
}

describe("task orchestration groups", () => {
  it("nests children from explicit parent ids while preserving standalone tasks", () => {
    const forest = buildTaskForest([
      task("standalone", "running"),
      task("child-2", "done", "parent"),
      task("parent", "idle"),
      task("child-1", "running", "parent"),
    ]);

    expect(forest.map((tree) => tree.task.id)).toStrictEqual(["standalone", "parent"]);
    expect(forest[1].children.map((tree) => tree.task.id)).toStrictEqual(["child-2", "child-1"]);
  });

  it("keeps a review child attached and promotes the group to review", () => {
    const [group] = buildTaskForest([
      task("orchestrator", "idle"),
      task("finished-child", "needs_review", "orchestrator"),
      task("working-child", "running", "orchestrator"),
    ]);

    expect(treeLane(group)).toBe("review");
    expect(flattenTaskTree(group).map((item) => item.id)).toStrictEqual([
      "orchestrator",
      "finished-child",
      "working-child",
    ]);
  });

  it("treats a child with a missing parent as a normal root", () => {
    const [root] = buildTaskForest([task("orphaned-snapshot", "needs_review", "deleted")]);
    expect(root.task.id).toBe("orphaned-snapshot");
    expect(treeLane(root)).toBe("review");
  });

  it("builds multi-level trees from nested parent chains", () => {
    const forest = buildTaskForest([
      task("root", "idle"),
      task("child", "running", "root"),
      task("grandchild", "needs_review", "child"),
    ]);

    expect(forest).toHaveLength(1);
    expect(forest[0].task.id).toBe("root");
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].task.id).toBe("child");
    expect(forest[0].children[0].children).toHaveLength(1);
    expect(forest[0].children[0].children[0].task.id).toBe("grandchild");
  });

  it("promotes group to the most urgent lane among descendants", () => {
    // All children done → history lane
    const [allDone] = buildTaskForest([
      task("p", "done"),
      task("c1", "done", "p"),
      task("c2", "done", "p"),
    ]);
    expect(treeLane(allDone)).toBe("history");

    // One child running → active lane
    const [oneRunning] = buildTaskForest([
      task("p", "idle"),
      task("c1", "done", "p"),
      task("c2", "running", "p"),
    ]);
    expect(treeLane(oneRunning)).toBe("active");

    // One child blocked → review lane (highest priority)
    const [oneBlocked] = buildTaskForest([
      task("p", "running"),
      task("c1", "running", "p"),
      task("c2", "blocked", "p"),
    ]);
    expect(treeLane(oneBlocked)).toBe("review");
  });

  it("handles empty task list", () => {
    const forest = buildTaskForest([]);
    expect(forest).toStrictEqual([]);
  });

  it("handles self-referencing parent (cycle to self)", () => {
    const forest = buildTaskForest([task("self-ref", "running", "self-ref")]);
    // Self-referencing task becomes a root (cycle broken)
    expect(forest).toHaveLength(1);
    expect(forest[0].task.id).toBe("self-ref");
    expect(forest[0].children).toHaveLength(0);
  });

  it("treeMatches filters trees where no member matches", () => {
    const forest = buildTaskForest([task("root", "running"), task("child", "done", "root")]);
    const matchRunning = (t: TaskInfo) => t.status === "running";

    // Root matches running → whole tree passes
    expect(treeMatches(forest[0], matchRunning)).toBeTruthy();
    // No member matches queued → tree filtered out
    expect(treeMatches(forest[0], (t) => t.status === "queued")).toBeFalsy();
  });

  it("does not nest children under wrong parent", () => {
    const forest = buildTaskForest([
      task("a", "idle"),
      task("b", "idle"),
      task("child-of-a", "running", "a"),
      task("child-of-b", "running", "b"),
    ]);

    expect(forest).toHaveLength(2);
    const treeA = forest.find((t) => t.task.id === "a")!;
    const treeB = forest.find((t) => t.task.id === "b")!;
    expect(treeA.children.map((c) => c.task.id)).toStrictEqual(["child-of-a"]);
    expect(treeB.children.map((c) => c.task.id)).toStrictEqual(["child-of-b"]);
  });

  it("resolves a direct child pin to its root exactly once", () => {
    const tasks = [
      task("root", "running"),
      task("child", "needs_review", "root"),
      task("grandchild", "running", "child"),
    ];
    const index = buildTaskGroupIndex(tasks);

    expect(resolvePinnedTaskGroups(index, ["child", "root", "grandchild"])).toHaveLength(1);
    expect(resolvePinnedTaskGroups(index, ["child"])[0].task.id).toBe("root");
  });

  it("bubbles blocked, permission, review, then running from descendants", () => {
    const [review] = buildTaskForest([task("root", "idle"), task("child", "needs_review", "root")]);
    expect(taskGroupStatus(review)).toBe("review");
    expect(taskGroupStatus(review, new Set(["root"]))).toBe("permission");

    const [blocked] = buildTaskForest([task("root", "running"), task("child", "blocked", "root")]);
    expect(taskGroupStatus(blocked, new Set(["root"]))).toBe("blocked");
  });

  it("focuses the exact child attention target without leaking across groups", () => {
    const [group] = buildTaskForest([
      task("root", "running"),
      task("child", "needs_review", "root"),
    ]);
    expect(resolveGroupTaskId(group, "root", "child")).toBe("child");
    expect(resolveGroupTaskId(group, "child", "unrelated")).toBe("child");
  });
});
