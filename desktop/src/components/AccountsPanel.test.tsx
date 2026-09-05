import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountInfo, AgentAccountLimits, AgentConfig, AgentSpend } from "@/protocol";

const {
  daemonState,
  importAccount,
  removeAccount,
  setActiveAccount,
  listAgentLimits,
  listAgentSpend,
} = vi.hoisted(() => ({
  daemonState: {
    agentLimits: null as AgentAccountLimits[] | null,
    agentSpend: null as AgentSpend[] | null,
    snapshot: { accounts: [] as AccountInfo[], agents: [] as AgentConfig[] },
  },
  importAccount: vi.fn<(agentId: string, label: string) => Promise<AccountInfo[]>>(),
  removeAccount: vi.fn<(accountId: string) => Promise<AccountInfo[]>>(),
  setActiveAccount: vi.fn<(agentId: string, accountId: string) => Promise<AccountInfo[]>>(),
  listAgentLimits: vi.fn<() => Promise<AgentAccountLimits[]>>(),
  listAgentSpend: vi.fn<() => Promise<AgentSpend[]>>(),
}));

vi.mock("@/daemon", () => ({
  daemon: {
    importAccount,
    listAgentLimits,
    listAgentSpend,
    removeAccount,
    setActiveAccount,
    // Must be a stable reference or useSyncExternalStore re-renders forever.
    subscribe: () => () => {},
    getState: () => daemonState,
  },
}));

import AccountsPanel from "./AccountsPanel";

const NOW = Math.floor(Date.now() / 1000);

const agent = (id: string, enabled = true): AgentConfig => ({
  acpCommand: `${id}-acp`,
  displayName: id === "claude" ? "Claude Code" : "Codex",
  enabled,
  id,
  models: [],
});

