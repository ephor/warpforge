import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentConfig, WorkflowMeta } from "../protocol";
import { RunPreview } from "./RunPreview";

const agents: AgentConfig[] = [
  { acpCommand: "claude", displayName: "Claude Code", enabled: true, id: "claude", models: [] },
  { acpCommand: "codex", displayName: "Codex", enabled: true, id: "codex", models: [] },
];

const workflow: WorkflowMeta = {
  id: "default",
  maxRounds: 3,
  name: "Review loop",
  source: "builtin",
  stages: ["plan", "implement", "review×2", "fix"],
  valid: true,
};

describe("RunPreview", () => {
  it("draws the workflow's real stages, reviewer count and round limit", () => {
    render(<RunPreview agent="claude" agents={agents} mode="workflow" workflow={workflow} />);

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Fix")).toBeInTheDocument();
    expect(screen.getByText("2 reviewers in parallel")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
  });

  it("omits a stage the template does not run", () => {
    render(
      <RunPreview
        agent="claude"
        agents={agents}
        mode="workflow"
        workflow={{ ...workflow, stages: ["implement", "review", "fix"] }}
      />,
    );

    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    expect(screen.getByText("checks the diff")).toBeInTheDocument();
  });

  it("labels the orchestrator fan as an example so it is not read as a plan", () => {
    const { container } = render(
      <RunPreview agent="claude" agents={agents} mode="orchestrator" workflow={null} />,
    );

    expect(screen.getByText("Claude Code leads")).toBeInTheDocument();
    expect(screen.getByText("Review pipeline")).toBeInTheDocument();
    expect(screen.getByText(/example split/i)).toBeInTheDocument();

    // Workers are staffed from the user's own harnesses, so the fan must not be
    // four copies of the lead's icon.
    const logos = new Set([...container.querySelectorAll("img")].map((img) => img.src));
    expect(logos.size).toBeGreaterThan(1);
  });

  it("shows the picked harness in the single-agent run", () => {
    render(<RunPreview agent="codex" agents={agents} mode="single" workflow={null} />);

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Changes to review")).toBeInTheDocument();
  });
});
