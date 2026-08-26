import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { latestCommands, summarizeFiles, summarizeTools } from "./sessionUpdatesSummary";

const tool = (
  id: string,
  status: "pending" | "in_progress" | "completed" | "failed",
): SessionUpdate => ({
  kind: "tool_call",
  status,
  title: id,
  tool_call_id: id,
  tool_kind: "execute",
});

const fileEdit = (path: string): SessionUpdate => ({
  kind: "file_edit",
  path,
  additions: 1,
  deletions: 0,
  hunks: [],
});

describe("latestCommands", () => {
  it("returns the last available_commands entry", () => {
    const commands: SessionUpdate[] = [
      { kind: "available_commands", commands: [{ name: "old" } as never] },
      { kind: "agent_text", text: "hi" },
      { kind: "available_commands", commands: [{ name: "new" } as never] },
    ];
    expect(latestCommands(commands)).toEqual([{ name: "new" }]);
  });

  it("returns [] when no available_commands update exists", () => {
    expect(latestCommands([{ kind: "agent_text", text: "hi" }])).toEqual([]);
  });
});

describe("summarizeTools", () => {
  it("counts pending and in_progress as active, failed separate", () => {
    const updates = [
      tool("a", "pending"),
      tool("b", "in_progress"),
      tool("c", "completed"),
      tool("d", "failed"),
      { kind: "agent_text", text: "x" } as SessionUpdate,
    ];
    expect(summarizeTools(updates)).toEqual({ active: 2, failed: 1, total: 4 });
  });
});

describe("summarizeFiles", () => {
  it("de-dupes basenames across edits of one path", () => {
    const updates = [fileEdit("src/a.ts"), fileEdit("lib/a.ts"), fileEdit("src/b.ts")];
    expect(summarizeFiles(updates).sort()).toEqual(["a.ts", "b.ts"]);
  });
});
