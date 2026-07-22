import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DetectedAgent } from "@/protocol";

const { daemonState, detectAgents, installAgent, saveAgents } = vi.hoisted(() => ({
  daemonState: { snapshot: { agents: [] as unknown[] } },
  detectAgents: vi.fn<() => Promise<DetectedAgent[]>>(),
  installAgent: vi.fn<
    (id: string) => Promise<{ ok: boolean; command: string; output: string }>
  >(),
  saveAgents: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/daemon", () => ({
  daemon: {
    detectAgents,
    installAgent,
    saveAgents,
    // The panel seeds its rows from the configured-agent snapshot. getState must
    // return a stable reference or useSyncExternalStore re-renders forever.
    subscribe: () => () => {},
    getState: () => daemonState,
  },
}));

import AgentSetupPanel from "./AgentSetupPanel";

const agent = (
  id: string,
  overrides: Partial<DetectedAgent> = {},
): DetectedAgent => ({
  canManage: true,
  defaultAcpCommand: `acp-${id}`,
  displayName: id.charAt(0).toUpperCase() + id.slice(1),
  id,
  installHint: "",
  installed: false,
  status: "missing",
  ...overrides,
});

describe("AgentSetupPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-detects agents when no detected prop is provided", async () => {
    detectAgents.mockResolvedValue([agent("claude", { installed: true, version: "1.0.0" })]);
    render(<AgentSetupPanel />);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("renders pre-loaded agents without calling detectAgents", async () => {
    render(<AgentSetupPanel detected={[agent("codex")]} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(detectAgents).not.toHaveBeenCalled();
  });

  it("shows error when detectAgents rejects", async () => {
    detectAgents.mockRejectedValue(new Error("connection refused"));
    render(<AgentSetupPanel />);
    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
  });

  it("renders agent list with correct badges", async () => {
    const detected = [
      agent("claude", { installed: true, version: "1.0.0" }),
      agent("codex", { installed: false }),
      agent("copilot", {
        installed: true,
        status: "behind",
        version: "0.5.0",
        latestVersion: "0.6.0",
      }),
    ];
    render(<AgentSetupPanel detected={detected} />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
    expect(screen.getByText("Copilot")).toBeInTheDocument();
    expect(screen.getByText("update available")).toBeInTheDocument();
    expect(screen.getByText("v0.5.0 → v0.6.0")).toBeInTheDocument();
  });
});
