import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentLogo } from "./AgentLogo";

describe("AgentLogo", () => {
  it.each(["claude", "codex", "opencode", "qwen"])(
    "uses a packaged asset URL for the %s logo",
    (agentId) => {
      const { container } = render(<AgentLogo agentId={agentId} displayName={agentId} />);

      const image = container.querySelector("img");
      expect(image).not.toBeNull();
      expect(image?.getAttribute("src")).not.toMatch(/^data:/);
    },
  );

  it("falls back to initials when a logo cannot be loaded", () => {
    const { container, getByText } = render(
      <AgentLogo agentId="claude" displayName="Claude Code" />,
    );

    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    expect(container.querySelector("img")).toBeNull();
    expect(getByText("CC")).toBeInTheDocument();
  });
});
