import { describe, expect, it } from "vitest";

import type { AttachmentDraft } from "./fileAttachments";
import { buildAttachments, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "./fileAttachments";

/** jsdom's File has no working arrayBuffer(), so back it with real bytes. */
function makeFile(name: string, type: string, bytes: Uint8Array<ArrayBuffer> | string): File {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const file = new File([data], name, { type });
  Object.defineProperty(file, "arrayBuffer", { value: async () => data.buffer });
  Object.defineProperty(file, "size", { value: data.byteLength });
  return file;
}

const supported = { imageSupported: true };

describe("file attachments", () => {
  it("turns a text file into a document attachment and guesses its MIME type", async () => {
    const { drafts, error } = await buildAttachments(
      [makeFile("notes.md", "", "# hello")],
      [],
      supported,
    );

    expect(error).toBeNull();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      attachment: {
        mimeType: "text/markdown",
        name: "notes.md",
        text: "# hello",
        type: "document",
      },
      kind: "document",
      name: "notes.md",
    });
  });

  it("keeps images on the image path", async () => {
    const png = makeFile("shot.png", "image/png", "png-bytes");
    const { drafts, error } = await buildAttachments([png], [], supported);

    expect(error).toBeNull();
    expect(drafts[0].kind).toBe("image");
    expect(drafts[0].attachment.type).toBe("image");
  });

  it("rejects binary files that are neither text nor a supported image", async () => {
    const binary = makeFile("app.bin", "", new Uint8Array([0, 1, 2, 0xff, 0xfe]));
    const { drafts, error } = await buildAttachments([binary], [], supported);

    expect(drafts).toHaveLength(0);
    expect(error).toMatch(/not a text file/);
  });

  it("reports a read failure instead of rejecting, as a dropped folder does", async () => {
    const folder = new File([], "some-folder", { type: "" });
    Object.defineProperty(folder, "arrayBuffer", {
      value: async () => {
        throw new DOMException("not found", "NotFoundError");
      },
    });

    await expect(buildAttachments([folder], [], supported)).resolves.toEqual({
      drafts: [],
      error: "Could not read one of the selected files.",
    });
  });

  it("rejects text that decodes cleanly but carries NUL bytes", async () => {
    const nulled = makeFile("weird.txt", "text/plain", new Uint8Array([0x61, 0x00, 0x62]));

    expect((await buildAttachments([nulled], [], supported)).error).toMatch(/not a text file/);
  });

  it("enforces the per-file, count, and combined limits", async () => {
    const big = makeFile("big.txt", "text/plain", "a".repeat(MAX_DOCUMENT_BYTES + 1));
    expect((await buildAttachments([big], [], supported)).error).toMatch(/512 KiB/);

    const tooMany = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) =>
      makeFile(`f${i}.txt`, "text/plain", "x"),
    );
    expect((await buildAttachments(tooMany, [], supported)).error).toMatch(
      new RegExp(`up to ${MAX_DOCUMENTS}`),
    );

    const halfMeg = () => makeFile("part.txt", "text/plain", "a".repeat(MAX_DOCUMENT_BYTES));
    const five = Array.from({ length: 5 }, halfMeg);
    expect((await buildAttachments(five, [], supported)).error).toMatch(/2 MiB/);
  });

  it("counts already-attached documents against the limits", async () => {
    const first = await buildAttachments(
      [makeFile("a.txt", "text/plain", "a".repeat(MAX_DOCUMENT_BYTES))],
      [],
      supported,
    );
    const existing: AttachmentDraft[] = first.drafts;
    const rest = Array.from({ length: 4 }, () =>
      makeFile("b.txt", "text/plain", "b".repeat(MAX_DOCUMENT_BYTES)),
    );

    // The same four files fit on their own but not on top of the existing one.
    expect((await buildAttachments(rest, [], supported)).error).toBeNull();
    expect((await buildAttachments(rest, existing, supported)).error).toMatch(/2 MiB/);
  });

  it("rejects images when the agent has no image capability but still takes documents", async () => {
    const png = makeFile("shot.png", "image/png", "png-bytes");
    expect((await buildAttachments([png], [], { imageSupported: false })).error).toMatch(
      /does not support images/,
    );

    const { drafts, error } = await buildAttachments(
      [makeFile("notes.md", "text/markdown", "hi")],
      [],
      { imageSupported: false },
    );
    expect(error).toBeNull();
    expect(drafts).toHaveLength(1);
  });
});
