import { describe, expect, it } from "vitest";

import {
  extractFileReferences,
  findMentionAtCaret,
  rankFiles,
  replaceMention,
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
});
