import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { preferToolTitle, toolDisplayTitle } from "./toolDisplay";

const tool = (title: string, content?: string): Extract<SessionUpdate, { kind: "tool_call" }> => ({
  content,
  kind: "tool_call",
  status: "completed",
  title,
  tool_call_id: "exec-7a8abe42-803f-447f-8a24-245cb383d4f9",
  tool_kind: "execute",
});

describe("tool display titles", () => {
  it("replaces a technical id with a semantic fallback", () => {
    expect(toolDisplayTitle(tool("exec-7a8abe42-803f-447f-8a24-245cb383d4f9"))).toBe("Run command");
  });

  it("keeps a command title when a later frame only has a generic fallback", () => {
    expect(preferToolTitle(tool("git diff --stat"), tool("Run command", "3 files changed"))).toBe(
      "git diff --stat",
    );
  });
});
