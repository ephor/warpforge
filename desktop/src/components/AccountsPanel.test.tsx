import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountInfo, AgentConfig } from "@/protocol";

const { daemonState, importAccount, removeAccount, setActiveAccount } = vi.hoisted(() => ({
  daemonState: {
    snapshot: { accounts: [] as AccountInfo[], agents: [] as AgentConfig[] },
  },
  importAccount: vi.fn<(agentId: string, label: string) => Promise<AccountInfo[]>>(),
  removeAccount: vi.fn<(accountId: string) => Promise<AccountInfo[]>>(),
  setActiveAccount: vi.fn<(agentId: string, accountId: string) => Promise<AccountInfo[]>>(),
}));

vi.mock("@/daemon", () => ({
  daemon: {
    importAccount,
    removeAccount,
    setActiveAccount,
    // Must be a stable reference or useSyncExternalStore re-renders forever.
    subscribe: () => () => {},
    getState: () => daemonState,
  },
}));

import AccountsPanel from "./AccountsPanel";

const agent = (id: string, enabled = true): AgentConfig => ({
  acpCommand: `${id}-acp`,
  displayName: id === "claude" ? "Claude Code" : "Codex",
  enabled,
  id,
  models: [],
});

describe("AccountsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importAccount.mockResolvedValue([]);
    removeAccount.mockResolvedValue([]);
    setActiveAccount.mockResolvedValue([]);
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

  it("hides agents that have no account support", () => {
    daemonState.snapshot = { accounts: [], agents: [agent("opencode")] };
    const { container } = render(<AccountsPanel />);
    expect(container).toBeEmptyDOMElement();
  });
});
