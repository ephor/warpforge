import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { stampSessionHistoryStartTimes, stampSessionUpdateStart } from "./sessionTiming";

const tool = (status: "pending" | "in_progress" | "completed"): SessionUpdate => ({
  kind: "tool_call",
  status,
  title: "wait",
  tool_call_id: "call-1",
  tool_kind: "execute",
});

describe("session tool timing", () => {
  it("preserves the first start across later frames for the same tool id", () => {
    const first = stampSessionUpdateStart([], tool("pending"), () => 1_000);
    const later = stampSessionUpdateStart([first], tool("in_progress"), () => 9_000);
    expect(first.kind === "tool_call" && first.started_at).toBe(1_000);
    expect(later.kind === "tool_call" && later.started_at).toBe(1_000);
  });

  it("does not invent mount-relative timing for legacy history", () => {
    const history = stampSessionHistoryStartTimes([tool("pending"), tool("in_progress")]);
    expect(history[0].kind === "tool_call" && history[0].started_at).toBeUndefined();
    expect(history[1].kind === "tool_call" && history[1].started_at).toBeUndefined();
  });
});
