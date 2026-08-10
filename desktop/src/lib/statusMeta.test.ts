import { describe, expect, it } from "vitest";

import type { TaskStatus } from "@/protocol";

import { statusEdge, statusLabel, TASK_STATUS_META, taskStatusVisual } from "./statusMeta";

/**
 * A desktop build can outrun the daemon binary it talks to. Every value below
 * arrives as a plain string off the wire, so the resolver — not the caller —
 * owns the fallback.
 */
const legacy = ["idle", "needs_review"] as unknown as TaskStatus[];

describe("taskStatusVisual", () => {
  it("resolves every current status to its own visual", () => {
    for (const status of Object.keys(TASK_STATUS_META) as TaskStatus[]) {
      expect(taskStatusVisual(status)).toBe(TASK_STATUS_META[status]);
    }
  });

  it("maps legacy wire spellings onto the waiting visual", () => {
    for (const status of legacy) {
      expect(taskStatusVisual(status)).toBe(TASK_STATUS_META.waiting);
    }
  });

  it("degrades an unheard-of status to a neutral visual instead of undefined", () => {
    const visual = taskStatusVisual("from_a_newer_daemon" as TaskStatus);
    expect(visual.label).toBe("unknown");
    expect(visual.tone).toBe("neutral");
    expect(visual.glyph).toBe("ring");
  });
});

describe("statusLabel", () => {
  it("labels legacy spellings as waiting", () => {
    for (const status of legacy) {
      expect(statusLabel(status)).toBe("waiting");
    }
  });

  it("labels an unknown status without throwing", () => {
    expect(() => statusLabel("wat" as TaskStatus)).not.toThrow();
    expect(statusLabel("wat" as TaskStatus)).toBe("unknown");
  });
});

describe("statusEdge", () => {
  it("gives legacy spellings the waiting edge", () => {
    for (const status of legacy) {
      expect(statusEdge(status)).toBe(statusEdge("waiting"));
    }
  });

  it("gives an unknown status the neutral edge without throwing", () => {
    expect(() => statusEdge("wat" as TaskStatus)).not.toThrow();
    expect(statusEdge("wat" as TaskStatus)).toBe("border-l-border");
  });
});
