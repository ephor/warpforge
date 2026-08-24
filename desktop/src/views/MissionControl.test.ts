import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DaemonState } from "../daemon";
import type { EditHunk, SessionUpdate, TaskInfo } from "../protocol";
import { useUi } from "../store/ui";
import MissionControl, { StreamLine } from "./MissionControl";
import { appendCoalesced, coalesceUpdates } from "./missionControlStream";

afterEach(() => {
  vi.restoreAllMocks();
  useUi.setState({ attentionTargetId: null, pinnedLayout: {}, pinnedTaskIds: [] });
});

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

describe("MissionControl overview", () => {
  it("shows permission and workflow barriers in decision queue and opens task", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn<(id: string) => void>();
    const permission = task({ id: "permission", title: "Allow deploy access" });
    const workflow = task({
      id: "workflow",
      prompt: "Run review pipeline",
      title: "Run review pipeline",
      status: "waiting",
      workflowRun: {
        maxRounds: 2,
        round: 2,
        stage: "review",
        verdict: "request_changes",
        waiting: { kind: "limit", question: "2 findings remain" },
        workflowId: "review-loop",
        workflowName: "Review loop",
      },
    });
    render(
      createElement(MissionControl, {
        state: missionState([permission, workflow], {
          permission: [
            {
              kind: "permission_request",
              options: ["allow", "deny"],
              request_id: "permission-1",
              title: "Allow deployment access?",
            },
          ],
        }),
        onNewTask: vi.fn<(project?: string) => void>(),
        onOpenTask,
      }),
    );

    await user.click(screen.getByRole("tab", { name: /Needs you/ }));
    expect(screen.getByText("Allow deployment access?")).toBeInTheDocument();
    expect(screen.getByText(/review limit reached — 2 findings remain/)).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Open Allow deploy access" })[0]);
    expect(onOpenTask).toHaveBeenCalledWith("permission");
  });

  it("keeps finished work with a diff out of the queue", () => {
    // The queue is for work that cannot move without a human. A finished turn
    // that left changes is not blocked — it is the resting state of nearly
    // every task, which is exactly why counting it here made the number
    // meaningless.
    render(
      createElement(MissionControl, {
        state: missionState([
          task({ id: "reviewable", title: "Ship API", status: "waiting", filesChanged: 4 }),
        ]),
        onNewTask: vi.fn<(project?: string) => void>(),
        onOpenTask: vi.fn<(id: string) => void>(),
      }),
    );

    expect(screen.queryByText("Ship API")).not.toBeInTheDocument();
  });

  it("counts running work separately from everything unfinished", () => {
    render(
      createElement(MissionControl, {
        state: missionState([
          task({ id: "one", title: "Ship API", status: "running" }),
          task({ id: "two", title: "Queue docs", status: "waiting", updatedAt: 20 }),
          // Settled by hand rather than by the daemon: still finished, so it
          // must not inflate the count. Filtering on `status !== "done"` alone
          // is what made this number disagree with the sidebar.
          task({ id: "three", title: "Old thing", status: "waiting", settledOverride: true }),
          task({ id: "four", title: "Shipped", status: "done" }),
        ]),
        onNewTask: vi.fn<(project?: string) => void>(),
        onOpenTask: vi.fn<(id: string) => void>(),
      }),
    );

    expect(screen.getByRole("tab", { name: /Live/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Needs you/ })).toBeInTheDocument();
  });
});

