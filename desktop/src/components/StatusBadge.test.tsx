import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OrchNodeStatus, TaskStatus } from "@/protocol";

import { StatusBadge } from "./StatusBadge";

/**
 * The crash this guards against: a daemon older (or newer) than this build puts
 * a status on the wire that the visual map has never heard of, and every view
 * that draws a badge blanks out. A badge must always render *something*.
 */
describe("StatusBadge", () => {
  it("renders a legacy task status as waiting", () => {
    for (const status of ["idle", "needs_review"]) {
      const { unmount } = render(<StatusBadge status={status as TaskStatus} />);
      expect(screen.getByText("waiting")).toBeInTheDocument();
      unmount();
    }
  });

  it("renders an unknown task status instead of throwing", () => {
    expect(() =>
      render(<StatusBadge status={"from_a_newer_daemon" as TaskStatus} />),
    ).not.toThrow();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders an unknown task status in dot variant with an accessible label", () => {
    render(<StatusBadge status={"needs_review" as TaskStatus} variant="dot" />);
    expect(screen.getByTitle("waiting")).toBeInTheDocument();
  });

  it("renders a known orchestration node status", () => {
    render(<StatusBadge kind="node" status="complete" />);
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("renders an unknown orchestration node status instead of throwing", () => {
    expect(() =>
      render(<StatusBadge kind="node" status={"cancelled" as OrchNodeStatus} />),
    ).not.toThrow();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("still overlays a permission on the task axis", () => {
    render(<StatusBadge status="permission" />);
    expect(screen.getByText("permission")).toBeInTheDocument();
  });
});
