import { fireEvent, render, screen } from "@testing-library/react";
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
    updatedAt: 1,
  };
}

describe("TaskAgentSwitcher", () => {
  it("opens the selected leader or descendant through the navigation callback", () => {
    const [tree] = buildTaskForest([
      task("root", "root-agent", "running"),
      task("child", "child-agent", "running", "root"),
      task("grandchild", "review-agent", "needs_review", "child"),
    ]);
    const onOpenTask = vi.fn<(id: string) => void>();

    render(<TaskAgentSwitcher tree={tree} currentTaskId="child" onOpenTask={onOpenTask} />);

    expect(screen.getByRole("tab", { name: "child-agent: running" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Lead: running" }));
    fireEvent.click(screen.getByRole("tab", { name: "review-agent: needs review" }));

    expect(onOpenTask).toHaveBeenNthCalledWith(1, "root");
    expect(onOpenTask).toHaveBeenNthCalledWith(2, "grandchild");
  });

  it("does not navigate when the current task tab is selected", () => {
    const [tree] = buildTaskForest([
      task("root", "root-agent", "idle"),
      task("child", "child-agent", "running", "root"),
    ]);
    const onOpenTask = vi.fn<(id: string) => void>();

    render(<TaskAgentSwitcher tree={tree} currentTaskId="root" onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByRole("tab", { name: "Lead: idle" }));

    expect(onOpenTask).not.toHaveBeenCalled();
  });
});
