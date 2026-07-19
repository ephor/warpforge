import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../protocol";
import Projects from "./Projects";

const snapshot: Snapshot = {
  portforwards: [],
  projects: [
    {
      agentTemplates: {},
      declaredServices: [],
      name: "warpforge",
      path: "/workspace/warpforge",
      portRange: [4000, 4099],
    },
  ],
  services: [],
  tasks: [],
  terminals: [],
};

describe("Projects", () => {
  it("renders project context in the shared workspace surface", () => {
    render(
      <Projects
        snapshot={snapshot}
        onOpenTask={vi.fn<(id: string) => void>()}
        onNewTask={vi.fn<(project?: string) => void>()}
        onProjectAdded={vi.fn<(project: string) => void>()}
      />,
    );

    expect(screen.getByRole("heading", { name: "warpforge" })).toBeInTheDocument();
    expect(screen.getByText("Agent context")).toBeInTheDocument();
    expect(screen.getByText("No services declared in .warpforge.yaml.")).toBeInTheDocument();
  });
});
