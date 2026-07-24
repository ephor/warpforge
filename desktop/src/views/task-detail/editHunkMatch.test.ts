import { describe, expect, it } from "vitest";

import type { EditHunk, Hunk } from "../../protocol";
import { matchingHunkIndexes } from "./editHunkMatch";

const aggregateHunks: Hunk[] = [
  {
    lines: [" context", "-old first", "+new first"],
    newLines: 3,
    newStart: 10,
    oldLines: 3,
    oldStart: 10,
    resolution: null,
  },
  {
    lines: [" context", "-old second", "+new second"],
    newLines: 3,
    newStart: 80,
    oldLines: 3,
    oldStart: 80,
    resolution: null,
  },
];

describe("matchingHunkIndexes", () => {
  it("uses the concrete ACP changed lines even when later edits shifted coordinates", () => {
    const edit: EditHunk = {
      lines: ["-old second", "+new second"],
      newLines: 1,
      newStart: 12,
      oldLines: 1,
      oldStart: 12,
    };

    expect(matchingHunkIndexes(aggregateHunks, [edit])).toEqual([1]);
  });

  it("falls back to the nearest coordinates when changed content no longer matches", () => {
    const edit: EditHunk = {
      lines: ["-superseded", "+also superseded"],
      newLines: 1,
      newStart: 11,
      oldLines: 1,
      oldStart: 11,
    };

    expect(matchingHunkIndexes(aggregateHunks, [edit])).toEqual([0]);
  });
});
