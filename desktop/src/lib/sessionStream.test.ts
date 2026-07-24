import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import {
  appendCoalescedUpdate,
  coalesceUpdates,
  deriveTranscriptRows,
  transcriptRowsAreEqual,
} from "./sessionStream";

describe("session stream coalescing", () => {
  it("collapses raw streaming chunks into one semantic message", () => {
    const raw: SessionUpdate[] = Array.from({ length: 10_000 }, () => ({
      kind: "agent_text",
      text: "x",
    }));

    expect(coalesceUpdates(raw)).toEqual([{ kind: "agent_text", text: "x".repeat(10_000) }]);
  });

  it("appends live deltas immutably without retaining separate chunk objects", () => {
    const previous: SessionUpdate[] = [{ kind: "agent_text", text: "Hello" }];
    const next = appendCoalescedUpdate(previous, { kind: "agent_text", text: "!" });

    expect(previous).toEqual([{ kind: "agent_text", text: "Hello" }]);
    expect(next).toEqual([{ kind: "agent_text", text: "Hello!" }]);
  });

  it("preserves historical update identity when the streaming tail changes", () => {
    const historical: SessionUpdate = { kind: "user_message", text: "Question" };
    const previous: SessionUpdate[] = [historical, { kind: "agent_text", text: "Ans" }];
    const next = appendCoalescedUpdate(previous, { kind: "agent_text", text: "wer" });

    expect(next[0]).toBe(historical);
    expect(next[1]).not.toBe(previous[1]);
  });

  it("collapses completed consecutive work into one stable group", () => {
    const updates: SessionUpdate[] = [
      { kind: "user_message", text: "Inspect it" },
      { kind: "agent_thought", text: "Looking" },
      {
        kind: "tool_call",
        tool_call_id: "read-1",
        title: "Read file",
        status: "completed",
        tool_kind: "read",
      },
      { kind: "agent_text", text: "Done" },
    ];

    const rows = deriveTranscriptRows(updates, new Set(), null, null);

    expect(rows.map((row) => row.kind)).toEqual(["update", "update", "work-toggle", "update"]);
    expect(rows[2]).toMatchObject({
      kind: "work-toggle",
      expanded: false,
      hiddenCount: 1,
    });
    if (rows[2].kind !== "work-toggle") throw new Error("expected a work toggle");

    const expanded = deriveTranscriptRows(updates, new Set([rows[2].groupId]), null, null);
    expect(expanded.map((row) => row.kind)).toEqual([
      "update",
      "update",
      "update",
      "work-toggle",
      "update",
    ]);
    expect(expanded[3]).toMatchObject({ kind: "work-toggle", expanded: true });
  });

  it("keeps active thinking work expanded and compares unchanged groups by entry identity", () => {
    const updates: SessionUpdate[] = [
      { kind: "agent_thought", text: "Looking" },
      {
        kind: "tool_call",
        tool_call_id: "read-1",
        title: "Read file",
        status: "completed",
        tool_kind: "read",
      },
    ];
    const first = deriveTranscriptRows(updates, new Set(), 0, null);
    const repeated = deriveTranscriptRows(updates, new Set(), 0, null);

    expect(first.map((row) => row.kind)).toEqual(["update", "update"]);
    expect(transcriptRowsAreEqual(first[0], repeated[0])).toBe(true);
  });
});
