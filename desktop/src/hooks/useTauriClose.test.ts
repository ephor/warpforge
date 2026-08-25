import { renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemon, type DaemonState } from "@/daemon";
import type { ServiceInfo, ServiceStatus } from "@/protocol";

import { useTauriClose } from "./useTauriClose";

/** The close-requested handler the hook registers with the window. */
type CloseHandler = (event: { preventDefault: () => void }) => Promise<void> | void;

let closeHandler: CloseHandler | null = null;
const close = vi.fn<() => Promise<void>>().mockResolvedValue();
const unlisten = vi.fn<() => void>();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close,
    onCloseRequested: (handler: CloseHandler) => {
      closeHandler = handler;
      return Promise.resolve(unlisten);
    },
  }),
}));

function service(name: string, status: ServiceStatus): ServiceInfo {
  return {
    project: "warpforge",
    name,
    command: `run ${name}`,
    status,
    originalPort: 3000,
    allocatedPort: 4000,
    logSeq: 0,
  };
}

function withServices(services: ServiceInfo[]) {
  vi.spyOn(daemon, "getState").mockReturnValue({
    snapshot: { services },
  } as unknown as DaemonState);
}

/**
 * Render the hook and wait until it has registered with the window. Under
 * StrictMode, because the app runs that way: the double mount unregisters the
 * first listener while the second is still resolving its dynamic import, which
 * is exactly where a quit can end up with a listener nobody answers.
 */
async function renderRegistered() {
  const view = renderHook(() => useTauriClose(), {
    wrapper: ({ children }) => createElement(StrictMode, null, children),
  });
  await waitFor(() => expect(closeHandler).not.toBeNull());
  return view;
}

beforeEach(() => {
  closeHandler = null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  delete (window as unknown as Record<string, unknown>).__warpforgeQuitting;
  vi.spyOn(daemon, "stopRuntime").mockResolvedValue(undefined);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).__warpforgeQuitting;
  vi.restoreAllMocks();
  close.mockClear();
  unlisten.mockClear();
});

describe("useTauriClose", () => {
  it("quits straight away when nothing is running", async () => {
    withServices([service("api", "stopped")]);
    const { result } = await renderRegistered();

    const event = { preventDefault: vi.fn<() => void>() };
    await closeHandler!(event);

    // The close is refused first, then re-issued once the runtime is down —
    // otherwise the window goes while services are still up.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(daemon.stopRuntime).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("asks first when services are running, and quits on the answer", async () => {
    withServices([service("api", "running"), service("web", "starting")]);
    const { result, rerender } = await renderRegistered();

    await closeHandler!({ preventDefault: vi.fn<() => void>() });
    rerender();

    expect(close).not.toHaveBeenCalled();
    expect(result.current?.services).toEqual(["warpforge/api", "warpforge/web"]);
    expect(result.current?.more).toBe(0);

    await result.current!.confirm();
    expect(daemon.stopRuntime).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("counts the services it does not name", async () => {
    withServices(["a", "b", "c", "d", "e", "f"].map((name) => service(name, "running")));
    const { result, rerender } = await renderRegistered();

    await closeHandler!({ preventDefault: vi.fn<() => void>() });
    rerender();

    expect(result.current?.services).toHaveLength(4);
    expect(result.current?.more).toBe(2);
  });

  // A hot reload leaves the previous generation's listener registered with the
  // window. Refusing the close on behalf of a flag only that generation can see
  // is how a dev session ends up with a window that will not close at all.
  it("does not refuse a quit another listener has already started", async () => {
    withServices([service("api", "running")]);
    const stale = await renderRegistered();
    const staleHandler = closeHandler!;
    closeHandler = null;
    const fresh = await renderRegistered();
    const freshHandler = closeHandler!;

    await freshHandler({ preventDefault: vi.fn<() => void>() });
    fresh.rerender();
    await fresh.result.current!.confirm();
    expect(close).toHaveBeenCalled();

    const event = { preventDefault: vi.fn<() => void>() };
    await staleHandler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(stale.result.current).toBeNull();
  });

  it("lets the window go on the second request, once the quit is under way", async () => {
    withServices([service("api", "running")]);
    const { result, rerender } = await renderRegistered();

    await closeHandler!({ preventDefault: vi.fn<() => void>() });
    rerender();
    await result.current!.confirm();

    // `close()` asks the window to close again; that request must pass through
    // rather than putting the same question back up.
    const second = { preventDefault: vi.fn<() => void>() };
    await closeHandler!(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });
});
