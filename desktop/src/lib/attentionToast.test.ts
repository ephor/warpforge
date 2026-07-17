import { describe, expect, it } from "vitest";

import { attentionToastSummary } from "./attentionToast";

describe("attentionToastSummary", () => {
  it("normalizes and bounds a large task prompt", () => {
    const summary = attentionToastSummary(`AttentionRail\n${"large context ".repeat(500)}`);

    expect(summary).not.toContain("\n");
    expect(Array.from(summary).length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("uses a useful fallback for an empty prompt", () => {
    expect(attentionToastSummary("  \n ")).toBe("Open the session for details");
  });
});
