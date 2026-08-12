import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuickOpen } from "./QuickOpen";

import type { ProjectFile } from "../protocol";

const files: ProjectFile[] = [
  { path: "src/components/CodeEditor.tsx", changed: true },
  { path: "src/daemon.ts", changed: false },
  { path: "src/lib/codemirrorTheme.ts", changed: false },
  { path: "package.json", changed: false },
  { path: "crates/warpforge-protocol/src/lib.rs", changed: false },
];

function setup(props: Partial<React.ComponentProps<typeof QuickOpen>> = {}) {
  const onPick = vi.fn<(path: string) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <QuickOpen
      open
      files={files}
      loading={false}
      error={null}
      onPick={onPick}
      onClose={onClose}
      {...props}
    />,
  );
  return { onPick, onClose };
}

describe("QuickOpen", () => {
  it("renders all files with an empty query", () => {
    setup();
    expect(screen.getByPlaceholderText("Jump to file…")).toBeInTheDocument();
    expect(screen.getByText("src/daemon.ts")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByPlaceholderText("Jump to file…")).not.toBeInTheDocument();
  });

  it("filters by query using the composer ranker", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText("Jump to file…"), {
      target: { value: "daemon" },
    });
    expect(screen.getByText("src/daemon.ts")).toBeInTheDocument();
    expect(screen.queryByText("package.json")).not.toBeInTheDocument();
  });

  it("picks the active file on Enter", () => {
    const { onPick, onClose } = setup();
    fireEvent.change(screen.getByPlaceholderText("Jump to file…"), {
      target: { value: "code" },
    });
    const input = screen.getByPlaceholderText("Jump to file…");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("src/components/CodeEditor.tsx");
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates with arrow keys before picking", () => {
    const { onPick } = setup();
    const input = screen.getByPlaceholderText("Jump to file…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: ".ts" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    // The second ranked ".ts" file (after CodeEditor) is daemon.ts (not rs/json).
    expect(onPick).toHaveBeenCalledWith("src/daemon.ts");
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByPlaceholderText("Jump to file…"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a loading state", () => {
    setup({ loading: true, files: [] });
    expect(screen.getByText("Loading files…")).toBeInTheDocument();
  });
});