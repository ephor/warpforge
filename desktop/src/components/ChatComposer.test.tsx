import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskInfo, WorkflowRunInfo, WorkflowWaitKind } from "../protocol";
import { ChatComposer } from "./ChatComposer";

const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
const workflowReply = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const workflowResume = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const workflowDecide = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock("../daemon", () => ({
  daemon: {
    request: (...args: unknown[]) => request(...(args as [])),
    workflowDecide: (...args: unknown[]) => workflowDecide(...(args as [])),
    workflowReply: (...args: unknown[]) => workflowReply(...(args as [])),
    workflowResume: (...args: unknown[]) => workflowResume(...(args as [])),
  },
}));

function task(workflowRun?: WorkflowRunInfo | null): TaskInfo {
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
    workflowRun,
  };
}

function run(waiting?: WorkflowWaitKind): WorkflowRunInfo {
  return {
    maxRounds: 2,
    round: 1,
    stage: waiting === "question" ? "plan" : "review",
    waiting: waiting ? { kind: waiting } : null,
    workflowId: "wf",
    workflowName: "Review loop",
  };
}

function renderComposer(t: TaskInfo) {
  return render(
    <ChatComposer
      commands={[]}
      files={[]}
      filesLoading={false}
      imageSupported={false}
      onBeforeSend={vi.fn<() => void>()}
      task={t}
    />,
  );
}

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), text);
  await user.click(screen.getByRole("button", { name: /send/i }));
}

describe("ChatComposer — workflow parents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prompts the agent session for a regular task", async () => {
    renderComposer(task(null));
    await send("hello");
    expect(request).toHaveBeenCalledWith(
      "session.prompt",
      expect.objectContaining({ task_id: "t_1", text: "hello" }),
    );
    expect(workflowReply).not.toHaveBeenCalled();
  });

  it("routes a message to the asking stage when a question is pending", async () => {
    renderComposer(task(run("question")));
    await send("Postgres");
    expect(workflowReply).toHaveBeenCalledWith("t_1", "Postgres");
    expect(request).not.toHaveBeenCalledWith("session.prompt", expect.anything());
  });

  it("resumes a paused pipeline, passing the message as guidance", async () => {
    renderComposer(task(run("paused")));
    await send("prefer the simpler fix");
    expect(workflowResume).toHaveBeenCalledWith("t_1", "prefer the simpler fix");
  });

  it("turns a message at the review limit into one more round with guidance", async () => {
    renderComposer(task(run("limit")));
    await send("focus on the parser");
    expect(workflowDecide).toHaveBeenCalledWith("t_1", "extend", {
      note: "focus on the parser",
      rounds: 1,
    });
  });

  it("disables input while the pipeline runs unattended and points at the stages", () => {
    renderComposer(task(run()));
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      expect.stringContaining("open a stage above"),
    );
  });

  it("leaves stopping a pipeline to WorkflowControls, not the composer", () => {
    // Two destructive controls a few pixels apart is a trap; the labelled Stop
    // in WorkflowControls owns this for pipelines.
    renderComposer(task(run()));
    expect(screen.queryByRole("button", { name: /^stop$/i })).not.toBeInTheDocument();
  });

  it("keeps input disabled after the pipeline finishes, with an explanation", () => {
    // The parent never has an agent session, so a message here could only fail
    // with a raw daemon error.
    renderComposer(task({ ...run(), stage: "done", waiting: null }));
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", expect.stringContaining("has finished"));
  });

  it("never prompts the session-less parent, even with no barrier pending", async () => {
    renderComposer(task({ ...run(), stage: "done", waiting: null }));
    // Disabled input cannot submit, but the routing must refuse regardless.
    expect(request).not.toHaveBeenCalledWith("session.prompt", expect.anything());
  });
});
