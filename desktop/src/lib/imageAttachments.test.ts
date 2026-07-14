import { describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES, validateImageFiles } from "./imageAttachments";

describe("image attachments", () => {
  it("accepts PNG and JPEG and rejects unsupported MIME/extensions", () => {
    expect(validateImageFiles([new File(["x"], "a.png", { type: "image/png" })])).toBeNull();
    expect(validateImageFiles([new File(["x"], "a.jpg", { type: "image/jpeg" })])).toBeNull();
    expect(validateImageFiles([new File(["x"], "a.gif", { type: "image/gif" })])).toMatch(
      /PNG or JPEG/,
    );
    expect(validateImageFiles([new File(["x"], "a.png", { type: "text/plain" })])).toMatch(
      /PNG or JPEG/,
    );
  });

  it("enforces per-image, count, and combined limits", () => {
    const huge = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "huge.png", { type: "image/png" });
    expect(validateImageFiles([huge])).toMatch(/5 MiB/);
    const small = () => new File(["x"], "a.png", { type: "image/png" });
    expect(validateImageFiles([small(), small(), small(), small(), small()])).toMatch(/up to 4/);
  });
});
