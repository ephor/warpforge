import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MessageActions } from "./MessageActions";

describe("MessageActions", () => {
  it("copies the exact message text", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MessageActions
        agents={[]}
        text="Copy this exactly"
        onContinue={vi.fn<(agent: string) => Promise<void>>().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Copy this exactly"));
  });

  it("lists every enabled harness supplied by the transcript", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn<(agent: string) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <MessageActions
        agents={[
          {
            acpCommand: "codex-acp",
            displayName: "Codex",
            enabled: true,
            id: "codex",
            models: [],
            lastModel: undefined,
          },
          {
            acpCommand: "claude-acp",
            displayName: "Claude",
            enabled: true,
            id: "claude",
            models: [],
            lastModel: undefined,
          },
        ]}
        text="Branch here"
        onContinue={onContinue}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue with another agent" }));

    expect(await screen.findByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    await user.click(screen.getByText("Codex"));
    expect(onContinue).toHaveBeenCalledWith("codex");
  });
});
