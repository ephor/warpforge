import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountInfo, AgentConfig } from "@/protocol";
import { useUi } from "@/store/ui";

const { setActiveAccount } = vi.hoisted(() => ({
  setActiveAccount: vi.fn<(agentId: string, accountId: string) => Promise<AccountInfo[]>>(),
}));

vi.mock("@/daemon", () => ({
  daemon: { setActiveAccount },
}));

import AccountSwitcher from "./AccountSwitcher";

const agent = (id: string, enabled = true): AgentConfig => ({
  acpCommand: `${id}-acp`,
  displayName: id === "claude" ? "Claude Code" : "Codex",
  enabled,
  id,
  models: [],
});

const account = (
  id: string,
  agentId: string,
  overrides: Partial<AccountInfo> = {},
): AccountInfo => ({
  active: false,
  agentId,
  id: `${agentId}:${id}`,
  label: id,
  ...overrides,
});

describe("AccountSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveAccount.mockResolvedValue([]);
    useUi.getState().setTheoMod(false);
  });

  it("shows nothing when there is nothing to switch between", () => {
    const { container } = render(
      <AccountSwitcher
        agents={[agent("claude")]}
        accounts={[account("personal", "claude", { active: true })]}
      />,
    );
    // One account is not a choice — a chip would only add noise.
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores accounts of disabled agents", () => {
    const { container } = render(
      <AccountSwitcher
        agents={[agent("codex", false)]}
        accounts={[account("personal", "codex", { active: true }), account("work", "codex")]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("labels the chip with the active account and switches on select", async () => {
    const user = userEvent.setup();
    render(
      <AccountSwitcher
        agents={[agent("claude")]}
        accounts={[
          account("personal", "claude", { active: true, email: "me@example.com", plan: "max" }),
          account("work", "claude"),
        ]}
      />,
    );

    const chip = screen.getByRole("button", { name: "Claude Code account" });
    expect(chip).toHaveTextContent("personal");

    await user.click(chip);
    await user.click(await screen.findByRole("menuitem", { name: /work/ }));

    await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("claude", "claude:work"));
  });

  it("says what happens to open sessions, which is not guessable", async () => {
    const user = userEvent.setup();
    render(
      <AccountSwitcher
        agents={[agent("codex")]}
        accounts={[account("personal", "codex", { active: true }), account("work", "codex")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Codex account" }));
    expect(
      await screen.findByText("Open sessions resume on the new account with your next message."),
    ).toBeInTheDocument();
  });

  it("surfaces a failed switch instead of silently keeping the old account", async () => {
    const user = userEvent.setup();
    setActiveAccount.mockRejectedValue(new Error("no stored credentials for 'work'"));
    render(
      <AccountSwitcher
        agents={[agent("claude")]}
        accounts={[account("personal", "claude", { active: true }), account("work", "claude")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Claude Code account" }));
    await user.click(await screen.findByRole("menuitem", { name: /work/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("no stored credentials");
  });

  it("blurs the account email in the menu when TheoMod is on", async () => {
    useUi.getState().setTheoMod(true);
    const user = userEvent.setup();
    const { container } = render(
      <AccountSwitcher
        agents={[agent("claude")]}
        accounts={[
          account("personal", "claude", { active: true, email: "me@example.com" }),
          account("work", "claude"),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Claude Code account" }));
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveTextContent("me@example.com");
    expect(container.querySelector(".blur-\\[3px\\]")).not.toBeNull();
  });

  it("shows emails unblurred by default", () => {
    const { container } = render(
      <AccountSwitcher
        agents={[agent("claude")]}
        accounts={[
          account("personal", "claude", { active: true, email: "me@example.com" }),
          account("work", "claude"),
        ]}
      />,
    );
    expect(container.querySelector(".blur-\\[3px\\]")).toBeNull();
  });
});
