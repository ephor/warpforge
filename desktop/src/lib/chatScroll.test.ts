import { describe, expect, it } from "vitest";

import {
  CHAT_BOTTOM_THRESHOLD_PX,
  createChatFollowGate,
  distanceFromBottom,
  isNearChatBottom,
  shouldFollowAfterScroll,
  transcriptRestoreMode,
} from "./chatScroll";

describe("chat scroll following", () => {
  it("treats a viewport inside the threshold as near the bottom", () => {
    const metrics = { clientHeight: 400, scrollHeight: 1000, scrollTop: 529 };
    expect(distanceFromBottom(metrics)).toBe(71);
    expect(isNearChatBottom(metrics)).toBe(true);
  });

  it("stops following immediately when the user scrolls upward", () => {
    const metrics = { clientHeight: 400, scrollHeight: 1000, scrollTop: 590 };
    expect(isNearChatBottom(metrics)).toBe(true);
    expect(shouldFollowAfterScroll(600, metrics)).toBe(false);
  });

  it("re-enables following when scrolling down reaches the bottom zone", () => {
    const metrics = {
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 600 - CHAT_BOTTOM_THRESHOLD_PX,
    };
    expect(shouldFollowAfterScroll(500, metrics)).toBe(true);
  });

  it("does not follow while the viewport remains above the bottom zone", () => {
    const metrics = { clientHeight: 400, scrollHeight: 1000, scrollTop: 400 };
    expect(shouldFollowAfterScroll(350, metrics)).toBe(false);
  });

  it("invalidates a queued follow when upward user intent arrives first", () => {
    const gate = createChatFollowGate();
    const queuedFollow = gate.issue();
    gate.cancel();
    expect(gate.isCurrent(queuedFollow)).toBe(false);
  });
});

describe("transcript restore mode", () => {
  it("restores nothing while following the live edge", () => {
    expect(transcriptRestoreMode(true, false, null)).toBe("none");
  });

  it("anchors to the toggled row while a disclosure settles, even when following", () => {
    expect(transcriptRestoreMode(true, true, "work-toggle:work:i4")).toBe("anchor");
    expect(transcriptRestoreMode(false, true, "work-toggle:work:i4")).toBe("anchor");
  });

  it("cannot anchor without an anchor key", () => {
    expect(transcriptRestoreMode(true, true, null)).toBe("none");
  });

  it("restores nothing while reading away from the end", () => {
    // `"all"` blanked rows out as the recycling list reused them. It had never
    // run before the detach handlers were fixed, so the damage only surfaced
    // once scrolling up actually stopped the follow.
    expect(transcriptRestoreMode(false, false, null)).toBe("none");
    expect(transcriptRestoreMode(false, false, "work-toggle:work:i4")).toBe("none");
  });
});
