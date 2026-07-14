import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

Object.defineProperty(URL, "createObjectURL", {
  value: vi.fn<(object: Blob | MediaSource) => string>(() => "blob:preview"),
  writable: true,
});
Object.defineProperty(URL, "revokeObjectURL", {
  value: vi.fn<(url: string) => void>(),
  writable: true,
});
Object.defineProperty(globalThis, "crypto", {
  value: { randomUUID: vi.fn<() => string>(() => "uuid") },
  writable: true,
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
