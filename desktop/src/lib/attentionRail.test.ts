import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "@/protocol";
import type { TaskInfo, TaskStatus } from "@/protocol";

import {
  buildAttentionQueue,
  partitionRailTasks,
  selectRailTasks,
  taskStatusRank,
  type AttentionItem,
} from "./attentionRail";

function task(id: string, overrides: Partial<TaskInfo> & { status?: TaskStatus } = {}): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id,
    parentTaskId: null,
    project: "warpforge",
    prompt: id,
    status: "waiting",
    tags: [],
    title: "",
    updatedAt: 1,
    ...overrides,
  };
}

function permUpdate(requestId = "perm-1", title = "Write file?"): SessionUpdate {
  return {
    kind: "permission_request",
    options: ["allow", "deny"],
    request_id: requestId,
    title,
  };
}

describe("taskStatusRank", () => {
  it("returns 0 when a permission is pending", () => {
    const perm = permUpdate() as Extract<SessionUpdate, { kind: "permission_request" }>;
    expect(taskStatusRank(task("a", { status: "waiting" }), perm)).toBe(0);
  });

  it("uses STATUS_RANK for tasks without permission", () => {
    expect(taskStatusRank(task("a", { status: "blocked" }))).toBe(2);
    expect(taskStatusRank(task("a", { status: "interrupted" }))).toBe(3);
    expect(taskStatusRank(task("a", { status: "running" }))).toBe(4);
    expect(taskStatusRank(task("a", { status: "done" }))).toBe(7);
  });

  it("promotes a waiting task only once it has changes to look at", () => {
    // The two halves of the old `needs_review` / `idle` split, now told apart
    // by the field rather than by the status.
    expect(taskStatusRank(task("a", { status: "waiting", filesChanged: 1 }))).toBe(1);
    expect(taskStatusRank(task("a", { status: "waiting", filesChanged: 0 }))).toBe(5);
  });
});

function waitingRun(
  kind: "question" | "limit" | "paused",
  question?: string,
): NonNullable<TaskInfo["workflowRun"]> {
  return {
    maxRounds: 2,
    round: 1,
    stage: "review",
    waiting: { kind, question },
    workflowId: "wf",
    workflowName: "Review loop",
  };
}

describe("buildAttentionQueue", () => {
  it("orders permission > blocked > interrupted", () => {
    const tasks = [
      task("blocked", { status: "blocked" }),
      task("interrupted", { status: "interrupted" }),
      task("perm", { status: "waiting" }),
    ];
    const updates: Record<string, SessionUpdate[]> = {
      perm: [permUpdate("p1", "Approve deploy")],
    };
    const queue = buildAttentionQueue(tasks, updates);
    expect(queue.map((item) => item.task.id)).toStrictEqual(["perm", "blocked", "interrupted"]);
  });

  it("leaves a finished turn with a diff out of the queue", () => {
    // Nothing is blocked — the agent is done and the diff is waiting in the
    // sidebar. Counting this as attention is what grew the queue to every
    // task the user had ever run.
    const tasks = [
      task("review", { status: "waiting", filesChanged: 3 }),
      task("idle", { status: "waiting" }),
    ];
    expect(buildAttentionQueue(tasks, {})).toStrictEqual([]);
  });

  it("sorts same-priority items by updatedAt desc, then id asc", () => {
    const tasks = [
      task("b", { status: "blocked", updatedAt: 10 }),
      task("a", { status: "blocked", updatedAt: 10 }),
      task("c", { status: "blocked", updatedAt: 20 }),
    ];
    const queue = buildAttentionQueue(tasks, {});
    expect(queue.map((item) => item.task.id)).toStrictEqual(["c", "a", "b"]);
  });

  it("returns an empty array for empty input", () => {
    expect(buildAttentionQueue([], {})).toStrictEqual([]);
  });

  it("queues a model mismatch regardless of status, below halting work", () => {
    const tasks = [
      task("perm", { status: "running" }),
      task("blocked", { status: "blocked" }),
      task("mismatch-running", {
        status: "running",
        blockedKind: "model_mismatch",
        blockedReason: "Requested model 'opus[1m]' was not applied: the agent rejected it.",
      }),
      task("mismatch-waiting", {
        status: "waiting",
        blockedKind: "model_mismatch",
        blockedReason: "Requested model 'opus[1m]' timed out.",
      }),
    ];
    const updates: Record<string, SessionUpdate[]> = {
      perm: [permUpdate("p1", "Approve deploy")],
    };
    const queue = buildAttentionQueue(tasks, updates);
    expect(queue.map((item) => item.task.id)).toStrictEqual([
      "perm",
      "blocked",
      "mismatch-running",
      "mismatch-waiting",
    ]);
    expect(queue[2]?.priority).toBeGreaterThan(
      queue.find((i) => i.task.id === "blocked")!.priority,
    );
    expect(queue[2]?.reason).toContain("opus[1m]");
    expect(queue[3]?.reason).toContain("timed out");
  });

  it("leaves a task without a mismatch out of the queue", () => {
    const tasks = [
      task("plain", { status: "running" }),
      task("mismatch", { status: "running", blockedKind: "model_mismatch" }),
    ];
    const queue = buildAttentionQueue(tasks, {});
    expect(queue.map((item) => item.task.id)).toStrictEqual(["mismatch"]);
  });
});

