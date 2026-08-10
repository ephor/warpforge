import { describe, expect, it } from "vitest";

import type { TaskInfo, TaskStatus } from "@/protocol";

import {
  buildTaskForest,
  buildTaskGroupIndex,
  flattenTaskTree,
  isTaskGroupPinned,
  resolvePinnedTaskGroups,
  resolveGroupTaskId,
  setTaskGroupPinned,
  taskGroupStatus,
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
    title: "",
    updatedAt: 1,
  };
}

/**
 * A task parked in `waiting` with a diff behind it — what `needs_review` used
 * to be, now expressed as the status plus the field that always carried it.
 */
function reviewTask(id: string, parentTaskId?: string): TaskInfo {
  return { ...task(id, "waiting", parentTaskId), filesChanged: 3 };
}

describe("task orchestration groups", () => {
  it("nests children from explicit parent ids while preserving standalone tasks", () => {
    const forest = buildTaskForest([
      task("standalone", "running"),
      task("child-2", "done", "parent"),
      task("parent", "waiting"),
      task("child-1", "running", "parent"),
    ]);

    expect(forest.map((tree) => tree.task.id)).toStrictEqual(["standalone", "parent"]);
    expect(forest[1].children.map((tree) => tree.task.id)).toStrictEqual(["child-2", "child-1"]);
  });

  it("keeps every child attached regardless of its state", () => {
    const [group] = buildTaskForest([
      task("orchestrator", "waiting"),
      reviewTask("finished-child", "orchestrator"),
      task("working-child", "running", "orchestrator"),
    ]);

    expect(flattenTaskTree(group).map((item) => item.id)).toStrictEqual([
      "orchestrator",
      "finished-child",
      "working-child",
    ]);
  });

  it("treats a child with a missing parent as a normal root", () => {
    const [root] = buildTaskForest([reviewTask("orphaned-snapshot", "deleted")]);
    expect(root.task.id).toBe("orphaned-snapshot");
    expect(root.children).toHaveLength(0);
  });

  it("builds multi-level trees from nested parent chains", () => {
    const forest = buildTaskForest([
      task("root", "waiting"),
      task("child", "running", "root"),
      reviewTask("grandchild", "child"),
    ]);

    expect(forest).toHaveLength(1);
    expect(forest[0].task.id).toBe("root");
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].task.id).toBe("child");
    expect(forest[0].children[0].children).toHaveLength(1);
    expect(forest[0].children[0].children[0].task.id).toBe("grandchild");
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

  it("keeps a multi-task cycle and its descendants in one navigable group", () => {
    const index = buildTaskGroupIndex([
      task("cycle-a", "running", "cycle-b"),
      task("cycle-b", "waiting", "cycle-a"),
      reviewTask("descendant", "cycle-a"),
    ]);
    const root = index.rootByTaskId.get("descendant");

    expect(root).toBeDefined();
    expect(flattenTaskTree(root!).map((item) => item.id)).toStrictEqual([
      "cycle-a",
      "cycle-b",
      "descendant",
    ]);
    expect(index.rootByTaskId.get("cycle-b")).toBe(root);
  });

  it("does not nest children under wrong parent", () => {
    const forest = buildTaskForest([
      task("a", "waiting"),
      task("b", "waiting"),
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
      reviewTask("child", "root"),
      task("grandchild", "running", "child"),
    ];
    const index = buildTaskGroupIndex(tasks);

    expect(resolvePinnedTaskGroups(index, ["child", "root", "grandchild"])).toHaveLength(1);
    expect(resolvePinnedTaskGroups(index, ["child"])[0].task.id).toBe("root");
  });

  it("root-normalizes a child pin and preserves unrelated pins", () => {
    const index = buildTaskGroupIndex([
      task("root", "running"),
      task("child", "running", "root"),
      task("grandchild", "waiting", "child"),
      task("other", "running"),
    ]);

    expect(setTaskGroupPinned(index, ["other"], "grandchild", true)).toStrictEqual([
      "other",
      "root",
    ]);
    expect(isTaskGroupPinned(index, ["child"], "grandchild")).toBe(true);
  });

  it("unpins every persisted member id in the group", () => {
    const index = buildTaskGroupIndex([
      task("root", "running"),
      task("child", "running", "root"),
      task("grandchild", "waiting", "child"),
      task("other", "running"),
    ]);

    expect(
      setTaskGroupPinned(index, ["root", "child", "other", "grandchild"], "child", false),
    ).toStrictEqual(["other"]);
  });

  it("normalizes duplicate legacy member pins when pinning an already known group", () => {
    const index = buildTaskGroupIndex([task("root", "running"), task("child", "running", "root")]);

    expect(setTaskGroupPinned(index, ["child", "root"], "child", true)).toStrictEqual(["root"]);
  });

  it("bubbles blocked, permission, review, then running from descendants", () => {
    const [review] = buildTaskForest([task("root", "waiting"), reviewTask("child", "root")]);
    expect(taskGroupStatus(review)).toBe("review");
    expect(taskGroupStatus(review, new Set(["root"]))).toBe("permission");

    const [blocked] = buildTaskForest([task("root", "running"), task("child", "blocked", "root")]);
    expect(taskGroupStatus(blocked, new Set(["root"]))).toBe("blocked");
  });

  it("focuses the exact child attention target without leaking across groups", () => {
    const [group] = buildTaskForest([task("root", "running"), reviewTask("child", "root")]);
    expect(resolveGroupTaskId(group, "root", "child")).toBe("child");
    expect(resolveGroupTaskId(group, "child", "unrelated")).toBe("child");
  });
});
