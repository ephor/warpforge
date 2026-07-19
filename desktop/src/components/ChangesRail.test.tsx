import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FileDiff } from "@/protocol";

import { ChangesRail } from "./ChangesRail";

const changedFile: FileDiff = {
  hunks: [
    {
      lines: ["-old", "+new"],
      newLines: 1,
      newStart: 1,
      oldLines: 1,
      oldStart: 1,
      resolution: null,
    },
  ],
  oldPath: null,
  path: "src/example.ts",
  status: "modified",
};

const baseProps = {
  onCommitted: vi.fn<() => void>(),
  onRefresh: vi.fn<() => void>(),
  onSelect: vi.fn<(path: string) => void>(),
  project: "warpforge",
  selected: null,
  taskId: "task-1",
};

describe("ChangesRail commit flow", () => {
  it("does not reserve commit space when there are no changes", () => {
    render(<ChangesRail {...baseProps} files={[]} />);

    expect(screen.getByText("No changes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /commit/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Commit message")).not.toBeInTheDocument();
  });

  it("keeps the commit form collapsed until requested", () => {
    render(<ChangesRail {...baseProps} files={[changedFile]} />);

    expect(screen.queryByPlaceholderText("Commit message")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /commit/i }));
    expect(screen.getByPlaceholderText("Commit message")).toBeInTheDocument();
  });
});
