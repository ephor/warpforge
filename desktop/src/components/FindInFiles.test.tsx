import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SymbolMatch } from "../protocol";
import { FindInFiles } from "./FindInFiles";

const matches: SymbolMatch[] = [
  { column: 4, line: 26, path: "crates/warpforge-protocol/src/lib.rs", text: "fn default_true()" },
  { column: 22, line: 187, path: "crates/warpforge-protocol/src/lib.rs", text: '"default_true"' },
  { column: 1, line: 3, path: "src/config.rs", text: "use default_true;" },
];

function setup(props: Partial<React.ComponentProps<typeof FindInFiles>> = {}) {
  const onPick = vi.fn<(path: string, line: number, column: number) => void>();
  const onClose = vi.fn<() => void>();
  const onSearch = vi.fn<(query: string) => Promise<SymbolMatch[]>>(async () => matches);
  const loadFile = vi.fn<(path: string) => Promise<string>>(async () => "one\ntwo\nthree\n");
  render(
    <FindInFiles
      open
      onSearch={onSearch}
      loadFile={loadFile}
      onPick={onPick}
      onClose={onClose}
      {...props}
    />,
  );
  return { loadFile, onClose, onPick, onSearch };
}

async function search(query = "default_true") {
  fireEvent.change(screen.getByPlaceholderText("Find in files…"), { target: { value: query } });
  await waitFor(() => expect(screen.getByText("187")).toBeInTheDocument());
}

describe("FindInFiles", () => {
  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByPlaceholderText("Find in files…")).not.toBeInTheDocument();
  });

  it("groups matches by file and counts them", async () => {
    setup();
    await search();
    expect(screen.getByText("3 results in 2 files")).toBeInTheDocument();
    // Twice: the result group header and the preview header of the active hit.
    expect(screen.getAllByText("lib.rs")).toHaveLength(2);
    expect(screen.getAllByText("crates/warpforge-protocol/src")).toHaveLength(2);
  });

  it("opens the active match at its line on Enter", async () => {
    const { onClose, onPick } = setup();
    await search();
    const input = screen.getByPlaceholderText("Find in files…");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("crates/warpforge-protocol/src/lib.rs", 187, 22);
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a clicked match", async () => {
    const { onPick } = setup();
    await search();
    fireEvent.mouseDown(screen.getByText("3").closest("button")!);
    expect(onPick).toHaveBeenCalledWith("src/config.rs", 3, 1);
  });

  it("closes on Escape and on an overlay click", async () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByPlaceholderText("Find in files…"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const overlay = document.querySelector(".fixed.inset-0")!;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("previews the active match's file", async () => {
    const { loadFile } = setup();
    await search();
    await waitFor(() =>
      expect(loadFile).toHaveBeenCalledWith("crates/warpforge-protocol/src/lib.rs"),
    );
  });
});
