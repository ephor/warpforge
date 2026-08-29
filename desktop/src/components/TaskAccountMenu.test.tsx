import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
import type { DaemonState } from "@/daemon";
import type { AccountInfo, AgentAccountLimits, AgentConfig } from "@/protocol";

import { TaskAccountMenu } from "./TaskAccountMenu";

const NOW = Math.floor(Date.now() / 1000);
const SWITCH_NOTE = "Open sessions resume on the new account with your next message.";

const agent = (id: string): AgentConfig => ({
  acpCommand: `${id}-acp`,
  displayName: id === "claude" ? "Claude Code" : "Codex",
  enabled: true,
  id,
  models: [],
});

const account = (
  agentId: string,
  slug: string,
  overrides: Partial<AccountInfo> = {},
): AccountInfo => ({
  active: false,
  agentId,
  id: `${agentId}:${slug}`,
  label: slug,
  ...overrides,
});

const limits = (
  agentId: string,
  slug: string,
  usedPercent: number,
  overrides: Partial<AgentAccountLimits> = {},
): AgentAccountLimits => ({
  accountId: `${agentId}:${slug}`,
  agentId,
  label: slug,
  active: false,
  windows: [{ id: "five_hour", label: "Session", usedPercent }],
  exhausted: usedPercent >= 100,
  fetchedAt: NOW,
  source: "api",
  ...overrides,
});

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

function mockDaemon(agentLimits: AgentAccountLimits[] | null) {
  vi.spyOn(daemon, "subscribe").mockReturnValue(() => {});
  vi.spyOn(daemon, "getState").mockImplementation(() => ({
    ...baseState,
    agentLimits,
    agentSpend: null,
  }));
  vi.spyOn(daemon, "listAgentLimits").mockResolvedValue(agentLimits ?? []);
  vi.spyOn(daemon, "listAgentSpend").mockResolvedValue([]);
  return vi.spyOn(daemon, "setActiveAccount").mockResolvedValue([]);
}

function renderMenu(agentId: string, accounts: AccountInfo[]) {
  return render(
    <TaskAccountMenu
      agentId={agentId}
      agents={[agent("claude"), agent("codex")]}
      accounts={accounts}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskAccountMenu trigger", () => {
  it("names the active account and its quota in one control", async () => {
    mockDaemon([limits("claude", "personal", 33)]);
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
    ]);

    const trigger = await screen.findByRole("button", { name: "Claude Code account" });
    expect(trigger).toHaveTextContent("Personal");
    // The numbers are bare percentages now that two of them stack in the row;
    // the "left" sense they carry is spelled out in the tooltip.
    expect(trigger).toHaveTextContent("67%");
    expect(trigger).toHaveAttribute("title", "Claude Code: Personal · Session: 67% left");
  });

  it("stacks session over weekly, so neither window hides behind the other", async () => {
    mockDaemon([
      limits("claude", "personal", 27, {
        windows: [
          { id: "five_hour", label: "Session", usedPercent: 27 },
          { id: "seven_day", label: "Weekly", usedPercent: 33 },
        ],
      }),
    ]);
    renderMenu("claude", [account("claude", "personal", { active: true, label: "Personal" })]);

    const trigger = await screen.findByRole("button", { name: "Claude Code account" });
    const text = trigger.textContent ?? "";
    expect(text).toContain("73%");
    expect(text).toContain("67%");
    // Session first: it is the window that turns over in hours.
    expect(text.indexOf("73%")).toBeLessThan(text.indexOf("67%"));
  });

  it("omits a window the harness never reported rather than inventing a line", async () => {
    mockDaemon([
      limits("claude", "personal", 40, {
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 40 }],
      }),
    ]);
    renderMenu("claude", [account("claude", "personal", { active: true, label: "Personal" })]);

    const trigger = await screen.findByRole("button", { name: "Claude Code account" });
    expect(trigger).toHaveTextContent("60%");
    expect(trigger).toHaveAttribute("title", "Claude Code: Personal · Weekly: 60% left");
  });

  it("shows the active account's quota, not a busier idle account's", async () => {
    mockDaemon([limits("claude", "personal", 5), limits("claude", "work", 92)]);
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
    ]);

    const trigger = await screen.findByRole("button", { name: "Claude Code account" });
    expect(trigger).toHaveTextContent("95%");
    expect(trigger).not.toHaveTextContent("8%");
  });

  it("says exhausted rather than 0% left on a spent window", async () => {
    mockDaemon([limits("claude", "personal", 100)]);
    renderMenu("claude", [account("claude", "personal", { active: true, label: "Personal" })]);

    expect(await screen.findByRole("button", { name: "Claude Code account" })).toHaveTextContent(
      "exhausted",
    );
  });

  it("still identifies the task's harness when no quota was reported", async () => {
    mockDaemon(null);
    renderMenu("claude", [account("claude", "personal", { active: true, label: "Personal" })]);

    const trigger = await screen.findByRole("button", { name: "Claude Code account" });
    expect(trigger).toHaveTextContent("Personal");
    // The trigger is also the harness identity, so it stays — minus the numbers.
    expect(trigger).not.toHaveTextContent("%");
  });
});

