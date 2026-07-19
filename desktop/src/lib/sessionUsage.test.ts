import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { compactTokenCount, latestContextUsage } from "./sessionUsage";

describe("session usage", () => {
  it("selects the newest context update", () => {
    const updates: SessionUpdate[] = [
      { kind: "usage", used: 10_000, size: 200_000 },
      { kind: "agent_text", text: "done" },
      { kind: "usage", used: 53_000, size: 200_000 },
    ];

    expect(latestContextUsage(updates)).toMatchObject({ used: 53_000, size: 200_000 });
  });

  it("formats token counts compactly", () => {
    expect(compactTokenCount(147_000)).toBe("147K");
    expect(compactTokenCount(1_500_000)).toBe("1.5M");
  });
});
