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

  it("exposes full runtime names on hover", () => {
    const serviceName = "payments-api-with-a-very-long-runtime-name";
    const portForwardName = "production-postgres-primary-port-forward";
    const runtimeSnapshot: Snapshot = {
      ...snapshot,
      projects: [{ ...snapshot.projects[0], declaredServices: [serviceName] }],
      services: [
        {
          allocatedPort: 4000,
          command: "bun run dev",
          logSeq: 0,
          name: serviceName,
          originalPort: 3000,
          project: "warpforge",
          status: "running",
        },
      ],
      portforwards: [
        {
          localPort: 5432,
          logSeq: 0,
          name: portForwardName,
          namespace: "production",
          pod: "postgres-primary",
          project: "warpforge",
          remotePort: 5432,
          status: "active",
        },
      ],
    };

    render(
      <Projects
        snapshot={runtimeSnapshot}
        onOpenTask={vi.fn<(id: string) => void>()}
        onNewTask={vi.fn<(project?: string) => void>()}
      />,
    );

    expect(screen.getByTitle(serviceName)).toBeInTheDocument();
    expect(screen.getByTitle(portForwardName)).toBeInTheDocument();
  });
});