describe("TaskAccountMenu menu", () => {
  it("puts the task's harness first and keeps the others below it", async () => {
    const user = userEvent.setup();
    mockDaemon([limits("claude", "personal", 20), limits("codex", "personal", 40)]);
    renderMenu("codex", [
      account("claude", "personal", { active: true, label: "Claude login" }),
      account("codex", "personal", { active: true, label: "Codex login" }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Codex account" }));
    const menu = await screen.findByRole("menu");
    const text = menu.textContent ?? "";
    // A Claude task can spawn Codex sub-agents and vice versa, so the other
    // harness stays visible — it is only ranked below this task's.
    expect(text).toContain("Claude Code");
    expect(text.indexOf("Codex")).toBeLessThan(text.indexOf("Claude Code"));
  });

  it("switches on the explicit action, never on the card itself", async () => {
    const user = userEvent.setup();
    const setActiveAccount = mockDaemon([
      limits("claude", "personal", 20),
      limits("claude", "work", 60),
    ]);
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Claude Code account" }));
    await user.click(await screen.findByRole("button", { name: "Use Work" }));

    await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("claude", "claude:work"));
  });

  it("offers no switch on the account already in use", async () => {
    const user = userEvent.setup();
    mockDaemon([limits("claude", "personal", 20), limits("claude", "work", 60)]);
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Claude Code account" }));
    // The ACTIVE badge in the card header is the only active marker now; the
    // foot row that used to repeat it as "✓ Active" is gone.
    expect(await screen.findByText("active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Personal" })).toBeNull();
    // The switchable account still offers its action.
    expect(screen.getByRole("button", { name: "Use Work" })).toBeInTheDocument();
  });

  it("lists an account the daemon never polled, and lets you switch to it", async () => {
    const user = userEvent.setup();
    // Only "personal" has numbers: "work" was registered but never polled, and
    // driving the list off the limits snapshot alone would drop it.
    const setActiveAccount = mockDaemon([limits("claude", "personal", 20)]);
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Claude Code account" }));
    expect(await screen.findByText("No usage reported for this account yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use Work" }));
    await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("claude", "claude:work"));
  });

  it("says once what a switch does to open sessions", async () => {
    const user = userEvent.setup();
    mockDaemon([limits("claude", "personal", 20), limits("codex", "personal", 40)]);
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
      account("codex", "personal", { active: true, label: "Codex login" }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Claude Code account" }));
    expect(await screen.findAllByText(SWITCH_NOTE)).toHaveLength(1);
  });

  it("surfaces a failed switch instead of silently keeping the old account", async () => {
    const user = userEvent.setup();
    mockDaemon([limits("claude", "personal", 20)]).mockRejectedValue(
      new Error("no stored credentials for 'work'"),
    );
    renderMenu("claude", [
      account("claude", "personal", { active: true, label: "Personal" }),
      account("claude", "work", { label: "Work" }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Claude Code account" }));
    await user.click(await screen.findByRole("button", { name: "Use Work" }));

    expect(await screen.findByRole("status")).toHaveTextContent("no stored credentials");
  });
});
