import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttentionItem } from "../lib/attentionRail";
import { decisionActionKinds } from "../lib/decisionActions";
import type { PermissionUpdate } from "../lib/sessionPermissions";
import type { TaskInfo, WorkflowRunInfo } from "../protocol";
import { daemon } from "./../daemon";
import { DecisionRowActions } from "./DecisionRowActions";

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

function run(waiting: WorkflowRunInfo["waiting"]): WorkflowRunInfo {
  return {
    maxRounds: 2,
    round: 1,
    stage: "review",
    waiting,
    workflowId: "wf",
    workflowName: "Review loop",
  };
}

function perm(options: string[]): PermissionUpdate {
  return { kind: "permission_request", options, request_id: "req-1", title: "Allow?" };
}

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return { priority: 0, reason: "reason", task: task({}), ...overrides };
}

describe("DecisionRowActions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a permission row through session.permission", async () => {
    const request = vi.spyOn(daemon, "request").mockImplementation(async () => ({}));
    const user = userEvent.setup();
    const row = item({ permission: perm(["allow_once", "deny"]) });
    render(<DecisionRowActions item={row} />);

    expect(decisionActionKinds(row)).toEqual(["permission"]);
    await user.click(screen.getByRole("button", { name: "allow_once" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("session.permission", {
        outcome: "allow_once",
        request_id: "req-1",
        task_id: "task-1",
      }),
    );
  });

  it("disables permission buttons while an answer is in flight", async () => {
    let resolveRequest: (() => void) | undefined;
    vi.spyOn(daemon, "request").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );
    const user = userEvent.setup();
    render(<DecisionRowActions item={item({ permission: perm(["allow", "deny"]) })} />);

    await user.click(screen.getByRole("button", { name: "allow" }));
    expect(screen.getByRole("button", { name: "deny" })).toBeDisabled();
    resolveRequest?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "deny" })).toBeEnabled());
  });

  it("sends typed question replies and disables Send while empty", async () => {
    const reply = vi.spyOn(daemon, "workflowReply").mockImplementation(async () => {});
    const user = userEvent.setup();
    render(
      <DecisionRowActions
        item={item({ task: task({ status: "waiting", workflowRun: run({ kind: "question" }) }) })}
      />,
    );

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Reply to workflow question"), "ship it");
    await user.click(send);
    await waitFor(() => expect(reply).toHaveBeenCalledWith("task-1", "ship it"));
  });

  it("sends Yes preset replies immediately", async () => {
    const reply = vi.spyOn(daemon, "workflowReply").mockImplementation(async () => {});
    const user = userEvent.setup();
    render(
      <DecisionRowActions
        item={item({ task: task({ status: "waiting", workflowRun: run({ kind: "question" }) }) })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith("task-1", "yes"));
  });

  it("extends one round or finishes for review on limit rows", async () => {
    const decide = vi.spyOn(daemon, "workflowDecide").mockImplementation(async () => {});
    const user = userEvent.setup();
    render(
      <DecisionRowActions
        item={item({ task: task({ status: "waiting", workflowRun: run({ kind: "limit" }) }) })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1 more round" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("task-1", "extend", { rounds: 1 }));
    await user.click(screen.getByRole("button", { name: "Finish for review" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("task-1", "finish"));
  });

  it.each(["blocked", "interrupted"] as const)("renders nothing for %s rows", (status) => {
    const { container } = render(<DecisionRowActions item={item({ task: task({ status }) })} />);
    expect(container.firstChild).toBeNull();
  });
});