function limits(overrides: Partial<AgentAccountLimits>): AgentAccountLimits {
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

function spend(overrides: Partial<AgentSpend>): AgentSpend {
  return {
    agentId: "claude",
    todayUsd: 12.34,
    totalUsd: 56.78,
    tasks: 2,
    reported: true,
    ...overrides,
  };
}

describe("AccountsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importAccount.mockResolvedValue([]);
    removeAccount.mockResolvedValue([]);
    setActiveAccount.mockResolvedValue([]);
    listAgentLimits.mockResolvedValue([]);
    listAgentSpend.mockResolvedValue([]);
    daemonState.agentLimits = null;
    daemonState.agentSpend = null;
    daemonState.snapshot = { accounts: [], agents: [agent("claude")] };
  });

  it("explains how to get a first account instead of showing an empty list", () => {
    render(<AccountsPanel />);
    expect(screen.getByText(/Sign in to Claude Code, then import/)).toBeInTheDocument();
  });

  it("imports the current login under the typed name", async () => {
    const user = userEvent.setup();
    render(<AccountsPanel />);

    await user.type(screen.getByLabelText("New Claude Code account name"), "work");
    await user.click(screen.getByRole("button", { name: /Import current login/ }));

    await waitFor(() => expect(importAccount).toHaveBeenCalledWith("claude", "work"));
  });

  it("refuses to import without a name, since the name is the account's identity", async () => {
    render(<AccountsPanel />);
    expect(screen.getByRole("button", { name: /Import current login/ })).toBeDisabled();
  });

  it("activates a account on click and cannot re-activate the live one", async () => {
    const user = userEvent.setup();
    daemonState.snapshot = {
      accounts: [
        { active: true, agentId: "claude", id: "claude:personal", label: "personal" },
        { active: false, agentId: "claude", id: "claude:work", label: "work" },
      ],
      agents: [agent("claude")],
    };
    render(<AccountsPanel />);

    expect(screen.getByRole("button", { name: "Use personal" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use work" }));
    await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("claude", "claude:work"));
  });

  it("reports a failed action rather than leaving the row looking unchanged", async () => {
    const user = userEvent.setup();
    removeAccount.mockRejectedValue(new Error("account vault is a symlink"));
    daemonState.snapshot = {
      accounts: [{ active: true, agentId: "claude", id: "claude:personal", label: "personal" }],
      agents: [agent("claude")],
    };
    render(<AccountsPanel />);

    await user.click(screen.getByRole("button", { name: "Remove personal" }));
    expect(await screen.findByRole("status")).toHaveTextContent("symlink");
  });

  it("hides agents that have no account support and no quota to report", () => {
    daemonState.snapshot = { accounts: [], agents: [agent("opencode")] };
    const { container } = render(<AccountsPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  // ── Quota, merged in from what used to be a separate "Rate limits" section ──

  it("shows an account's quota on the account itself, not as a second list", () => {
    daemonState.snapshot = {
      accounts: [{ active: true, agentId: "claude", id: "claude:personal", label: "personal" }],
      agents: [agent("claude")],
    };
    daemonState.agentLimits = [limits({})];
    render(<AccountsPanel />);

    // One row, carrying the window inside it.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("lists a harness that reports quota but manages no logins", () => {
    daemonState.snapshot = { accounts: [], agents: [agent("opencode")] };
    daemonState.agentLimits = [
      limits({ accountId: "opencode:live", agentId: "opencode", label: "Signed in" }),
    ];
    render(<AccountsPanel />);

    expect(screen.getByText("Signed in")).toBeInTheDocument();
    // Nothing to import into: OpenCode has no account switching.
    expect(screen.queryByRole("button", { name: /Import current login/ })).not.toBeInTheDocument();
  });

  it("shows a harness's spend once, not once per account", () => {
    daemonState.snapshot = {
      accounts: [
        { active: true, agentId: "claude", id: "claude:personal", label: "personal" },
        { active: false, agentId: "claude", id: "claude:work", label: "work" },
      ],
      agents: [agent("claude")],
    };
    daemonState.agentLimits = [
      limits({}),
      limits({ accountId: "claude:work", label: "Work", active: false }),
    ];
    daemonState.agentSpend = [spend({})];
    render(<AccountsPanel />);

    expect(screen.getAllByText(/\$12\.34 today/)).toHaveLength(1);
  });

  it("says a harness does not report cost instead of showing $0.00", () => {
    daemonState.snapshot = {
      accounts: [{ active: true, agentId: "claude", id: "claude:personal", label: "personal" }],
      agents: [agent("claude")],
    };
    daemonState.agentSpend = [spend({ reported: false, todayUsd: null, totalUsd: null })];
    render(<AccountsPanel />);

    expect(screen.getByText("cost not reported")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("renders no spend line when a reporting harness has no numbers yet", () => {
    daemonState.snapshot = {
      accounts: [{ active: true, agentId: "claude", id: "claude:personal", label: "personal" }],
      agents: [agent("claude")],
    };
    daemonState.agentSpend = [spend({ todayUsd: null, totalUsd: null })];
    render(<AccountsPanel />);

    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
    expect(screen.queryByText("cost not reported")).not.toBeInTheDocument();
  });

  it("keeps the accounts when the daemon cannot report spend at all", () => {
    daemonState.snapshot = {
      accounts: [{ active: true, agentId: "claude", id: "claude:personal", label: "personal" }],
      agents: [agent("claude")],
    };
    daemonState.agentSpend = null;
    render(<AccountsPanel />);

    expect(screen.getByText("personal")).toBeInTheDocument();
    expect(screen.queryByText(/Estimated at API rates/)).not.toBeInTheDocument();
  });

  it("footnotes the numbers as API-rate estimates, once", () => {
    daemonState.snapshot = {
      accounts: [
        { active: true, agentId: "claude", id: "claude:personal", label: "personal" },
        { active: false, agentId: "claude", id: "claude:work", label: "work" },
      ],
      agents: [agent("claude")],
    };
    daemonState.agentSpend = [spend({})];
    render(<AccountsPanel />);

    expect(screen.getAllByText(/Estimated at API rates/)).toHaveLength(1);
  });
});
