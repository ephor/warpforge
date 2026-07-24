import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FileDiff, HunkResolution } from "../../protocol";
import { hunkAnchor } from "./diffAnchors";
import { FileDiffView } from "./FileDiffView";

const file: FileDiff = {
  hunks: [
    {
      lines: [" context", "-old", "+new"],
      newLines: 2,
      newStart: 4,
      oldLines: 2,
      oldStart: 4,
      resolution: null,
    },
  ],
  oldPath: null,
  path: "src/main.rs",
  status: "modified",
};

describe("FileDiffView edit highlighting", () => {
  it("temporarily expands and highlights a targeted hunk", () => {
    const onResolve = vi.fn<(file: string, hunkIndex: number, r: HunkResolution) => void>();
    const { container, rerender } = render(
      <FileDiffView file={file} localRes={{}} onResolve={onResolve} />,
    );
    fireEvent.click(container.querySelector("button")!);
    expect(document.getElementById(hunkAnchor(file.path, 0))).toBeNull();

    rerender(
      <FileDiffView
        file={file}
        highlightedHunks={new Set([0])}
        localRes={{}}
        onResolve={onResolve}
      />,
    );

    expect(document.getElementById(hunkAnchor(file.path, 0))).toHaveClass("bg-primary/10");
  });
});
