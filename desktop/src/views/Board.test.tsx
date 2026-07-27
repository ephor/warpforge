import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_SNAPSHOT, type TaskInfo } from "../protocol";
import Board from "./Board";

function task(id: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 1,
    filesChanged: 0,
    id,
    parentTaskId: null,
    project: "warpforge",
    prompt: id,
    status: "idle",
    tags: [],
    title: "",
    updatedAt: 1,
    ...overrides,
  };
}

describe("Board layout", () => {
  it("renders four user-resizable lanes", () => {
    render(
      <Board
        snapshot={EMPTY_SNAPSHOT}
        onOpenTask={vi.fn<(id: string) => void>()}
        onNewTask={vi.fn<(project?: string) => void>()}
      />,
    );

    expect(screen.getByRole("region", { name: "Queue lane" })).toHaveClass("h-full", "min-h-0");
    expect(screen.getByRole("region", { name: "Active lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Review / blocked lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "History lane" })).toBeInTheDocument();
    expect(screen.getAllByRole("separator")).toHaveLength(3);
  });

  it("shows lifecycle badges and filters without adding board lanes", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshot = {
      ...EMPTY_SNAPSHOT,
      tasks: [
        task("active task"),
        task("later task", {
          snoozedAt: now - 60,
          snoozedUntil: now + 3600,
        }),
        task("handled task", {
          settledAt: now - 60,
          settledOverride: true,
        }),
      ],
    };

    render(
      <Board
        snapshot={snapshot}
        onOpenTask={vi.fn<(id: string) => void>()}
        onNewTask={vi.fn<(project?: string) => void>()}
      />,
    );

    expect(screen.getAllByRole("region")).toHaveLength(4);
    expect(screen.getByText("later task")).toBeInTheDocument();
    expect(screen.getByText("handled task")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Later 1" }));

    expect(screen.getByText("later task")).toBeInTheDocument();
    expect(screen.queryByText("active task")).not.toBeInTheDocument();
    expect(screen.queryByText("handled task")).not.toBeInTheDocument();
  });
});
