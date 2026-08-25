import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
import type { TaskInfo } from "@/protocol";

import { TaskMenu } from "./TaskMenu";

const task: TaskInfo = {
  agent: "codex",
  blockedReason: null,
  createdAt: 1,
  filesChanged: 0,
  id: "task-1",
  project: "warpforge",
  prompt: "Improve task detail",
  status: "waiting",
  tags: [],
  title: "",
  updatedAt: 1,
};

describe("TaskMenu", () => {
  it("names the pin destination explicitly", async () => {
    const user = userEvent.setup();
    render(
      <TaskMenu
        task={task}
        pinned={false}
        onTogglePin={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Task actions" }));
    expect(await screen.findByText("Pin to Mission Control")).toBeInTheDocument();
  });

  // Picking Delete used to go straight through: the webview answers
  // `window.confirm` without drawing it, so nothing ever asked.
  it("asks before deleting the task", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn<() => void>();
    const deleteTask = vi.spyOn(daemon, "deleteTask").mockResolvedValue();
    render(
      <TaskMenu task={task} pinned={false} onTogglePin={vi.fn<() => void>()} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: "Task actions" }));
    await user.click(await screen.findByText("Delete task"));
    expect(deleteTask).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Delete task" }));
    await vi.waitFor(() => expect(deleteTask).toHaveBeenCalledWith("task-1"));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
