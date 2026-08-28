import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "@/daemon";
import type { SessionUpdate, TaskInfo } from "@/protocol";

import { ContinueSessionDialog } from "./ContinueSessionDialog";

const task = {
  agent: "claude",
  blockedKind: "session_lost",
  blockedReason: "rejected ACP session/load",
  createdAt: 1,
  filesChanged: 0,
  id: "t_source",
  project: "lingoverse",
  prompt: "Integrate the speech provider",
  status: "blocked",
  tags: [],
  title: "",
  updatedAt: 1,
} satisfies TaskInfo;

const updates: SessionUpdate[] = [
  { attachments: [], kind: "user_message", text: "wire up the provider" },
  { kind: "agent_text", text: "started on the adapter" },
];

function renderDialog(targetAgent = "claude") {
  return render(
    <ContinueSessionDialog
      open
      onOpenChange={() => {}}
      task={task}
      updates={updates}
      throughIndex={updates.length - 1}
      targetAgent={targetAgent}
      onOpenTask={() => {}}
    />,
  );
}

describe("ContinueSessionDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(daemon, "getState").mockReturnValue({
      ...daemon.getState(),
      snapshot: {
        ...daemon.getState().snapshot,
        accounts: [
          { active: true, agentId: "claude", id: "claude:work", label: "Work" },
          { active: false, agentId: "claude", id: "claude:personal", label: "Personal" },
        ],
        agents: [
          {
            acpCommand: "claude-acp",
            displayName: "Claude",
            enabled: true,
            id: "claude",
            models: [],
          },
          { acpCommand: "codex-acp", displayName: "Codex", enabled: true, id: "codex", models: [] },
        ],
      },
    });
  });

  it("carries a short conversation verbatim without calling a model", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(daemon, "request").mockResolvedValue({ taskId: "t_new" });
    const generateText = vi.spyOn(daemon, "generateText");
    renderDialog();

    // A two-message transcript is far under the summarising threshold.
    expect(screen.getByRole("radio", { name: /Full transcript/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(generateText).not.toHaveBeenCalled();
  });

  it("summarises the cut transcript and seeds the same task", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(daemon, "request").mockResolvedValue({});
    const generateText = vi.spyOn(daemon, "generateText").mockResolvedValue("## Goal\nShip it");
    renderDialog();

    await user.click(screen.getByRole("radio", { name: /Handoff summary/ }));

    // Two accounts on this harness, so the escape hatch for a spent quota is on
    // offer rather than buried in settings.
    expect(screen.getByLabelText("Account that writes the handoff")).toBeInTheDocument();
    // The picker must not read as "who takes over" — that is a separate choice.
    expect(screen.getByText(/still continues the work/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(generateText).toHaveBeenCalled());
    const [taskId, agentId, kind, , options] = generateText.mock.calls[0];
    expect(taskId).toBe("t_source");
    expect(agentId).toBe("claude");
    expect(kind).toBe("handoff");
    // The cut transcript travels with the request — the daemon does not re-read
    // the store, so the fork point is whatever the client sent.
    expect(options?.input).toContain("wire up the provider");

    // Default destination is the task itself when the harness is unchanged.
    const [method, params] = request.mock.calls[0] as [string, { task_id: string; text: string }];
    expect(method).toBe("session.prompt");
    expect(params.task_id).toBe("t_source");
    expect(params.text).toContain("## Goal\nShip it");
  });

  it("forces a new task when a different harness takes over", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(daemon, "request").mockResolvedValue({ taskId: "t_new" });
    renderDialog("codex");

    // A task keeps one agent, so continuing in place is not on offer at all.
    expect(screen.queryByRole("radio", { name: /Continue in this task/ })).toBeNull();
    expect(screen.getByText(/Opens a new task seeded with the context/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(request).toHaveBeenCalled());
    const [method, params] = request.mock.calls[0] as [string, { agent: string }];
    expect(method).toBe("task.create");
    expect(params.agent).toBe("codex");
  });

  it("does not offer to seed a session that is still alive", () => {
    render(
      <ContinueSessionDialog
        open
        onOpenChange={() => {}}
        task={{ ...task, blockedKind: null, blockedReason: null, status: "waiting" }}
        updates={updates}
        throughIndex={updates.length - 1}
        targetAgent="claude"
        onOpenTask={() => {}}
      />,
    );

    // Same harness, but the session still holds this conversation — feeding it
    // a summary of itself would be pure loss.
    expect(screen.queryByRole("radio", { name: /Continue in this task/ })).toBeNull();
  });
});
