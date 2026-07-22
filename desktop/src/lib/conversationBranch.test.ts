import { describe, expect, it } from "vitest";

import type { SessionUpdate, TaskInfo } from "@/protocol";

import { buildConversationBranchPrompt } from "./conversationBranch";

const task = {
  agent: "codex",
  blockedReason: null,
  createdAt: 1,
  filesChanged: 0,
  id: "t_source",
  project: "warpforge",
  prompt: "Build message actions",
  status: "idle",
  tags: [],
  title: "",
  updatedAt: 1,
} satisfies TaskInfo;

describe("buildConversationBranchPrompt", () => {
  it("stops at the selected message and excludes tool noise", () => {
    const updates: SessionUpdate[] = [
      { attachments: [], kind: "user_message", text: "First question" },
      {
        kind: "tool_call",
        status: "completed",
        title: "Read file",
        tool_call_id: "tool-1",
        tool_kind: "read",
      },
      { kind: "agent_text", text: "First answer" },
      { attachments: [], kind: "user_message", text: "Later question" },
    ];

    const prompt = buildConversationBranchPrompt(task, updates, 2);

    expect(prompt).toContain("First question");
    expect(prompt).toContain("First answer");
    expect(prompt).not.toContain("Read file");
    expect(prompt).not.toContain("Later question");
  });
});
