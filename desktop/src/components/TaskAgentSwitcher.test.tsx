import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { buildTaskForest } from "@/lib/taskGroups";
import type { TaskInfo, TaskStatus } from "@/protocol";

import { TaskAgentSwitcher } from "./TaskAgentSwitcher";

function task(id: string, agent: string, status: TaskStatus, parentTaskId?: string): TaskInfo {
  return {
    agent,
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id,
    parentTaskId,
    project: "warpforge",
    prompt: `${id} prompt`,
    status,
    tags: [],
    title: "",
    updatedAt: 1,
  };
}

describe("TaskAgentSwitcher", () => {
  it("opens the selected leader or descendant through the navigation callback", async () => {
    const user = userEvent.setup();
    const [tree] = buildTaskForest([
      task("root", "root-agent", "running"),
      task("child", "child-agent", "running", "root"),
      task("grandchild", "review-agent", "waiting", "child"),
    ]);
    const onOpenTask = vi.fn<(id: string) => void>();

    render(<TaskAgentSwitcher tree={tree} currentTaskId="child" onOpenTask={onOpenTask} />);

    await user.click(screen.getByRole("button", { name: /current: child-agent/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Lead: running" }));

    await user.click(screen.getByRole("button", { name: /current: child-agent/i }));
    await user.click(await screen.findByRole("menuitem", { name: "review-agent: waiting" }));

    expect(onOpenTask).toHaveBeenNthCalledWith(1, "root");
    expect(onOpenTask).toHaveBeenNthCalledWith(2, "grandchild");
  });

  it("does not navigate when the current task tab is selected", async () => {
    const user = userEvent.setup();
    const [tree] = buildTaskForest([
      task("root", "root-agent", "waiting"),
      task("child", "child-agent", "running", "root"),
    ]);
    const onOpenTask = vi.fn<(id: string) => void>();

    render(<TaskAgentSwitcher tree={tree} currentTaskId="root" onOpenTask={onOpenTask} />);
    await user.click(screen.getByRole("button", { name: /current: lead/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Lead: waiting" }));

    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("labels a workflow root and its stage sessions explicitly", async () => {
    const user = userEvent.setup();
    const root = {
      ...task("root", "codex", "running"),
      orchestrationGraph: {
        goal: "Implement + review loop",
        id: "root",
        nodes: [
          {
            agent: "codex",
            id: "implement",
            kind: "implement" as const,
            status: "running" as const,
            taskId: "child",
          },
        ],
      },
      workflowRun: {
        maxRounds: 2,
        round: 0,
        stage: "implement" as const,
        workflowId: "review-loop",
        workflowName: "Implement + review loop",
      },
    };
    const [tree] = buildTaskForest([root, task("child", "codex", "running", "root")]);

    render(
      <TaskAgentSwitcher
        tree={tree}
        currentTaskId="root"
        onOpenTask={vi.fn<(id: string) => void>()}
      />,
    );

    expect(screen.getByRole("button", { name: /current: workflow/i })).toHaveTextContent(
      "Stages 1",
    );
    await user.click(screen.getByRole("button", { name: /current: workflow/i }));
    expect(
      await screen.findByRole("menuitem", { name: /implement · codex: running/i }),
    ).toBeInTheDocument();
  });

  it("keeps a long agent list inside a scrollable picker", async () => {
    const user = userEvent.setup();
    const [tree] = buildTaskForest([
      task("root", "root-agent", "running"),
      ...Array.from({ length: 30 }, (_, index) =>
        task(`child-${index}`, `agent-${index}`, "waiting", "root"),
      ),
    ]);

    render(
      <TaskAgentSwitcher tree={tree} currentTaskId="root" onOpenTask={vi.fn<(id: string) => void>()} />,
    );

    await user.click(screen.getByRole("button", { name: /current: lead/i }));

    expect(screen.getByRole("menu")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("menu")).toHaveClass(
      "max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))]",
    );
  });
});
