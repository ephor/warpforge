import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { TaskTree } from "@/lib/taskGroups";

import type { TaskInfo } from "../../protocol";
import { PipelineSurface } from "./PipelineSurface";

vi.mock("@/hooks/useTaskSessionUpdates", () => ({
  useTaskSessionUpdates: () => [],
}));

vi.mock("@/components/ChatTranscript", () => ({
  ChatTranscript: ({ task: shown, readOnly }: { task: TaskInfo; readOnly?: boolean }) => (
    <div data-testid="transcript" data-task-id={shown.id} data-read-only={String(!!readOnly)} />
  ),
}));

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id: "root",
    project: "warpforge",
    prompt: "root prompt",
    status: "running",
    tags: [],
    title: "",
    updatedAt: 1,
    ...overrides,
  };
}

function tree(t: TaskInfo): TaskTree {
  return { children: [], task: t };
}

describe("PipelineSurface", () => {
  it("shows a graph stage's live transcript read-only, and navigates only via Open task", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn<(id: string) => void>();
    const child = task({ id: "child-1", title: "Implement the thing" });
    const parent = task({
      orchestrationGraph: {
        goal: "Implement + review loop",
        id: "root",
        nodes: [
          {
            agent: "codex",
            id: "implement",
            kind: "implement",
            status: "running",
            taskId: "child-1",
          },
        ],
      },
    });

    render(
      <PipelineSurface
        task={parent}
        childTasks={[tree(child)]}
        agents={[]}
        onOpenTask={onOpenTask}
      />,
    );

    await user.click(screen.getByRole("button", { name: /implement/i }));

    const transcript = screen.getByTestId("transcript");
    expect(transcript).toHaveAttribute("data-task-id", "child-1");
    // Watching, not steering: a reply box here would type into a session the
    // header says you are not in.
    expect(transcript).toHaveAttribute("data-read-only", "true");
    expect(onOpenTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledWith("child-1");
  });

  it("builds the pipeline from child tasks when there is no orchestration graph", async () => {
    // A plain orchestrator delegates over MCP and reports no graph — its
    // pipeline is the children pointing back at it, and it deserves the same
    // view as a workflow parent.
    const user = userEvent.setup();
    const child = task({ id: "spawned", title: "Audit the analytics" });

    render(
      <PipelineSurface
        task={task()}
        childTasks={[tree(child)]}
        agents={[]}
        onOpenTask={vi.fn<(id: string) => void>()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Audit the analytics/ }));
    expect(screen.getByTestId("transcript")).toHaveAttribute("data-task-id", "spawned");
  });

  it("says so when the task farmed nothing out", () => {
    render(
      <PipelineSurface
        task={task()}
        childTasks={[]}
        agents={[]}
        onOpenTask={vi.fn<(id: string) => void>()}
      />,
    );

    expect(screen.getByText("Nothing farmed out yet")).toBeInTheDocument();
  });
});
