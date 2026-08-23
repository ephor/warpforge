import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonState } from "../../daemon";
import type { SessionUpdate, TaskInfo } from "../../protocol";
import { buildLiveStripItems } from "../../lib/liveStrip";
import { LiveStrip } from "./LiveStrip";

function task(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    agent: "claude",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id: "task-1",
    project: "warpforge",
    prompt: "Do the work",
    status: "running",
    tags: [],
    title: "Do the work",
    updatedAt: 10,
    workflowRun: null,
    ...overrides,
  };
}

function missionState(
  tasks: TaskInfo[],
  sessionUpdates: Record<string, SessionUpdate[]> = {},
): DaemonState {
  return {
    connection: "connected",
    connectionError: null,
    pendingAgentSetup: null,
    portforwardLogs: {},
    serviceLogs: {},
    sessionUpdates,
    snapshot: {
      portforwards: [],
      projects: [
        {
          agentTemplates: {},
          declaredServices: ["api"],
          name: "warpforge",
          path: "/workspace/warpforge",
          portRange: [4000, 4099],
        },
      ],
      services: [
        {
          allocatedPort: 4000,
          command: "bun run dev",
          logSeq: 0,
          name: "api",
          originalPort: 3000,
          project: "warpforge",
          status: "running",
        },
      ],
      tasks,
      terminals: [],
    },
  };
}

describe("LiveStrip", () => {
  it("renders nothing when items is empty", () => {
    render(createElement(LiveStrip, { items: [] }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("renders one tile per item with label, detail and elapsed text", () => {
    const nowMs = 10_000;
    const items = [
      {
        taskId: "a",
        title: "Alpha task",
        label: "working",
        detail: "checking tool output",
        tone: "working" as const,
        previewText: "hello preview",
        startedAt: 5_000,
        toolCount: 1,
      },
    ];
    render(createElement(LiveStrip, { items, nowMs }));
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("checking tool output")).toBeInTheDocument();
    expect(screen.getByText("hello preview")).toBeInTheDocument();
    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    // elapsed: 5s (10s - 5s)
    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("renders multiple tiles and count badge", () => {
    const nowMs = 20_000;
    const items = [
      {
        taskId: "a",
        title: "Alpha",
        label: "thinking",
        detail: "planning",
        tone: "thinking" as const,
        previewText: null,
        startedAt: null,
        toolCount: 0,
      },
      {
        taskId: "b",
        title: "Beta",
        label: "writing",
        detail: "streaming",
        tone: "writing" as const,
        previewText: "some text",
        startedAt: 15_000,
        toolCount: 2,
      },
    ];
    render(createElement(LiveStrip, { items, nowMs }));
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta/ })).toBeInTheDocument();
  });

  it("calls onOpenTask with task id when tile clicked", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn<(id: string) => void>();
    const items = [
      {
        taskId: "task-42",
        title: "Click me",
        label: "working",
        detail: "doing work",
        tone: "working" as const,
        previewText: null,
        startedAt: null,
        toolCount: 0,
      },
    ];
    render(createElement(LiveStrip, { items, nowMs: 0, onOpenTask }));
    await user.click(screen.getByRole("button", { name: /Click me/ }));
    expect(onOpenTask).toHaveBeenCalledWith("task-42");
  });

  it("integration: buildLiveStripItems fed into LiveStrip produces expected count", () => {
    const t1 = task({ id: "a", title: "Running one", status: "running" });
    const t2 = task({ id: "b", title: "Waiting one", status: "waiting" });
    const t3 = task({ id: "c", title: "Running two", status: "running" });
    const state = missionState([t1, t2, t3], {
      a: [],
      c: [{ kind: "agent_text", text: "preview for c" }],
    });
    const live = state.snapshot.tasks.filter((t) => t.status === "running");
    const items = buildLiveStripItems(live, state.sessionUpdates, new Set());
    expect(items).toHaveLength(2);
    render(createElement(LiveStrip, { items, nowMs: 1000 }));
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
    expect(screen.getByText("Running one")).toBeInTheDocument();
    expect(screen.getByText("Running two")).toBeInTheDocument();
    expect(screen.queryByText("Waiting one")).not.toBeInTheDocument();
  });

  it("suppresses timer when nowMs is passed (no interval)", () => {
    const spy = vi.spyOn(window, "setInterval");
    const items = [
      {
        taskId: "a",
        title: "Alpha",
        label: "working",
        detail: "",
        tone: "working" as const,
        previewText: null,
        startedAt: 0,
        toolCount: 0,
      },
    ];
    const { unmount } = render(createElement(LiveStrip, { items, nowMs: 5000 }));
    expect(spy).not.toHaveBeenCalled();
    unmount();
    spy.mockRestore();
  });
});
