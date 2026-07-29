import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskInfo, WorkflowRunInfo } from "../protocol";
import { WorkflowControls } from "./WorkflowControls";

const workflowPause = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const workflowResume = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const workflowDecide = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock("../daemon", () => ({
  daemon: {
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
  beforeEach(() => vi.clearAllMocks());

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
    // Pausing makes no sense while a decision is pending.
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /2 more rounds/i }));
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "extend", { rounds: 2 });

    await userEvent.click(screen.getByRole("button", { name: /finish as is/i }));
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "finish");

    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "stop");
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
});
