import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowMeta } from "../protocol";
import type { TaskMode } from "./TaskComposeBar";
import { TaskComposeBar } from "./TaskComposeBar";

const onWorkflowChange = vi.fn<(v: string | null) => void>();
const onEjectWorkflow = vi.fn<(id: string) => void>();
const onModeChange = vi.fn<(v: TaskMode) => void>();

const workflows: WorkflowMeta[] = [
  {
    description: "Implement, then loop reviews and fixes.",
    id: "review-loop",
    maxRounds: 2,
    name: "Review loop",
    source: "builtin",
    stages: ["implement", "review×2", "fix"],
    valid: true,
  },
  {
    error: "`name` is required",
    id: "broken",
    name: "broken",
    source: "project",
    valid: false,
  },
];

function renderBar(props: Partial<Parameters<typeof TaskComposeBar>[0]> = {}) {
  return render(
    <TaskComposeBar
      agents={[
        {
          acpCommand: "claude",
          displayName: "Claude",
          enabled: true,
          id: "claude",
          models: [],
        },
      ]}
      agent="claude"
      branch="main"
      mode="workflow"
      onAgentChange={vi.fn<(v: string) => void>()}
      onEjectWorkflow={onEjectWorkflow}
      onModeChange={onModeChange}
      onProjectChange={vi.fn<(v: string) => void>()}
      onShareContextChange={vi.fn<(v: boolean) => void>()}
      onUseWorktreeChange={vi.fn<(v: boolean) => void>()}
      onWorkflowChange={onWorkflowChange}
      project="warpforge"
      projects={[
        {
          agentTemplates: {},
          declaredServices: [],
          name: "warpforge",
          path: "/tmp/warpforge",
          portRange: [4000, 4099],
        },
      ]}
      services={[]}
      shareContext
      useWorktree={false}
      workflow={null}
      workflows={workflows}
      {...props}
    />,
  );
}

describe("TaskComposeBar — workflow picker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("selects a workflow from the menu", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Pick a pipeline" }));
    await user.click(screen.getByRole("menuitem", { name: /implement → review×2 → fix/ }));
    expect(onWorkflowChange).toHaveBeenCalledWith("review-loop");
  });

  it("lists an invalid workflow with its error but does not select it", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Pick a pipeline" }));
    const broken = screen.getByRole("menuitem", { name: /`name` is required/ });
    expect(broken).toHaveAttribute("aria-disabled", "true");
    await user.click(broken);
    expect(onWorkflowChange).not.toHaveBeenCalled();
  });

  it("copies a built-in into the project without selecting it", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Pick a pipeline" }));
    await user.click(screen.getByRole("button", { name: /save review loop into this project/i }));
    expect(onEjectWorkflow).toHaveBeenCalledWith("review-loop");
    expect(onWorkflowChange).not.toHaveBeenCalled();
  });

  it("hides the picker outside workflow mode", () => {
    renderBar({ mode: "single" });
    expect(screen.queryByRole("button", { name: "Pick a pipeline" })).not.toBeInTheDocument();
  });
});

describe("TaskComposeBar — execution mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers the three modes as one exclusive choice", () => {
    renderBar({ mode: "orchestrator" });
    const group = screen.getByRole("radiogroup", { name: "Execution mode" });
    const modes = within(group).getAllByRole("radio");
    expect(modes.map((m) => m.textContent)).toEqual(["Single", "Orchestrator", "Workflow"]);
    // Exclusivity is structural now — picking one cannot leave another checked.
    expect(modes.filter((m) => m.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Orchestrator" })).toBeChecked();
  });

  it("reports the picked mode", async () => {
    const user = userEvent.setup();
    renderBar({ mode: "single" });
    await user.click(screen.getByRole("radio", { name: "Orchestrator" }));
    expect(onModeChange).toHaveBeenCalledWith("orchestrator");
  });

  it("disables workflow mode when the project defines no valid pipeline", () => {
    renderBar({ mode: "single", workflows: [] });
    expect(screen.getByRole("radio", { name: "Workflow" })).toBeDisabled();
  });

  it("locks the worktree toggle for an orchestrator, which shares the checkout", () => {
    renderBar({ mode: "orchestrator", useWorktree: true });
    const worktree = screen.getByRole("button", { name: /worktree/i });
    expect(worktree).toBeDisabled();
    expect(worktree).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the current branch", () => {
    renderBar({ branch: "feature/oauth" });
    expect(screen.getByText("feature/oauth")).toBeInTheDocument();
  });
});
