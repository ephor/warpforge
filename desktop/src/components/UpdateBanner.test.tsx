import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdaterState } from "@/lib/updater";

import { UpdateBanner } from "./UpdateBanner";

let state: UpdaterState = { currentVersion: "0.6.7", status: "idle" };
const download = vi.fn<() => Promise<void>>(async () => {});
const installAndRestart = vi.fn<() => Promise<void>>(async () => {});

vi.mock("@/lib/updater", () => ({
  updater: {
    download: () => download(),
    getState: () => state,
    installAndRestart: () => installAndRestart(),
    subscribe: () => () => {},
  },
}));

beforeEach(() => {
  download.mockClear();
  installAndRestart.mockClear();
});

describe("UpdateBanner", () => {
  it("stays out of the way when there is nothing to update", () => {
    state = { currentVersion: "0.6.7", status: "upToDate" };
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the version and downloads on click", () => {
    state = { currentVersion: "0.6.7", nextVersion: "0.6.8", status: "available" };
    render(<UpdateBanner />);
    fireEvent.click(screen.getByText("Update to 0.6.8"));
    expect(download).toHaveBeenCalled();
  });

  it("shows download progress and blocks a second click", () => {
    state = { currentVersion: "0.6.7", nextVersion: "0.6.8", progress: 42, status: "downloading" };
    render(<UpdateBanner />);
    const button = screen.getByText("Downloading 42%").closest("button")!;
    expect(button).toBeDisabled();
  });

  it("restarts once the update is ready", () => {
    state = { currentVersion: "0.6.7", nextVersion: "0.6.8", status: "ready" };
    render(<UpdateBanner />);
    fireEvent.click(screen.getByText("Restart to update"));
    expect(installAndRestart).toHaveBeenCalled();
  });

  it("keeps a failed update visible", () => {
    state = {
      currentVersion: "0.6.7",
      error: "network down",
      nextVersion: "0.6.8",
      status: "error",
    };
    render(<UpdateBanner />);
    expect(screen.getByText("Update failed — retry")).toBeInTheDocument();
  });
});
