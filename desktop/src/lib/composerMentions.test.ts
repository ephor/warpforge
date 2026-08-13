import { describe, expect, it } from "vitest";

import {
  extractFileReferences,
  findMentionAtCaret,
  mentionToken,
  rankFiles,
  replaceMention,
  splitFileReference,
} from "./composerMentions";

const files = [
  { changed: false, path: "src/app.ts" },
  { changed: true, path: "src/components/AppShell.tsx" },
  { changed: false, path: "docs/my file.md" },
];

describe("composer mentions", () => {
  it("finds a mention at the caret and inserts quoted paths", () => {
    const mention = findMentionAtCaret("review @my", 10)!;
    expect(mention.query).toBe("my");
    expect(replaceMention("review @my", mention, "docs/my file.md").value).toBe(
      'review @"docs/my file.md" ',
    );
  });

  it("ranks basename prefixes ahead of full-path and substring matches", () => {
    expect(rankFiles(files, "app").map((file) => file.path)).toStrictEqual([
      "src/app.ts",
      "src/components/AppShell.tsx",
    ]);
    expect(rankFiles(files, "src/c")[0].path).toBe("src/components/AppShell.tsx");
  });

  it("extracts plain and quoted unique references", () => {
    expect(
      extractFileReferences('check @src/app.ts and @"docs/my file.md" then @src/app.ts'),
    ).toStrictEqual(["src/app.ts", "docs/my file.md"]);
  });

  it("parses and renders #L line ranges on file references", () => {
    expect(splitFileReference("src/app.ts")).toStrictEqual({
      path: "src/app.ts",
      range: undefined,
    });
    expect(splitFileReference("src/app.ts#L2-5")).toStrictEqual({
      path: "src/app.ts",
      range: { start: 2, end: 5 },
    });
    expect(splitFileReference("docs/my file.md#L7")).toStrictEqual({
      path: "docs/my file.md",
      range: { start: 7, end: 7 },
    });
    expect(mentionToken("src/app.ts", { start: 2, end: 5 })).toBe("@src/app.ts#L2-5");
    expect(mentionToken("src/app.ts", { start: 7, end: 7 })).toBe("@src/app.ts#L7");
    expect(mentionToken("docs/my file.md", { start: 1, end: 3 })).toBe(
      '@"docs/my file.md"#L1-3',
    );
    expect(mentionToken("src/app.ts")).toBe("@src/app.ts");
  });

  it("roundtrips ranges rendered as a token", () => {
    const token = mentionToken("src/app.ts", { start: 2, end: 5 });
    expect(splitFileReference(token.slice(1))).toStrictEqual({
      path: "src/app.ts",
      range: { start: 2, end: 5 },
    });
  });
});
