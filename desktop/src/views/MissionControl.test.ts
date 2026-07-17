import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { coalesceUpdates } from "./MissionControl";

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
