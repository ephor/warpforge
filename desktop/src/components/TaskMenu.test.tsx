import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
  status: "idle",
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
});
