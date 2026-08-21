import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
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

  describe("amend", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const openCommitBox = () => {
      render(<ChangesRail {...baseProps} files={[changedFile]} />);
      fireEvent.click(screen.getByRole("button", { name: /commit/i }));
      return {
        amendBox: screen.getByRole("checkbox", { name: "amend" }),
        messageBox: screen.getByPlaceholderText("Commit message"),
      };
    };

    it("fills the box with the commit being rewritten, and clears it again", async () => {
      const read = vi
        .spyOn(daemon, "lastCommitMessage")
        .mockResolvedValue("feat: previous\n\nwith a body");
      const { amendBox, messageBox } = openCommitBox();

      fireEvent.click(amendBox);
      await waitFor(() => expect(messageBox).toHaveValue("feat: previous\n\nwith a body"));
      expect(read).toHaveBeenCalledWith("task-1");

      fireEvent.click(amendBox);
      await waitFor(() => expect(messageBox).toHaveValue(""));
    });

    it("never overwrites a message the user wrote", async () => {
      const read = vi.spyOn(daemon, "lastCommitMessage").mockResolvedValue("feat: previous");
      const { amendBox, messageBox } = openCommitBox();

      fireEvent.change(messageBox, { target: { value: "mine" } });
      fireEvent.click(amendBox);
      await waitFor(() => expect(amendBox).toBeChecked());
      expect(messageBox).toHaveValue("mine");
      expect(read).not.toHaveBeenCalled();

      // Unchecking must not throw away what the user typed either.
      fireEvent.click(amendBox);
      await waitFor(() => expect(amendBox).not.toBeChecked());
      expect(messageBox).toHaveValue("mine");
    });
  });
});
