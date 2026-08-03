import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import type { TaskInfo } from "../protocol";
import { TaskTitleEditor } from "./TaskTitleEditor";

const task: TaskInfo = {
  agent: "codex",
  blockedReason: null,
  configOptions: [
    {
      category: "model",
      currentValue: "gpt-5",
      id: "model",
      name: "Model",
      options: [],
    },
  ],
  createdAt: 1,
  filesChanged: 0,
  id: "task-1",
  project: "warpforge",
  prompt: "Implement a useful task title",
  status: "running",
  tags: [],
  title: "Original title",
  updatedAt: 1,
};

afterEach(() => vi.restoreAllMocks());

describe("TaskTitleEditor", () => {
  it("enters editing on double-click and saves on blur", async () => {
    const user = userEvent.setup();
    const setTaskTitle = vi.spyOn(daemon, "setTaskTitle").mockResolvedValue();

    render(
      <>
        <TaskTitleEditor task={task} />
        <button type="button">Outside</button>
      </>,
    );

    await user.dblClick(screen.getByRole("button", { name: "Edit task title: Original title" }));
    const input = screen.getByRole("textbox", { name: "Task title" });
    await user.clear(input);
    await user.type(input, "A better title");
    await user.click(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() => {
      expect(setTaskTitle).toHaveBeenCalledWith("task-1", "A better title");
    });
  });

  it("cancels an edit with Escape", async () => {
    const user = userEvent.setup();
    const setTaskTitle = vi.spyOn(daemon, "setTaskTitle").mockResolvedValue();

    render(<TaskTitleEditor task={task} />);
    await user.dblClick(screen.getByRole("button", { name: "Edit task title: Original title" }));
    await user.clear(screen.getByRole("textbox", { name: "Task title" }));
    await user.type(screen.getByRole("textbox", { name: "Task title" }), "Do not save");
    await user.keyboard("{Escape}");

    expect(setTaskTitle).not.toHaveBeenCalled();
    expect(screen.getByText("Original title")).toBeInTheDocument();
  });

  it("regenerates the title with the task agent and selected model", async () => {
    const user = userEvent.setup();
    const generateText = vi
      .spyOn(daemon, "generateText")
      .mockResolvedValue("  Regenerated title\n");
    const setTaskTitle = vi.spyOn(daemon, "setTaskTitle").mockResolvedValue();

    render(<TaskTitleEditor task={task} />);
    await user.click(screen.getByRole("button", { name: "Regenerate task title" }));

    await waitFor(() => {
      expect(generateText).toHaveBeenCalledWith("task-1", "codex", "task_title", "gpt-5");
      expect(setTaskTitle).toHaveBeenCalledWith("task-1", "Regenerated title");
    });
  });
});
