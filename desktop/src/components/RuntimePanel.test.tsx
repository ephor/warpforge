import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import type { ServiceInfo } from "../protocol";
import { RuntimePanel } from "./RuntimePanel";

const service: ServiceInfo = {
  allocatedPort: 4000,
  command: "bun run dev",
  logSeq: 0,
  name: "web",
  originalPort: 3000,
  project: "warpforge",
  status: "running",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RuntimePanel", () => {
  it("uses a stable empty log snapshot while the initial log request is pending", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));

    expect(() =>
      render(<RuntimePanel project="warpforge" services={[service]} portforwards={[]} />),
    ).not.toThrow();
    expect(screen.getByText("[web] no logs yet")).toBeInTheDocument();
  });
});