describe("MissionControl failed section", () => {
  it("filters interrupted out of decision queue and shows it under Failed with Retry", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn<(id: string) => void>();
    const healthy = task({ id: "healthy", title: "Healthy task", status: "running" });
    const interrupted = task({
      id: "interrupted",
      title: "Crashed work",
      status: "interrupted",
    });
    render(
      createElement(MissionControl, {
        state: missionState([healthy, interrupted], {}),
        onNewTask: vi.fn<(project?: string) => void>(),
        onOpenTask,
      }),
    );

    await user.click(screen.getByRole("tab", { name: /Needs you/ }));
    expect(screen.getByText("Nothing is waiting for you.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Failed/ }));
    expect(screen.getByText("Crashed work")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Interrupted")).toBeInTheDocument();
    expect(screen.getByText("session lost on daemon restart")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Crashed work" }));
    expect(onOpenTask).toHaveBeenCalledWith("interrupted");
  });

  it("shows a task whose updates end in a failed tool call under Failed", async () => {
    const user2 = userEvent.setup();
    const failedTitle = "Run tests for the failing module";
    render(
      createElement(MissionControl, {
        state: missionState([task({ id: "with-failure", title: "With failure", status: "running" })], {
          "with-failure": [
            {
              kind: "tool_call",
              status: "failed",
              title: failedTitle,
              tool_call_id: "t1",
              tool_kind: "execute",
            },
          ],
        }),
        onNewTask: vi.fn<(project?: string) => void>(),
        onOpenTask: vi.fn<(id: string) => void>(),
      }),
    );

    await user2.click(screen.getByRole("tab", { name: /Failed/ }));
    expect(screen.getByText(`tool call failed: ${failedTitle}`)).toBeInTheDocument();
    expect(screen.getAllByText("With failure").length).toBeGreaterThanOrEqual(1);
  });
});

/** Reference incremental fold, mirroring ChatTranscript.useCoalesced. */
function incrementalCoalesce(prefix: SessionUpdate[], tail: SessionUpdate[]) {
  const merged = coalesceUpdates(prefix);
  const toolAt = new Map<string, number>();
  merged.forEach((u, i) => {
    if (u.kind === "tool_call") toolAt.set(u.tool_call_id, i);
    if (u.kind === "file_edit" && u.tool_call_id) toolAt.set(`edit:${u.tool_call_id}`, i);
  });
  for (const u of tail) appendCoalesced(merged, toolAt, u);
  return merged;
}

describe("coalesceUpdates tool timing", () => {
  it("keeps the first tool epoch when a later same-id frame replaces it", () => {
    const updates: SessionUpdate[] = [
      {
        kind: "tool_call",
        started_at: 1_000,
        status: "pending",
        title: "wait",
        tool_call_id: "call-1",
        tool_kind: "execute",
      },
      {
        kind: "tool_call",
        started_at: 9_000,
        status: "completed",
        title: "wait",
        tool_call_id: "call-1",
        tool_kind: "execute",
      },
    ];

    expect(coalesceUpdates(updates)[0]).toMatchObject({
      started_at: 1_000,
      status: "completed",
    });
  });

  it("coalesces lifecycle frames for one file edit and keeps the line counts", () => {
    const updates: SessionUpdate[] = [
      { kind: "file_edit", path: "src/App.tsx", tool_call_id: "edit-1" },
      {
        kind: "file_edit",
        path: "src/App.tsx",
        tool_call_id: "edit-1",
        additions: 12,
        deletions: 3,
      },
    ];

    expect(coalesceUpdates(updates)).toEqual([updates[1]]);
  });
});

describe("file edit line", () => {
  it("shows a project-relative path and per-edit line counts", () => {
    render(
      createElement(StreamLine, {
        update: {
          kind: "file_edit",
          path: "/Users/dev/warpforge/desktop/src/App.tsx",
          additions: 12,
          deletions: 3,
        },
        project: "warpforge",
        resolveFilePath: () => "desktop/src/App.tsx",
      }),
    );

    expect(screen.getByText("warpforge/desktop/src/App.tsx")).toBeInTheDocument();
    expect(screen.queryByText("/Users/dev/warpforge/desktop/src/App.tsx")).not.toBeInTheDocument();
    expect(screen.getByLabelText("12 lines added, 3 lines deleted")).toBeInTheDocument();
  });

  it("opens the editor from the file name and the exact diff from the line counts", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(path: string) => void>();
    const onOpenFileDiff = vi.fn<(path: string, hunks?: EditHunk[]) => void>();
    const editHunks = [
      {
        lines: ["-old", "+new"],
        newLines: 1,
        newStart: 12,
        oldLines: 1,
        oldStart: 12,
      },
    ];
    render(
      createElement(StreamLine, {
        update: {
          kind: "file_edit",
          path: "desktop/src/App.tsx",
          additions: 6,
          deletions: 2,
          hunks: editHunks,
        },
        resolveFilePath: () => "desktop/src/App.tsx",
        onOpenFile,
        onOpenFileDiff,
      }),
    );

    await user.click(screen.getByRole("button", { name: "desktop/src/App.tsx" }));
    expect(onOpenFile).toHaveBeenCalledWith("desktop/src/App.tsx");
    expect(onOpenFileDiff).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Open diff for desktop/src/App.tsx: 6 lines added, 2 lines deleted",
      }),
    );
    expect(onOpenFileDiff).toHaveBeenCalledWith("desktop/src/App.tsx", editHunks);
  });
});

