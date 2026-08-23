import { describe, expect, it } from "vitest";

import type { SessionUpdate, TaskInfo, TaskStatus } from "@/protocol";

import { buildFailureList, detectFailure } from "./taskFailures";

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

function toolCall(
  id: string,
  status: "pending" | "in_progress" | "completed" | "failed",
  title = "Edit file",
): SessionUpdate {
  return { kind: "tool_call", status, title, tool_call_id: id, tool_kind: "edit" };
}

describe("detectFailure", () => {
  it("detects an interrupted task", () => {
    expect(detectFailure(task("a", { status: "interrupted" }), [])).toStrictEqual({
      kind: "interrupted",
      reason: "session lost on daemon restart",
    });
  });

  it("detects a stream ending in a failed tool call with its title", () => {
    const t = task("a", { status: "running" });
    const updates = [toolCall("t1", "completed"), toolCall("t2", "failed", "Run tests")];
    expect(detectFailure(t, updates)).toStrictEqual({
      kind: "tool_call",
      reason: "tool call failed: Run tests",
    });
  });

  it("ignores a failed tool call followed by a later user message (recovered)", () => {
    const t = task("a", { status: "running" });
    const updates: SessionUpdate[] = [
      toolCall("t1", "failed"),
      { kind: "user_message", text: "try again" },
    ];
    expect(detectFailure(t, updates)).toBeNull();
  });

  it("returns null for completed tool calls only", () => {
    const t = task("a", { status: "running" });
    expect(detectFailure(t, [toolCall("t1", "completed")])).toBeNull();
  });

  it("uses the latest entry per tool call id", () => {
    const t = task("a", { status: "running" });
    const updates = [
      toolCall("t1", "failed", "first"),
      toolCall("t1", "in_progress", "retrying"),
      toolCall("t1", "completed"),
    ];
    expect(detectFailure(t, updates)).toBeNull();
  });

  it("truncates long tool titles to ~60 chars", () => {
    const t = task("a", { status: "running" });
    const long = "x".repeat(100);
    const result = detectFailure(t, [toolCall("t1", "failed", long)]);
    expect(result?.reason.length).toBeLessThanOrEqual("tool call failed: ".length + 60);
  });

  it("detects a failed orchestration node with its kind", () => {
    const t = task("a", {
      orchestrationGraph: {
        goal: "g",
        id: "orch-1",
        nodes: [
          { agent: "codex", id: "n1", kind: "implement", status: "complete" },
          { agent: "codex", id: "n2", kind: "review", status: "failed" },
        ],
      },
    });
    expect(detectFailure(t, undefined)).toStrictEqual({
      kind: "orchestration",
      reason: "node review failed",
    });
  });

  it("detects a failed workflow stage", () => {
    const t = task("a", {
      status: "running",
      workflowRun: {
        maxRounds: 2,
        round: 1,
        stage: "failed",
        waiting: null,
        workflowId: "wf",
        workflowName: "Review loop",
      },
    });
    expect(detectFailure(t, undefined)).toStrictEqual({
      kind: "workflow_stage",
      reason: "workflow stage failed",
    });
  });

  it("returns null for a workflow waiting on a question even with an old failed call", () => {
    const t = task("a", {
      status: "running",
      workflowRun: {
        maxRounds: 2,
        round: 1,
        stage: "review",
        waiting: { kind: "question", question: "?" },
        workflowId: "wf",
        workflowName: "Review loop",
      },
    });
    expect(detectFailure(t, [toolCall("t1", "failed")])).toBeNull();
  });

  it("returns null for a blocked task", () => {
    expect(detectFailure(task("a", { status: "blocked" }), [toolCall("t1", "failed")])).toBeNull();
  });

  it("returns null for a healthy running task", () => {
    expect(detectFailure(task("a", { status: "running" }), [])).toBeNull();
  });
});

describe("buildFailureList", () => {
  it("sorts by updatedAt descending and skips non-failures", () => {
    const tasks = [
      task("healthy", { status: "running", updatedAt: 30 }),
      task("old", { status: "interrupted", updatedAt: 10 }),
      task("new", { status: "interrupted", updatedAt: 20 }),
    ];
    const list = buildFailureList(tasks, {});
    expect(list.map((f) => f.task.id)).toStrictEqual(["new", "old"]);
    expect(list[0]?.kind).toBe("interrupted");
  });
});
