import { beforeEach, describe, expect, it, vi } from "vitest";

const { check, prepareUpdateHandoff, resumeAfterFailedUpdate, update } = vi.hoisted(() => ({
  check: vi.fn<() => Promise<unknown>>(),
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
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
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
    check.mockResolvedValue(update);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("explains that the update feed is unavailable before the first desktop release", async () => {
    check.mockRejectedValueOnce(
      new Error("Could not fetch a valid release JSON from the remote"),
    );
    const updater = new DesktopUpdater();

    await updater.check();

    expect(updater.getState()).toMatchObject({
      error:
        "The published update feed is not available yet. This is expected before the first signed desktop release is published; try again later.",
      status: "error",
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
