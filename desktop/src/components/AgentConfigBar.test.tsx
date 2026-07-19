import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConfigOption } from "@/protocol";

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
});
