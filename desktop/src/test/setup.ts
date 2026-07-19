// Registers jest-dom matchers globally for every Vitest environment.
// eslint-disable-next-line import/no-unassigned-import
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Node can expose a localStorage accessor that throws unless a backing file is
// configured. Zustand persistence should behave like it does in the Tauri webview.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  },
});
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
