import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowMeta } from "../protocol";
import { TaskComposeBar } from "./TaskComposeBar";

const onWorkflowChange = vi.fn<(v: string | null) => void>();
const onEjectWorkflow = vi.fn<(id: string) => void>();
const onOrchChatChange = vi.fn<(v: boolean) => void>();

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
      onAgentChange={vi.fn<(v: string) => void>()}
      onEjectWorkflow={onEjectWorkflow}
      onOrchChatChange={onOrchChatChange}
      onProjectChange={vi.fn<(v: string) => void>()}
      onShareContextChange={vi.fn<(v: boolean) => void>()}
      onUseWorktreeChange={vi.fn<(v: boolean) => void>()}
      onWorkflowChange={onWorkflowChange}
      orchChat={false}
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

  it("hides the picker when a project has no workflows", () => {
    renderBar({ workflows: [] });
    expect(screen.queryByRole("button", { name: /workflow/i })).not.toBeInTheDocument();
  });

  it("selects a workflow from the menu", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: /workflow/i }));
    await user.click(screen.getByRole("menuitem", { name: /Review loop/ }));
    expect(onWorkflowChange).toHaveBeenCalledWith("review-loop");
  });

  it("lists an invalid workflow with its error but does not select it", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: /workflow/i }));
    const broken = screen.getByRole("menuitem", { name: /`name` is required/ });
    expect(broken).toHaveAttribute("aria-disabled", "true");
    await user.click(broken);
    expect(onWorkflowChange).not.toHaveBeenCalled();
  });

  it("copies a built-in into the project without selecting it", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: /workflow/i }));
    await user.click(screen.getByRole("menuitem", { name: /copy to project/i }));
    expect(onEjectWorkflow).toHaveBeenCalledWith("review-loop");
    expect(onWorkflowChange).not.toHaveBeenCalled();
  });

  it("summarizes the selected workflow and relabels the agent as the lead", () => {
    renderBar({ workflow: "review-loop" });
    expect(screen.getByText(/implement → review×2 → fix/)).toBeInTheDocument();
    expect(screen.getByText(/up to 2 review rounds/)).toBeInTheDocument();
    expect(screen.getByText("Lead agent")).toBeInTheDocument();
  });

  it("locks the orchestrator toggle while a workflow is selected", () => {
    renderBar({ workflow: "review-loop" });
    expect(screen.getByRole("button", { name: /orchestrator/i })).toBeDisabled();
  });

  it("locks the workflow picker while the orchestrator is on", () => {
    renderBar({ orchChat: true });
    expect(screen.getByRole("button", { name: /workflow/i })).toBeDisabled();
  });
});
