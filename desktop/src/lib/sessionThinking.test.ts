import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { activeThinkingIndex } from "./sessionThinking";

describe("activeThinkingIndex", () => {
  it("only marks the final thought phase active", () => {
    const updates: SessionUpdate[] = [
      { kind: "agent_thought", text: "first" },
      {
        kind: "tool_call",
        tool_call_id: "tool-1",
        title: "Inspect files",
        status: "completed",
        tool_kind: "read",
      },
      { kind: "agent_thought", text: "second" },
    ];

    expect(activeThinkingIndex(updates, "running")).toBe(2);
  });

  it("keeps thinking active through tool calls until an answer arrives", () => {
    const thought: SessionUpdate = { kind: "agent_thought", text: "done reasoning" };
    const tool: SessionUpdate = {
      kind: "tool_call",
      tool_call_id: "wait",
      title: "wait",
      status: "in_progress",
      tool_kind: "other",
    };

    expect(activeThinkingIndex([thought, tool], "running")).toBe(0);
    expect(
      activeThinkingIndex([thought, { kind: "agent_text", text: "Answer" }], "running"),
    ).toBeNull();
    expect(
      activeThinkingIndex([thought, { kind: "turn_ended", stop_reason: "end_turn" }], "running"),
    ).toBe(0);
  });

  it("keeps thinking active when a repeated tool frame completes after thinking", () => {
    const toolStarted: SessionUpdate = {
      kind: "tool_call",
      tool_call_id: "wait",
      title: "wait",
      status: "in_progress",
      tool_kind: "other",
    };
    const toolCompleted: SessionUpdate = { ...toolStarted, status: "completed" };

    expect(
      activeThinkingIndex(
        [toolStarted, { kind: "agent_thought", text: "checking result" }, toolCompleted],
        "running",
      ),
    ).toBe(1);
  });

  it("does not reuse a thought from before a new user turn", () => {
    const updates: SessionUpdate[] = [
      { kind: "agent_thought", text: "old thought" },
      { kind: "turn_ended", stop_reason: "end_turn" },
      { kind: "user_message", text: "one more thing" },
    ];

    expect(activeThinkingIndex(updates, "running")).toBeNull();
    expect(activeThinkingIndex([{ kind: "agent_thought", text: "active" }], "idle")).toBeNull();
    expect(activeThinkingIndex([{ kind: "agent_thought", text: "stale" }], "queued")).toBeNull();
  });
});
