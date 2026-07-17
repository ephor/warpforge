import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { appendCoalesced, coalesceUpdates } from "./MissionControl";

/** Reference incremental fold, mirroring ChatTranscript.useCoalesced. */
function incrementalCoalesce(prefix: SessionUpdate[], tail: SessionUpdate[]) {
  const merged = coalesceUpdates(prefix);
  const toolAt = new Map<string, number>();
  merged.forEach((u, i) => {
    if (u.kind === "tool_call") toolAt.set(u.tool_call_id, i);
  });
  for (const u of tail) appendCoalesced(merged, toolAt, u);
  return merged;
}

describe("coalesceUpdates tool timing", () => {
  it("keeps the first tool epoch when a later same-id frame replaces it", () => {
    const updates: SessionUpdate[] = [
      {
        kind: "tool_call",
        started_at: 1_000,
        status: "pending",
        title: "wait",
        tool_call_id: "call-1",
        tool_kind: "execute",
      },
      {
        kind: "tool_call",
        started_at: 9_000,
        status: "completed",
        title: "wait",
        tool_call_id: "call-1",
        tool_kind: "execute",
      },
    ];

    expect(coalesceUpdates(updates)[0]).toMatchObject({
      started_at: 1_000,
      status: "completed",
    });
  });
});

describe("incremental coalescing", () => {
  const stream: SessionUpdate[] = [
    { kind: "user_message", text: "hi" },
    { kind: "agent_thought", text: "let " },
    { kind: "agent_thought", text: "me think" },
    {
      kind: "tool_call",
      status: "pending",
      title: "read",
      tool_call_id: "t1",
      tool_kind: "read",
    },
    { kind: "agent_text", text: "Hello" },
    { kind: "agent_text", text: ", world" },
    {
      kind: "tool_call",
      status: "completed",
      title: "read",
      tool_call_id: "t1",
      tool_kind: "read",
    },
    { kind: "agent_text", text: "!" },
  ];

  it("matches a full rebuild at every append boundary", () => {
    for (let split = 0; split <= stream.length; split += 1) {
      const incremental = incrementalCoalesce(stream.slice(0, split), stream.slice(split));
      expect(incremental).toEqual(coalesceUpdates(stream));
    }
  });

  it("preserves object identity of blocks the tail did not touch", () => {
    const prefix = stream.slice(0, 4); // through the pending tool_call
    const base = coalesceUpdates(prefix);
    const toolAt = new Map<string, number>();
    base.forEach((u, i) => u.kind === "tool_call" && toolAt.set(u.tool_call_id, i));
    const userBlock = base[0];
    const thoughtBlock = base[1];

    // Append a fresh agent_text run — must not clone earlier blocks.
    appendCoalesced(base, toolAt, { kind: "agent_text", text: "ok" });
    expect(base[0]).toBe(userBlock);
    expect(base[1]).toBe(thoughtBlock);
  });
});
