import { describe, expect, it } from "vitest";

import {
  CHAT_BOTTOM_THRESHOLD_PX,
  createChatFollowGate,
  distanceFromBottom,
  isNearChatBottom,
  shouldFollowAfterScroll,
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
