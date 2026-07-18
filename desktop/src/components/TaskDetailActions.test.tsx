import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TaskInfo } from "@/protocol";

import { TaskDetailActions } from "./TaskDetailActions";

const task: TaskInfo = {
  agent: "codex",
  blockedReason: null,
  createdAt: 1,
  filesChanged: 0,
  id: "child",
  parentTaskId: "root",
  project: "warpforge",
  prompt: "Implement task switching",
  status: "running",
  tags: [],
  updatedAt: 1,
};

describe("TaskDetailActions task-group pin", () => {
  it("exposes pinned state and delegates pin toggling independently of panels", () => {
    const onTogglePin = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    const { rerender } = render(
      <TaskDetailActions task={task} pinned={false} onTogglePin={onTogglePin} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pin task group" }));
    expect(onTogglePin).toHaveBeenCalledOnce();

    rerender(<TaskDetailActions task={task} pinned onTogglePin={onTogglePin} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "Unpin task group" })).toBeInTheDocument();
  });
});
