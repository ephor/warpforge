import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepareUpdateHandoff, resumeAfterFailedUpdate, update } = vi.hoisted(() => ({
  prepareUpdateHandoff: vi.fn<() => Promise<never>>(),
  resumeAfterFailedUpdate: vi.fn<() => void>(),
  update: {
    body: "Safer updates",
    download: vi.fn<() => Promise<void>>(async () => {}),
    install: vi.fn<() => Promise<void>>(async () => {}),
    version: "0.2.0",
  },
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => update }));
vi.mock("@/daemon", () => ({
  daemon: {
    prepareUpdateHandoff,
    resumeAfterFailedUpdate,
    waitForDisconnect: vi.fn<() => Promise<void>>(async () => {}),
  },
}));

import { DesktopUpdater } from "./updater";

describe("DesktopUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("keeps a downloaded update ready when daemon handoff is refused", async () => {
    prepareUpdateHandoff.mockRejectedValueOnce(new Error("external daemon"));
    const updater = new DesktopUpdater();

    await updater.check();
    await updater.download();
    await updater.installAndRestart();

    expect(updater.getState()).toMatchObject({
      error: "external daemon",
      nextVersion: "0.2.0",
      status: "ready",
    });
    expect(update.install).not.toHaveBeenCalled();
    expect(resumeAfterFailedUpdate).toHaveBeenCalledOnce();
  });
});
