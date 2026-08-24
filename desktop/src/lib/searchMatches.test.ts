import { describe, expect, it } from "vitest";

import type { SymbolMatch } from "../protocol";
import { groupMatchesByFile, highlightSegments, previewWindow, splitPath } from "./searchMatches";

const match = (path: string, line: number, text = "hit"): SymbolMatch => ({
  column: 1,
  line,
  path,
  text,
});

describe("groupMatchesByFile", () => {
  it("groups hits per file keeping the daemon's order", () => {
    const groups = groupMatchesByFile([
      match("a.ts", 1),
      match("a.ts", 9),
      match("b.ts", 4),
      match("a.ts", 12),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts"]);
    expect(groups[0].matches.map((m) => m.line)).toEqual([1, 9, 12]);
    expect(groups[1].matches.map((m) => m.line)).toEqual([4]);
  });
});

describe("highlightSegments", () => {
  it("marks every case-insensitive occurrence", () => {
    const segments = highlightSegments("Foo and foo", "foo");
    expect(segments).toEqual([
      { hit: true, start: 0, text: "Foo" },
      { hit: false, start: 3, text: " and " },
      { hit: true, start: 8, text: "foo" },
    ]);
  });

  it("returns the whole line when the query is empty", () => {
    expect(highlightSegments("plain", "")).toEqual([{ hit: false, start: 0, text: "plain" }]);
  });
});

describe("splitPath", () => {
  it("splits a nested path", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib", name: "a.ts" });
  });

  it("leaves a root file without a directory", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("previewWindow", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

  it("centers the window on the match line", () => {
    const window = previewWindow(text, 10, 2);
    expect(window.firstLine).toBe(8);
    expect(window.lines).toEqual(["line 8", "line 9", "line 10", "line 11", "line 12"]);
  });

  it("clamps at the top of the file", () => {
    const window = previewWindow(text, 2, 5);
    expect(window.firstLine).toBe(1);
    expect(window.lines[0]).toBe("line 1");
  });
});
