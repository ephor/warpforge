import { describe, expect, it } from "vitest";

import type { TaskInfo } from "@/protocol";

import { buildHandoffSeed, canContinueHere, defaultCarryMode } from "./continueSession";
import { estimateTokens } from "./tokenEstimate";

const task = {
  agent: "claude",
  blockedKind: "session_lost",
  blockedReason: "rejected ACP session/load",
  createdAt: 1,
  filesChanged: 0,
  id: "t_source",
  project: "lingoverse",
  prompt: "Integrate the speech provider",
  status: "blocked",
  tags: [],
  title: "",
  updatedAt: 1,
} satisfies TaskInfo;

describe("defaultCarryMode", () => {
  it("carries a short conversation verbatim", () => {
    expect(defaultCarryMode(estimateTokens("short talk"))).toBe("full");
  });

  it("summarises one that would fill the new window", () => {
    expect(defaultCarryMode(estimateTokens("word ".repeat(40_000)))).toBe("summary");
  });
});

describe("canContinueHere", () => {
  it("allows the same harness to carry on after its session is lost", () => {
    expect(canContinueHere(task, "claude")).toBe(true);
  });

  it("requires a new task for a different harness", () => {
    // A task keeps one agent for its lifetime.
    expect(canContinueHere(task, "codex")).toBe(false);
  });

  it("refuses to seed a session that still works", () => {
    // The live session already holds this conversation; handing it a summary of
    // itself would spend context to say nothing new.
    const live = { ...task, blockedKind: null, blockedReason: null, status: "waiting" as const };
    expect(canContinueHere(live, "claude")).toBe(false);
  });
});

describe("buildHandoffSeed", () => {
  it("names the source and tells the new session not to trust the summary", () => {
    const seed = buildHandoffSeed(task, "## Goal\nShip the provider");

    expect(seed).toContain("t_source");
    expect(seed).toContain("Integrate the speech provider");
    expect(seed).toContain("main lingoverse checkout");
    expect(seed).toContain("Read the relevant files before changing anything");
    expect(seed).toContain("## Goal\nShip the provider");
  });

  it("points at the worktree when the work is isolated", () => {
    const seed = buildHandoffSeed({ ...task, worktree: "/tmp/wt" }, "doc");

    expect(seed).toContain("git worktree at /tmp/wt");
  });
});
