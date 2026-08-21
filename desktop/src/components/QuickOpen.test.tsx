import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectFile, SymbolMatch } from "../protocol";
import { QuickOpen } from "./QuickOpen";

const files: ProjectFile[] = [
  { path: "src/components/CodeEditor.tsx", changed: true },
  { path: "src/daemon.ts", changed: false },
  { path: "src/lib/codemirrorTheme.ts", changed: false },
  { path: "package.json", changed: false },
  { path: "crates/warpforge-protocol/src/lib.rs", changed: false },
];

function setup(props: Partial<React.ComponentProps<typeof QuickOpen>> = {}) {
  const onPick = vi.fn<(path: string, location?: { line: number; column: number }) => void>();
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

  it("closes on an overlay click", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(document.querySelector(".fixed.inset-0")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a spinner while the text search is in flight", async () => {
    let release: (matches: SymbolMatch[]) => void = () => {};
    const onSearch = vi.fn<(query: string) => Promise<SymbolMatch[]>>(
      () => new Promise((resolve) => (release = resolve)),
    );
    setup({ onSearch });
    fireEvent.change(screen.getByPlaceholderText("Jump to file…"), {
      target: { value: "daemon" },
    });
    // Shown from the keystroke, before the debounced request even starts.
    expect(await screen.findByText("Searching text")).toBeInTheDocument();
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("daemon"));
    release([]);
    await waitFor(() => expect(screen.queryByText("Searching text")).not.toBeInTheDocument());
  });

  it("lists text matches under the files and opens them at their line", async () => {
    const onSearch = vi.fn<(query: string) => Promise<SymbolMatch[]>>(async () => [
      { column: 7, line: 42, path: "src/daemon.ts", text: "const daemonPort = 61814;" },
    ]);
    const { onPick } = setup({ onSearch });
    fireEvent.change(screen.getByPlaceholderText("Jump to file…"), {
      target: { value: "daemonPort" },
    });
    await screen.findByText("daemon.ts:42");
    fireEvent.mouseDown(screen.getByText("daemon.ts:42").closest("button")!);
    expect(onPick).toHaveBeenCalledWith("src/daemon.ts", { column: 7, line: 42 });
  });
});
