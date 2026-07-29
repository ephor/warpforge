import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskInfo, WorkflowRunInfo } from "../protocol";
import { WorkflowControls } from "./WorkflowControls";

const workflowPause = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const workflowResume = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const workflowDecide = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));

vi.mock("../daemon", () => ({
  daemon: {
    request: (...args: unknown[]) => request(...(args as [])),
    workflowDecide: (...args: unknown[]) => workflowDecide(...(args as [])),
    workflowPause: (...args: unknown[]) => workflowPause(...(args as [])),
    workflowResume: (...args: unknown[]) => workflowResume(...(args as [])),
  },
}));

function task(run: Partial<WorkflowRunInfo>): TaskInfo {
  return {
    agent: "claude",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id: "t_1",
    project: "warpforge",
    prompt: "do it",
    status: "running",
    tags: [],
    title: "",
    updatedAt: 1,
    workflowRun: {
      maxRounds: 2,
      round: 1,
      stage: "review",
      workflowId: "wf",
      workflowName: "Review loop",
      ...run,
    },
  };
}

describe("WorkflowControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowDecide.mockImplementation(async () => {});
  });

  it("shows the pipeline position and pauses a running stage", async () => {
    render(<WorkflowControls task={task({})} />);
    expect(screen.getByText("Review loop")).toBeInTheDocument();
    expect(screen.getByText("reviewing")).toBeInTheDocument();
    expect(screen.getByText("round 1/2")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(workflowPause).toHaveBeenCalledWith("t_1");
  });

  it("offers Resume instead of Pause when paused", async () => {
    render(<WorkflowControls task={task({ stage: "fix", waiting: { kind: "paused" } })} />);
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(workflowResume).toHaveBeenCalledWith("t_1");
  });

  it("offers extend / finish / stop when the review limit is reached", async () => {
    render(
      <WorkflowControls
        task={task({ waiting: { kind: "limit", question: "open findings: 2 high" } })}
      />,
    );
    expect(screen.getByText(/open findings: 2 high/)).toBeInTheDocument();
    expect(screen.getByText("Review limit reached")).toBeInTheDocument();
    expect(screen.getByText(/guidance typed below/i)).toBeInTheDocument();
    // Pausing makes no sense while a decision is pending.
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();

    const oneRound = screen.getByRole("button", { name: /1 more round/i });
    const twoRounds = screen.getByRole("button", { name: /2 more rounds/i });
    const finish = screen.getByRole("button", { name: /finish for review/i });
    const stop = screen.getByRole("button", { name: /^stop$/i });
    expect(oneRound).toHaveClass("bg-primary");
    expect(twoRounds).toHaveClass("bg-primary");
    expect(finish).toHaveClass("bg-primary");
    expect(stop).toHaveClass("text-destructive", "bg-destructive/15");

    await userEvent.click(oneRound);
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "extend", { rounds: 1 });

    await userEvent.click(twoRounds);
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "extend", { rounds: 2 });

    await userEvent.click(finish);
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "finish");

    await userEvent.click(stop);
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "stop");
  });

  it("shows which limit action is in progress and locks competing decisions", async () => {
    let finishRequest: (() => void) | undefined;
    workflowDecide.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRequest = resolve;
        }),
    );
    render(
      <WorkflowControls
        task={task({ waiting: { kind: "limit", question: "open findings: 1 medium" } })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /finish for review/i }));

    expect(screen.getByRole("button", { name: /finishing/i })).toBeDisabled();
    expect(screen.getAllByRole("button").every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );

    finishRequest?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /finish for review/i })).toBeEnabled(),
    );
  });

  it("drops the controls once the pipeline is finished", () => {
    render(<WorkflowControls task={task({ stage: "done", verdict: "approve" })} />);
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("renders nothing for a task without a pipeline", () => {
    const plain = { ...task({}), workflowRun: null };
    const { container } = render(<WorkflowControls task={plain} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hard-stops the parent workflow", async () => {
    render(<WorkflowControls task={task({ stage: "implement" })} />);
    const stop = screen.getByRole("button", { name: /^stop$/i });
    expect(stop).toHaveClass("text-destructive", "bg-destructive/15");
    await userEvent.click(stop);
    expect(request).toHaveBeenCalledWith("task.cancel", { task_id: "t_1" });
  });
});
