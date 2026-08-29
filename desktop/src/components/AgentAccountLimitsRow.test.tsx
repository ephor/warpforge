import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentAccountLimits } from "@/protocol";

import { AgentAccountLimitsRow } from "./AgentAccountLimitsRow";

const NOW_SEC = () => Math.floor(Date.now() / 1000);

function account(overrides: Partial<AgentAccountLimits>): AgentAccountLimits {
  return {
    accountId: "claude:personal",
    agentId: "claude",
    label: "Personal",
    active: true,
    windows: [{ id: "five_hour", label: "Session", usedPercent: 40 }],
    exhausted: false,
    fetchedAt: NOW_SEC(),
    source: "api",
    ...overrides,
  };
}

describe("AgentAccountLimitsRow failure presentation", () => {
  it("marks a failed refresh with a quiet triangle, keeping the last good numbers", () => {
    // The daemon keeps serving the previous snapshot when a usage endpoint
    // throttles us, so the numbers are late, not wrong: no red paragraph.
    const { container } = render(
      <AgentAccountLimitsRow
        account={account({ error: "usage endpoint throttled" })}
        showLabel={false}
      />,
    );

    expect(screen.getByTitle("usage endpoint throttled")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Last refresh failed: usage endpoint throttled" }),
    ).toBeInTheDocument();
    expect(screen.getByText("60% left")).toBeInTheDocument();
    // The message lives in the tooltip only — no error line, red or otherwise.
    expect(screen.queryByText("usage endpoint throttled")).not.toBeInTheDocument();
    expect(container.querySelector("p.text-red-600")).toBeNull();
  });

  it("spells the failure out when there are no numbers to look at", () => {
    render(
      <AgentAccountLimitsRow
        account={account({ error: "Not logged in", windows: [] })}
        showLabel={false}
      />,
    );

    expect(screen.getByText("Not logged in")).toBeInTheDocument();
  });

  it("still says so when an account simply reported no windows", () => {
    render(<AgentAccountLimitsRow account={account({ windows: [] })} showLabel={false} />);

    expect(screen.getByText("No usage windows reported.")).toBeInTheDocument();
  });
});

describe("AgentAccountLimitsRow layout", () => {
  it("carries the timestamp in the foot row, beside the action", () => {
    // It used to sit in the header, where the harness name, account label and
    // badges had already pushed it onto a second line.
    render(
      <AgentAccountLimitsRow
        account={account({})}
        showLabel
        action={<span>Use this account</span>}
      />,
    );

    const stamp = screen.getByTitle("source: api");
    expect(stamp).toHaveTextContent("updated just now");
    const foot = stamp.parentElement;
    expect(foot).toHaveTextContent("Use this account");
    // The separated foot row, not the header.
    expect(foot?.className).toContain("border-t");
  });

  it("keeps the foot row on a card with no action, so the timestamp still shows", () => {
    // The settings list renders these cards without any action at all.
    render(<AgentAccountLimitsRow account={account({})} showLabel={false} />);

    expect(screen.getByTitle("source: api")).toHaveTextContent("updated just now");
  });
});

describe("AgentAccountLimitsRow staleness", () => {
  it("tags a snapshot older than a poll cycle, with the precise age on hover", () => {
    render(
      <AgentAccountLimitsRow
        account={account({ fetchedAt: NOW_SEC() - 3 * 3600 })}
        showLabel={false}
      />,
    );

    const tag = screen.getByText("Outdated");
    expect(tag).toBeInTheDocument();
    expect(tag).toHaveAttribute("title", "Last updated 3h ago");
  });

  it("leaves fresh data untagged", () => {
    render(<AgentAccountLimitsRow account={account({})} showLabel={false} />);

    expect(screen.queryByText("Outdated")).not.toBeInTheDocument();
  });
});
