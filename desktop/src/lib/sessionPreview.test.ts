import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { latestSessionPreview } from "./sessionPreview";

describe("latestSessionPreview", () => {
  it("uses the tail of the latest response while streaming", () => {
    const text = `Opening summary. ${"middle ".repeat(80)}Current streaming ending.`;
    const preview = latestSessionPreview([{ kind: "agent_text", text }], { active: true });
    expect(preview?.text).toMatch(/^….*Current streaming ending\.$/);
    expect(preview?.text).not.toContain("Opening summary");
    expect(preview?.truncated).toBe(true);
  });

  it("uses the beginning of the final response after completion", () => {
    const text = `Final summary first. ${"implementation detail ".repeat(60)}Test boilerplate last.`;
    const updates: SessionUpdate[] = [
      { kind: "agent_text", text },
      { kind: "turn_ended", stop_reason: "end_turn" },
    ];
    const preview = latestSessionPreview(updates, { active: false });
    expect(preview?.text).toMatch(/^Final summary first\./);
    expect(preview?.text).not.toContain("Test boilerplate last");
    expect(preview?.truncated).toBe(true);
  });

  it("expands to a longer but bounded final-message prefix", () => {
    const text = `Summary. ${"useful context ".repeat(100)}Unbounded ending.`;
    const collapsed = latestSessionPreview([{ kind: "agent_text", text }], { active: false });
    const expanded = latestSessionPreview([{ kind: "agent_text", text }], {
      active: false,
      expanded: true,
    });
    expect(expanded!.text.length).toBeGreaterThan(collapsed!.text.length);
    expect(expanded!.text.length).toBeLessThanOrEqual(901);
    expect(expanded?.truncated).toBe(true);
  });

  it("keeps a latest tool call semantic", () => {
    const updates: SessionUpdate[] = [
      { kind: "agent_text", text: "Working" },
      {
        kind: "tool_call",
        tool_call_id: "1",
        title: "Run tests",
        status: "in_progress",
        tool_kind: "execute",
      },
    ];
    expect(latestSessionPreview(updates, { active: true })?.text).toBe("Run tests · in progress");
  });
});
