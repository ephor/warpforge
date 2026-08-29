import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
import type { DaemonState } from "@/daemon";
import type { AgentAccountLimits, AgentSpend } from "@/protocol";

import { AgentLimitsSection } from "./AgentLimitsSection";

const NOW = 1_700_000_000;

function accountState(overrides: Partial<AgentAccountLimits>): AgentAccountLimits {
  return {
    accountId: "claude:personal",
    agentId: "claude",
    label: "Personal",
    active: true,
    windows: [{ id: "five_hour", label: "Session", usedPercent: 40 }],
    exhausted: false,
    fetchedAt: NOW,
    source: "api",
    ...overrides,
  };
}

const baseState: DaemonState = {
  connection: "connected",
  connectionError: null,
  pendingAgentSetup: null,
  serviceLogs: {},
  portforwardLogs: {},
  sessionUpdates: {},
  snapshot: {
    projects: [],
    services: [],
    portforwards: [],
    tasks: [],
    terminals: [],
  },
};

function mockDaemon(accounts: AgentAccountLimits[] | null, agentSpend: AgentSpend[] | null) {
  vi.spyOn(daemon, "subscribe").mockReturnValue(() => {});
  vi.spyOn(daemon, "getState").mockImplementation(() => ({
    ...baseState,
    agentLimits: accounts,
    agentSpend,
  }));
  vi.spyOn(daemon, "listAgentLimits").mockResolvedValue(accounts ?? []);
  vi.spyOn(daemon, "listAgentSpend").mockResolvedValue(agentSpend ?? []);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentLimitsSection spend", () => {
  it("shows a harness's spend once, not once per account", async () => {
    mockDaemon(
      [
        accountState({ accountId: "claude:personal", label: "Personal" }),
        accountState({ accountId: "claude:work", label: "Work", active: false }),
      ],
      [{ agentId: "claude", todayUsd: 12.34, totalUsd: 567.89, tasks: 4, reported: true }],
    );
    render(<AgentLimitsSection />);

    expect(await screen.findByText("$12.34")).toBeInTheDocument();
    // Two accounts, one harness: the dollars appear once or they read as double.
    expect(screen.getAllByText("$12.34")).toHaveLength(1);
    expect(screen.getAllByText("$567.89")).toHaveLength(1);
    expect(screen.getAllByText("Today")).toHaveLength(1);
  });

  it("says a harness does not report cost instead of showing $0.00", async () => {
    mockDaemon(
      [accountState({ accountId: "codex:live", agentId: "codex", label: "Signed in" })],
      [{ agentId: "codex", todayUsd: null, totalUsd: null, tasks: 0, reported: false }],
    );
    render(<AgentLimitsSection />);

    expect(await screen.findByText("not reported")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("renders no spend line when a reporting harness has no numbers yet", async () => {
    mockDaemon(
      [accountState({})],
      [{ agentId: "claude", todayUsd: null, totalUsd: null, tasks: 0, reported: true }],
    );
    render(<AgentLimitsSection />);

    expect(await screen.findByText("60% left")).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.queryByText("not reported")).not.toBeInTheDocument();
  });

  it("keeps the cards when the daemon cannot report spend at all", async () => {
    mockDaemon([accountState({})], null);
    vi.spyOn(daemon, "listAgentSpend").mockRejectedValue(new Error("unknown method"));
    render(<AgentLimitsSection />);

    expect(await screen.findByText("60% left")).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("footnotes the numbers as API-rate estimates, once", async () => {
    mockDaemon(
      [
        accountState({ accountId: "claude:personal" }),
        accountState({ accountId: "codex:live", agentId: "codex", label: "Signed in" }),
      ],
      [
        { agentId: "claude", todayUsd: 1.23, totalUsd: 4.56, tasks: 2, reported: true },
        { agentId: "codex", todayUsd: null, totalUsd: null, tasks: 0, reported: false },
      ],
    );
    render(<AgentLimitsSection />);

    const note = await screen.findAllByText("Estimated at API rates — not what you were billed.");
    expect(note).toHaveLength(1);
  });
});
