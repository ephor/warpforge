import { describe, expect, it } from "vitest";

import type { SessionUpdate, TaskInfo } from "../protocol";
import { buildLiveStripItems, formatElapsed } from "./liveStrip";

function task(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    agent: "claude",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id: "task-1",
    project: "warpforge",
    prompt: "Do work",
    status: "running",
    tags: [],
    title: "Do work",
    updatedAt: 10,
    workflowRun: null,
    ...overrides,
  };
}

describe("buildLiveStripItems", () => {
  it("produces item with label/detail/tone for running task", () => {
    const t = task({ id: "a", title: "Alpha", status: "running" });
    const items = buildLiveStripItems([t], { a: [] }, new Set());
    expect(items).toHaveLength(1);
    expect(items[0].taskId).toBe("a");
    expect(items[0].title).toBe("Alpha");
    expect(items[0].label).toBe("warming up");
    expect(items[0].tone).toBe("thinking");
    expect(items[0].detail).toBe("starting the agent session");
    expect(items[0].startedAt).toBeNull();
  });

  it("excludes non-running tasks", () => {
    const waiting = task({ id: "w", status: "waiting" });
    const done = task({ id: "d", status: "done" });
    const blocked = task({ id: "b", status: "blocked" });
    const queued = task({ id: "q", status: "queued" });
    const running = task({ id: "r", status: "running" });
    const items = buildLiveStripItems([waiting, done, blocked, queued, running], {}, new Set());
    expect(items.map((i) => i.taskId)).toEqual(["r"]);
  });

  it("excludes permission-blocked sessions", () => {
    const t = task({ id: "perm", status: "running" });
    const updates: SessionUpdate[] = [
      { kind: "permission_request", request_id: "req-1", title: "Allow?", options: ["allow", "deny"] },
    ];
    const items = buildLiveStripItems([t], { perm: updates }, new Set());
    expect(items).toHaveLength(0);
  });

  it("counts tool calls in tail", () => {
    const t = task({ id: "tools", status: "running" });
    const updates: SessionUpdate[] = [
      { kind: "agent_text", text: "hi" },
      { kind: "tool_call", tool_call_id: "c1", title: "read", status: "pending", tool_kind: "read" },
      { kind: "tool_call", tool_call_id: "c2", title: "write", status: "completed", tool_kind: "write" },
      { kind: "agent_text", text: "done" },
    ];
    const items = buildLiveStripItems([t], { tools: updates }, new Set());
    expect(items[0].toolCount).toBe(2);
  });

  it("excludes tasks in excludeTaskIds", () => {
    const a = task({ id: "a", status: "running" });
    const b = task({ id: "b", status: "running" });
    const items = buildLiveStripItems([a, b], {}, new Set(["a"]));
    expect(items.map((i) => i.taskId)).toEqual(["b"]);
  });

  it("sorts by startedAt ascending, nulls last, tie-break by taskId", () => {
    const t1 = task({ id: "b", status: "running", title: "B" });
    const t2 = task({ id: "a", status: "running", title: "A" });
    const t3 = task({ id: "c", status: "running", title: "C" });
    // t1 and t2 will have active tool calls with started_at, t3 has no startedAt (empty updates)
    const updates: Record<string, SessionUpdate[]> = {
      b: [
        {
          kind: "tool_call",
          tool_call_id: "c-b",
          title: "exec",
          status: "pending",
          tool_kind: "execute",
          started_at: 3000,
        },
      ],
      a: [
        {
          kind: "tool_call",
          tool_call_id: "c-a",
          title: "exec",
          status: "pending",
          tool_kind: "execute",
          started_at: 1000,
        },
      ],
      c: [],
    };
    const items = buildLiveStripItems([t1, t2, t3], updates, new Set());
    expect(items.map((i) => i.taskId)).toEqual(["a", "b", "c"]);
    // tie-break: same startedAt
    const ta = task({ id: "a2", status: "running" });
    const tb = task({ id: "b2", status: "running" });
    const sameUpdates: Record<string, SessionUpdate[]> = {
      a2: [
        {
          kind: "tool_call",
          tool_call_id: "c1",
          title: "exec",
          status: "pending",
          tool_kind: "execute",
          started_at: 5000,
        },
      ],
      b2: [
        {
          kind: "tool_call",
          tool_call_id: "c2",
          title: "exec",
          status: "pending",
          tool_kind: "execute",
          started_at: 5000,
        },
      ],
    };
    const tie = buildLiveStripItems([tb, ta], sameUpdates, new Set());
    expect(tie.map((i) => i.taskId)).toEqual(["a2", "b2"]);
  });

  it("returns empty when no tasks run", () => {
    expect(buildLiveStripItems([], {}, new Set())).toEqual([]);
    const done = task({ id: "done", status: "done" });
    expect(buildLiveStripItems([done], {}, new Set())).toEqual([]);
  });

  it("excludes turn_ended (sessionActivity null)", () => {
    const t = task({ id: "ended", status: "running" });
    const updates: SessionUpdate[] = [{ kind: "turn_ended", stop_reason: "stop" }];
    const items = buildLiveStripItems([t], { ended: updates }, new Set());
    expect(items).toHaveLength(0);
  });

  it("sets previewText from latestSessionPreview", () => {
    const t = task({ id: "p", status: "running" });
    const updates: SessionUpdate[] = [{ kind: "agent_text", text: "hello world preview" }];
    const items = buildLiveStripItems([t], { p: updates }, new Set());
    expect(items[0].previewText).toBe("hello world preview");
  });
});

describe("formatElapsed", () => {
  it("formats seconds under a minute", () => {
    expect(formatElapsed(0, 42_000)).toBe("42s");
    expect(formatElapsed(0, 0)).toBe("0s");
    expect(formatElapsed(1000, 1000)).toBe("0s");
  });

  it("formats minutes boundary", () => {
    expect(formatElapsed(0, 60_000)).toBe("1m 00s");
    expect(formatElapsed(0, 5 * 60_000 + 3_000)).toBe("5m 03s");
    expect(formatElapsed(0, 59 * 60_000 + 59_000)).toBe("59m 59s");
  });

  it("formats hours", () => {
    expect(formatElapsed(0, 3600_000)).toBe("1h 00m");
    expect(formatElapsed(0, (1 * 3600 + 12 * 60) * 1000)).toBe("1h 12m");
    expect(formatElapsed(0, (2 * 3600 + 5 * 60) * 1000)).toBe("2h 05m");
  });

  it("clamps negative to 0s", () => {
    expect(formatElapsed(10_000, 5_000)).toBe("0s");
  });
});