describe("agent text streaming", () => {
  it("polls only the active streaming message, not historical transcript rows", () => {
    const interval = vi.spyOn(window, "setInterval");
    const historical = render(
      createElement(StreamLine, {
        update: { kind: "agent_text", text: "Finished response" },
      }),
    );
    expect(interval).not.toHaveBeenCalled();
    historical.unmount();

    render(
      createElement(StreamLine, {
        textStreaming: true,
        update: { kind: "agent_text", text: "Streaming response" },
      }),
    );
    expect(interval).toHaveBeenCalledTimes(1);
  });
});

describe("workflow conversation events", () => {
  it("renders a persistent inline agent card and opens its child session", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn<(id: string) => void>();
    render(
      createElement(StreamLine, {
        onOpenTask,
        update: {
          agents: [
            {
              agent: "codex",
              label: "implement",
              model: "gpt-5.6-sol",
              taskId: "t_impl",
            },
          ],
          event: "stage_started",
          kind: "workflow_event",
          stage: "implement",
          title: "Implement started",
          tone: "running",
        },
      }),
    );

    expect(screen.getByText("Implement started")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open implement agent session" }));
    expect(onOpenTask).toHaveBeenCalledWith("t_impl");
  });

  it("renders an agent summary as the next independent history entry", () => {
    render(
      createElement(StreamLine, {
        update: {
          agents: [
            {
              agent: "codex",
              label: "implement",
              taskId: "t_impl",
            },
          ],
          detail: "Implemented the parser and ran **all tests**.",
          event: "agent_output",
          kind: "workflow_event",
          stage: "implement",
          title: "Implement completed",
          tone: "success",
        },
      }),
    );

    expect(screen.getByText("Implement completed")).toBeInTheDocument();
    expect(screen.getByText(/Implemented the parser/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open implement agent session" }),
    ).toBeInTheDocument();
  });
});

describe("incremental coalescing", () => {
  const stream: SessionUpdate[] = [
    { kind: "user_message", text: "hi" },
    { kind: "agent_thought", text: "let " },
    { kind: "agent_thought", text: "me think" },
    {
      kind: "tool_call",
      status: "pending",
      title: "read",
      tool_call_id: "t1",
      tool_kind: "read",
    },
    { kind: "file_edit", path: "src/App.tsx", tool_call_id: "edit-1" },
    {
      kind: "file_edit",
      path: "src/App.tsx",
      tool_call_id: "edit-1",
      additions: 2,
      deletions: 1,
    },
    { kind: "agent_text", text: "Hello" },
    { kind: "agent_text", text: ", world" },
    {
      kind: "tool_call",
      status: "completed",
      title: "read",
      tool_call_id: "t1",
      tool_kind: "read",
    },
    { kind: "agent_text", text: "!" },
  ];

  it("matches a full rebuild at every append boundary", () => {
    for (let split = 0; split <= stream.length; split += 1) {
      const incremental = incrementalCoalesce(stream.slice(0, split), stream.slice(split));
      expect(incremental).toEqual(coalesceUpdates(stream));
    }
  });

  it("preserves object identity of blocks the tail did not touch", () => {
    const prefix = stream.slice(0, 4); // through the pending tool_call
    const base = coalesceUpdates(prefix);
    const toolAt = new Map<string, number>();
    base.forEach((u, i) => u.kind === "tool_call" && toolAt.set(u.tool_call_id, i));
    const userBlock = base[0];
    const thoughtBlock = base[1];

    // Append a fresh agent_text run — must not clone earlier blocks.
    appendCoalesced(base, toolAt, { kind: "agent_text", text: "ok" });
    expect(base[0]).toBe(userBlock);
    expect(base[1]).toBe(thoughtBlock);
  });
});
