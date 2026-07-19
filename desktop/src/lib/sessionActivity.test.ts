import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "../protocol";
import { sessionActivity } from "./sessionActivity";

const tool = (
  id: string,
  status: "pending" | "in_progress" | "completed" | "failed",
  started_at?: number,
  title = id,
): SessionUpdate => ({
  kind: "tool_call",
  started_at,
  status,
  title,
  tool_call_id: id,
  tool_kind: "execute",
});

describe("sessionActivity", () => {
  it("does not resurrect an older pending tool after a newer tool completes", () => {
    const activity = sessionActivity({ status: "running" }, [
      tool("old", "in_progress", 1_000),
      tool("new", "completed", 2_000),
    ]);
    expect(activity).toMatchObject({ detail: "checking tool output", label: "warping" });
    expect(activity?.startedAt).toBeUndefined();
  });

  it("uses the newest repeated frame and preserves its original epoch", () => {
    const activity = sessionActivity({ status: "running" }, [
      tool("same", "pending", 1_000),
      tool("same", "in_progress", 1_000),
    ]);
    expect(activity).toMatchObject({
      detail: "Run command",
      startedAt: 1_000,
      toolCallId: "same",
    });
  });

  it("uses a semantic tool title in the live activity indicator", () => {
    const activity = sessionActivity({ status: "running" }, [
      tool("exec-id", "in_progress", 1_000, "git diff --stat"),
    ]);
    expect(activity?.detail).toBe("git diff --stat");
  });

  it("ends repeated tool activity when the latest frame completes", () => {
    const activity = sessionActivity({ status: "running" }, [
      tool("same", "pending", 1_000),
      tool("same", "completed", 1_000),
    ]);
    expect(activity?.toolCallId).toBeUndefined();
    expect(activity?.startedAt).toBeUndefined();
  });
});
