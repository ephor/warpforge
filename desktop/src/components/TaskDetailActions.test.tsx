import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { TaskInfo } from "@/protocol";
import { useUi } from "@/store/ui";

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
  title: "",
  updatedAt: 1,
};

describe("TaskDetailActions", () => {
  beforeEach(() => {
    useUi.setState({ rightPanel: null, runtimeOpen: false, showChat: true, showDiff: true });
  });

  it("contains tool-window controls without task lifecycle actions", () => {
    render(<TaskDetailActions task={task} />);

    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /archive task/i })).not.toBeInTheDocument();
  });

  it("opens the matching contextual panel", () => {
    render(<TaskDetailActions task={task} />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(useUi.getState().rightPanel).toBe("files");
  });

  it("keeps Terminal available when the project has no runtime targets yet", () => {
    render(<TaskDetailActions task={task} />);
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
  });
});