describe("buildAttentionQueue — workflow pipelines", () => {
  it("queues a pipeline waiting on a question, using the question as the reason", () => {
    const t = task("wf", { status: "running", workflowRun: waitingRun("question", "Which db?") });
    const [item] = buildAttentionQueue([t], {});
    expect(item.reason).toBe("Which db?");
    expect(item.task.id).toBe("wf");
  });

  it("queues an exhausted review limit with its findings summary", () => {
    const t = task("wf", {
      status: "running",
      workflowRun: waitingRun("limit", "open findings: 2 high"),
    });
    const [item] = buildAttentionQueue([t], {});
    expect(item.reason).toBe("review limit reached — open findings: 2 high");
  });

  it("leaves a user-initiated pause out of the queue", () => {
    const t = task("wf", { status: "running", workflowRun: waitingRun("paused") });
    expect(buildAttentionQueue([t], {})).toEqual([]);
  });

  it("ranks a waiting pipeline under a permission but above a blocked task", () => {
    const tasks = [
      task("blocked", { status: "blocked" }),
      task("wf", { status: "running", workflowRun: waitingRun("question", "?") }),
      task("perm", { status: "running" }),
    ];
    const queue = buildAttentionQueue(tasks, { perm: [permUpdate()] });
    expect(queue.map((i) => i.task.id)).toEqual(["perm", "wf", "blocked"]);
  });

  it("still reports a pending permission on a workflow stage child", () => {
    const t = task("wf", { status: "running", workflowRun: waitingRun("question", "?") });
    const [item] = buildAttentionQueue([t], { wf: [permUpdate("p", "Write file?")] });
    expect(item.reason).toBe("Write file?");
    expect(item.permission).toBeDefined();
  });
});

