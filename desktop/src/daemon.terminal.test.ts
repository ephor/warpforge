import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "./daemon";

describe("base64ToBytes", () => {
  it("decodes empty string", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });

  it("decodes ASCII text", () => {
    const b64 = btoa("hello");
    const result = base64ToBytes(b64);
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  it("decodes binary bytes including 0x00 and 0xff", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = btoa(binary);
    const result = base64ToBytes(b64);
    expect(result).toEqual(bytes);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const b64 = bytesToBase64(bytes);
    const decoded = base64ToBytes(b64);
    expect(decoded).toEqual(bytes);
  });
});

describe("bytesToBase64", () => {
  it("encodes empty Uint8Array", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("encodes ASCII text", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(bytesToBase64(bytes)).toBe(btoa("hello"));
  });

  it("encodes binary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    expect(bytesToBase64(bytes)).toBe(btoa(binary));
  });
});
