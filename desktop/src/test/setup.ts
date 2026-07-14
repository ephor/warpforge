import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

Object.defineProperty(URL, "createObjectURL", { writable: true, value: vi.fn(() => "blob:preview") });
Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: vi.fn() });
Object.defineProperty(globalThis, "crypto", { writable: true, value: { randomUUID: vi.fn(() => "uuid") } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