describe("selectRailTasks", () => {
  const attention = (ids: string[]): Map<string, AttentionItem> =>
    new Map(ids.map((id) => [id, { priority: 1, reason: "test", task: task(id) }]));

  it("removes done tasks", () => {
    const tasks = [task("a"), task("b", { status: "done" })];
    expect(selectRailTasks(tasks, new Map(), "all", "", "created").map((t) => t.id)).toStrictEqual([
      "a",
    ]);
  });

  it("filters by attention mode", () => {
    const tasks = [task("a"), task("b", { status: "running" })];
    const att = attention(["a"]);
    const result = selectRailTasks(tasks, att, "attention", "", "created");
    expect(result.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("filters by running mode", () => {
    const tasks = [task("a"), task("b", { status: "running" })];
    const result = selectRailTasks(tasks, new Map(), "running", "", "created");
    expect(result.map((t) => t.id)).toStrictEqual(["b"]);
  });

  it("filters by query against prompt and project", () => {
    const tasks = [
      task("a", { prompt: "fix login bug" }),
      task("b", { project: "frontend" }),
      task("c", { prompt: "other", project: "backend" }),
    ];
    expect(
      selectRailTasks(tasks, new Map(), "all", "login", "created").map((t) => t.id),
    ).toStrictEqual(["a"]);
    expect(
      selectRailTasks(tasks, new Map(), "all", "frontend", "created").map((t) => t.id),
    ).toStrictEqual(["b"]);
    expect(selectRailTasks(tasks, new Map(), "all", "zzz", "created")).toStrictEqual([]);
  });

  it("sorts by created desc with deterministic id tie-breaking", () => {
    const tasks = [
      task("beta", { createdAt: 100 }),
      task("alpha", { createdAt: 100 }),
      task("gamma", { createdAt: 200 }),
    ];
    const result = selectRailTasks(tasks, new Map(), "all", "", "created");
    expect(result.map((t) => t.id)).toStrictEqual(["gamma", "alpha", "beta"]);
  });

  it("created order is stable when updatedAt changes", () => {
    const tasks = [
      task("old", { createdAt: 200, updatedAt: 1 }),
      task("new", { createdAt: 100, updatedAt: 999 }),
    ];
    const first = selectRailTasks(tasks, new Map(), "all", "", "created");
    expect(first.map((t) => t.id)).toStrictEqual(["old", "new"]);

    const mutated = [
      task("old", { createdAt: 200, updatedAt: 5000 }),
      task("new", { createdAt: 100, updatedAt: 9999 }),
    ];
    const second = selectRailTasks(mutated, new Map(), "all", "", "created");
    expect(second.map((t) => t.id)).toStrictEqual(["old", "new"]);
  });

  it("updated sort still responds to updatedAt changes", () => {
    const tasks = [task("a", { updatedAt: 1 }), task("b", { updatedAt: 10 })];
    expect(selectRailTasks(tasks, new Map(), "all", "", "updated").map((t) => t.id)).toStrictEqual([
      "b",
      "a",
    ]);
  });

  it("updated sort uses status rank then id as tie-breakers", () => {
    const tasks = [
      task("b", { status: "blocked", updatedAt: 10 }),
      task("a", { status: "waiting", filesChanged: 1, updatedAt: 10 }),
      task("c", { status: "running", updatedAt: 10 }),
    ];
    expect(selectRailTasks(tasks, new Map(), "all", "", "updated").map((t) => t.id)).toStrictEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("status sort uses rank then updatedAt then id", () => {
    const tasks = [
      task("b", { status: "blocked", updatedAt: 10 }),
      task("a", { status: "blocked", updatedAt: 10 }),
      task("c", { status: "waiting", filesChanged: 1, updatedAt: 5 }),
    ];
    expect(selectRailTasks(tasks, new Map(), "all", "", "status").map((t) => t.id)).toStrictEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("project sort groups by project then updatedAt desc then id", () => {
    const tasks = [
      task("x", { project: "beta", updatedAt: 10 }),
      task("y", { project: "alpha", updatedAt: 5 }),
      task("z", { project: "alpha", updatedAt: 10 }),
    ];
    expect(selectRailTasks(tasks, new Map(), "all", "", "project").map((t) => t.id)).toStrictEqual([
      "z",
      "y",
      "x",
    ]);
  });

  it("does not mutate the input array", () => {
    const tasks = [task("b", { createdAt: 1 }), task("a", { createdAt: 2 })];
    const frozen = Object.freeze([...tasks]);
    selectRailTasks(frozen, new Map(), "all", "", "created");
    expect(frozen[0]?.id).toBe("b");
    expect(frozen[1]?.id).toBe("a");
  });

  it("returns empty for empty input", () => {
    expect(selectRailTasks([], new Map(), "all", "", "created")).toStrictEqual([]);
  });
});

describe("partitionRailTasks", () => {
  const now = 1000;

  const att = (ids: string[]): Map<string, AttentionItem> =>
    new Map(ids.map((id) => [id, { priority: 1, reason: "test", task: task(id) }]));

  it("excludes done tasks from all shelves", () => {
    const tasks = [task("a", { status: "done" }), task("b", { status: "waiting" })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.needsYou.map((t) => t.id)).toStrictEqual([]);
    expect(result.working.map((t) => t.id)).toStrictEqual(["b"]);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual([]);
    expect(result.settled.map((t) => t.id)).toStrictEqual([]);
  });

  it("an explicit future reminder wins over automatic attention", () => {
    const tasks = [task("a", { snoozedUntil: 2000, snoozedAt: 500 })];
    const result = partitionRailTasks(tasks, att(["a"]), now);
    expect(result.needsYou.map((t) => t.id)).toStrictEqual([]);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("an explicit handled choice wins over automatic attention", () => {
    const tasks = [task("a", { settledOverride: true, settledAt: 500 })];
    const result = partitionRailTasks(tasks, att(["a"]), now);
    expect(result.needsYou.map((t) => t.id)).toStrictEqual([]);
    expect(result.settled.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("valid future snooze beats settled", () => {
    const tasks = [
      task("a", {
        snoozedUntil: 2000,
        snoozedAt: 500,
        settledOverride: true,
        settledAt: 300,
      }),
    ];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual(["a"]);
    expect(result.settled.map((t) => t.id)).toStrictEqual([]);
  });

  it("settled task goes to settled shelf", () => {
    const tasks = [task("a", { settledOverride: true, settledAt: 500 })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.settled.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("non-done non-special task goes to working", () => {
    const tasks = [task("a", { status: "running" })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("expired valid snooze -> wokeIds + working", () => {
    const tasks = [task("a", { snoozedUntil: 500, snoozedAt: 200 })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.wokeIds).toStrictEqual(["a"]);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual([]);
  });

  it("expired valid snooze with attention -> wokeIds + needsYou", () => {
    const tasks = [task("a", { snoozedUntil: 500, snoozedAt: 200 })];
    const result = partitionRailTasks(tasks, att(["a"]), now);
    expect(result.wokeIds).toStrictEqual(["a"]);
    expect(result.needsYou.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("boundary: until == now wakes (not snoozed)", () => {
    const tasks = [task("a", { snoozedUntil: now, snoozedAt: 500 })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.wokeIds).toStrictEqual(["a"]);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual([]);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("malformed snoozedUntil (NaN) fails safe to working", () => {
    const tasks = [task("a", { snoozedUntil: Number.NaN, snoozedAt: 500 })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual([]);
  });

  it("negative snoozedUntil fails safe to working", () => {
    const tasks = [task("a", { snoozedUntil: -100, snoozedAt: 500 })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("non-finite snoozedAt (Infinity) fails safe to working", () => {
    const tasks = [task("a", { snoozedUntil: 2000, snoozedAt: Infinity })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
    expect(result.snoozed.map((t) => t.id)).toStrictEqual([]);
  });

  it("null snooze fields fail safe to working", () => {
    const tasks = [task("a", { snoozedUntil: null, snoozedAt: null })];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.working.map((t) => t.id)).toStrictEqual(["a"]);
  });

  it("stable ordering: createdAt desc then id asc within shelf", () => {
    const tasks = [
      task("beta", { createdAt: 100 }),
      task("alpha", { createdAt: 100 }),
      task("gamma", { createdAt: 200 }),
    ];
    const result = partitionRailTasks(tasks, new Map(), now);
    expect(result.working.map((t) => t.id)).toStrictEqual(["gamma", "alpha", "beta"]);
  });

  it("does not mutate input array", () => {
    const tasks = [task("b", { createdAt: 1 }), task("a", { createdAt: 2 })];
    const frozen = Object.freeze([...tasks]);
    partitionRailTasks(frozen, new Map(), now);
    expect(frozen[0]?.id).toBe("b");
    expect(frozen[1]?.id).toBe("a");
  });

  it("empty input returns empty shelves", () => {
    const result = partitionRailTasks([], new Map(), now);
    expect(result.needsYou).toStrictEqual([]);
    expect(result.working).toStrictEqual([]);
    expect(result.snoozed).toStrictEqual([]);
    expect(result.settled).toStrictEqual([]);
    expect(result.wokeIds).toStrictEqual([]);
  });
});
