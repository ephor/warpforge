import { describe, expect, it } from "vitest";

import { inlineHtmlImages } from "./trackerMarkdown";

describe("inlineHtmlImages", () => {
  it("rewrites the tag GitHub's upload widget pastes", () => {
    const body =
      'Before\n<img width="1042" height="690" alt="Image" src="https://github.com/user-attachments/assets/abc" />\nAfter';

    expect(inlineHtmlImages(body)).toBe(
      "Before\n![Image](https://github.com/user-attachments/assets/abc)\nAfter",
    );
  });

  it("handles single quotes, unquoted values and a missing alt", () => {
    expect(inlineHtmlImages("<img src='https://example.com/a.png'>")).toBe(
      "![Image](https://example.com/a.png)",
    );
    expect(inlineHtmlImages("<img src=https://example.com/b.png>")).toBe(
      "![Image](https://example.com/b.png)",
    );
  });

  it("drops sources the renderer must not follow", () => {
    expect(inlineHtmlImages('<img src="javascript:alert(1)" alt="x">')).toBe("");
    expect(inlineHtmlImages('<img src="data:image/png;base64,AAA">')).toBe("");
    expect(inlineHtmlImages('<img alt="no src">')).toBe("");
  });

  it("keeps an alt from breaking out of the link syntax", () => {
    expect(inlineHtmlImages('<img alt="a](b) c" src="https://example.com/c.png">')).toBe(
      "![ab c](https://example.com/c.png)",
    );
  });

  it("rewrites every tag and leaves the rest of the markdown alone", () => {
    const body =
      '# Title\n<img src="https://example.com/1.png">\n\n- item\n<img src="https://example.com/2.png">';

    expect(inlineHtmlImages(body)).toBe(
      "# Title\n![Image](https://example.com/1.png)\n\n- item\n![Image](https://example.com/2.png)",
    );
  });

  it("leaves a body with no images untouched", () => {
    const body = "Plain **markdown** with a [link](https://example.com).";
    expect(inlineHtmlImages(body)).toBe(body);
  });
});
