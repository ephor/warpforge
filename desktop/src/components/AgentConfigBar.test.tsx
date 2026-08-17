import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigOption } from "@/protocol";

const { request, toastError } = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  toastError: vi.fn<(message: string, options?: { description?: string }) => void>(),
}));
vi.mock("@/daemon", () => ({ daemon: { request } }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { AgentConfigBar } from "./AgentConfigBar";

const option = (
  id: string,
  name: string,
  category: string,
  currentValue: string,
): ConfigOption => ({
  category,
  currentValue,
  id,
  name,
  options: [{ name: currentValue, value: currentValue }],
});

describe("AgentConfigBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps model and reasoning effort visible regardless of source order", () => {
    render(
      <AgentConfigBar
        taskId="task-1"
        options={[
          option("mode", "Mode", "mode", "Build"),
          option("access", "Access", "permission", "Full access"),
          option("thought_level", "Reasoning effort", "thought_level", "High"),
          option("model", "Model", "model", "Claude Opus 4.5"),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Model: Claude Opus 4.5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning effort: High" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More agent settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Mode:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Access:/ })).not.toBeInTheDocument();
  });

  it("only offers a filter box once the list is long enough to need one", async () => {
    const many = (id: string, name: string, count: number): ConfigOption => ({
      category: id,
      currentValue: "v0",
      id,
      name,
      options: Array.from({ length: count }, (_, i) => ({ name: `Choice ${i}`, value: `v${i}` })),
    });

    render(
      <AgentConfigBar
        taskId="task-1"
        options={[many("model", "Model", 20), many("thought_level", "Reasoning effort", 3)]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^Reasoning effort:/ }));
    expect(screen.queryByPlaceholderText(/^Search/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const search = screen.getByPlaceholderText("Search model…");
    await userEvent.type(search, "Choice 12");
    expect(screen.getByText("Choice 12")).toBeInTheDocument();
    expect(screen.queryByText("Choice 3")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Default/)).not.toBeInTheDocument();
  });

  it("shows the pick right away, then undoes it when the agent refuses", async () => {
    const opt: ConfigOption = {
      category: "model",
      currentValue: "opus",
      id: "model",
      name: "Model",
      options: [
        { name: "Opus", value: "opus" },
        { name: "Sonnet", value: "sonnet" },
      ],
    };
    let reject: (e: Error) => void = () => {};
    request.mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
    );
    render(<AgentConfigBar taskId="task-1" options={[opt]} />);

    await userEvent.click(screen.getByRole("button", { name: "Model: Opus" }));
    await userEvent.click(screen.getByText("Sonnet"));
    // Optimistic: the trigger reads Sonnet before the agent has confirmed.
    expect(screen.getByRole("button", { name: "Model: Sonnet" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("session.setConfigOption", {
      config_id: "model",
      task_id: "task-1",
      value: "sonnet",
    });

    reject(new Error("agent rejected 'model'"));
    expect(await screen.findByRole("button", { name: "Model: Opus" })).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(
      "Could not switch model to Sonnet",
      expect.objectContaining({ description: "agent rejected 'model'" }),
    );
  });
});
