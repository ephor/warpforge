import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import type { AgentConfig, ConfigOption, Snapshot } from "../protocol";
import { useUi } from "../store/ui";
import NewTaskDialog from "./NewTaskDialog";

const project = {
  agentTemplates: {},
  declaredServices: [],
  name: "warpforge",
  path: "/workspace/warpforge",
  portRange: [4000, 4099] as [number, number],
};

const otherProject = {
  ...project,
  name: "lingoverse",
  path: "/workspace/lingoverse",
  portRange: [4100, 4199] as [number, number],
};

const modelOption: ConfigOption = {
  category: "model",
  currentValue: "default-model",
  id: "model",
  name: "Model",
  options: [
    { name: "Default model", value: "default-model" },
    { name: "Sonnet", value: "sonnet" },
  ],
};

const effortOption: ConfigOption = {
  category: "thought_level",
  currentValue: "default-effort",
  id: "reasoning_effort",
  name: "Reasoning effort",
  options: [
    { name: "Default effort", value: "default-effort" },
    { name: "High", value: "high" },
  ],
};

const agent: AgentConfig = {
  acpCommand: "claude",
  displayName: "Claude",
  enabled: true,
  id: "claude",
  models: [modelOption, effortOption],
};

const codex: AgentConfig = {
  acpCommand: "codex",
  displayName: "Codex",
  enabled: true,
  id: "codex",
  models: [],
};

const snapshot: Snapshot = {
  agents: [agent, codex],
  portforwards: [],
  projects: [project, otherProject],
  services: [],
  tasks: [],
  terminals: [],
};

function renderDialog(onOpenChange = vi.fn<(open: boolean) => void>()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onOpenChange,
    ...render(
      <QueryClientProvider client={queryClient}>
        <NewTaskDialog
          defaultProject="warpforge"
          onOpenChange={onOpenChange}
          open
          snapshot={snapshot}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  localStorage.clear();
  useUi.setState({
    autoNameTasks: false,
    newTaskWorktree: false,
    openTaskId: null,
    textGenAgentId: null,
    textGenModel: null,
  });

  vi.spyOn(daemon, "request").mockImplementation(async (method) => {
    if (method === "file.list") return [{ changed: false, path: "src/app.ts" }];
    if (method === "task.create") return { taskId: "created-task" };
    return {};
  });
  vi.spyOn(daemon, "workflowList").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  useUi.setState({ openTaskId: null });
});

describe("NewTaskDialog", () => {
  it("puts run context above the prompt while keeping model controls in the composer", () => {
    renderDialog();

    const modes = screen.getByRole("radiogroup", { name: "Execution mode" });
    const prompt = screen.getByPlaceholderText("What should the agent do?");
    expect(modes.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model: Default" })).toBeInTheDocument();
  });

  it("shows inherited model when agent has a remembered lastModel", () => {
    const withLastModel: Snapshot = {
      ...snapshot,
      agents: [{ ...agent, lastModel: "sonnet" }, codex],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <NewTaskDialog defaultProject="warpforge" onOpenChange={vi.fn<(open: boolean) => void>()} open snapshot={withLastModel} />
      </QueryClientProvider>,
    );
    expect(container.textContent).toContain("Sonnet (inherited)");
    expect(screen.getByRole("button", { name: "Reasoning effort: Default" })).toBeInTheDocument();
  });

  it("keeps the new-task surface focused when the mode changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("radio", { name: "Orchestrator" }));
    expect(
      screen.getByPlaceholderText("What should the orchestrator coordinate?"),
    ).toBeInTheDocument();
    expect(screen.queryByText("How this run works")).not.toBeInTheDocument();
  });

  it("tags an orchestrator task and keeps it out of a worktree", async () => {
    const user = userEvent.setup();
    useUi.setState({ newTaskWorktree: true });
    renderDialog();

    await user.click(screen.getByRole("radio", { name: "Orchestrator" }));
    await user.type(screen.getByPlaceholderText("What should the orchestrator coordinate?"), "Go");
    await user.click(screen.getByRole("button", { name: "Start orchestrator" }));

    await waitFor(() =>
      expect(daemon.request).toHaveBeenCalledWith(
        "task.create",
        expect.objectContaining({ tags: ["orchestrator-chat"], worktree: false }),
      ),
    );
  });

  it("preserves create payload and opens returned task", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const prompt = screen.getByPlaceholderText("What should the agent do?");

    await user.type(prompt, "Review @src/app.ts");
    await screen.findByText("src/app.ts");
    await user.type(screen.getByLabelText("Tags"), "bug, frontend");

    await user.click(screen.getByRole("button", { name: "Model: Default" }));
    await user.click(screen.getByRole("button", { name: "Sonnet" }));
    await user.click(screen.getByRole("button", { name: "Reasoning effort: Default" }));
    await user.click(screen.getByRole("button", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(daemon.request).toHaveBeenCalledWith("task.create", {
        agent: "claude",
        attachments: [{ path: "src/app.ts", type: "file" }],
        config_overrides: { reasoning_effort: "high" },
        default_model: "sonnet",
        include_runtime_context: true,
        project: "warpforge",
        prompt: "Review @src/app.ts",
        tags: ["bug", "frontend"],
        workflow: undefined,
        worktree: false,
      }),
    );
    expect(useUi.getState().openTaskId).toBe("created-task");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the prompt and harness when the project changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(screen.getByRole("menuitem", { name: "Codex" }));
    await user.type(screen.getByPlaceholderText("What should the agent do?"), "Ship it");

    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(screen.getByRole("menuitem", { name: "lingoverse" }));

    // Realising the project was wrong must not cost the rest of the setup.
    expect(screen.getByRole("button", { name: "Harness" })).toHaveTextContent("Codex");
    expect(screen.getByPlaceholderText("What should the agent do?")).toHaveValue("Ship it");

    await user.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() =>
      expect(daemon.request).toHaveBeenCalledWith(
        "task.create",
        expect.objectContaining({ agent: "codex", project: "lingoverse", prompt: "Ship it" }),
      ),
    );
  });

  it("keeps the harness's model picks when the project changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Model: Default" }));
    await user.click(screen.getByRole("button", { name: "Sonnet" }));

    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(screen.getByRole("menuitem", { name: "lingoverse" }));

    expect(screen.getByRole("button", { name: "Model: Sonnet" })).toBeInTheDocument();
  });

  it("drops the harness's own config picks when the harness changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Model: Default" }));
    await user.click(screen.getByRole("button", { name: "Sonnet" }));
    expect(screen.getByRole("button", { name: "Model: Sonnet" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(screen.getByRole("menuitem", { name: "Codex" }));

    expect(screen.queryByRole("button", { name: "Model: Sonnet" })).not.toBeInTheDocument();
  });

  it("remembers the worktree toggle across dialog opens", async () => {
    const user = userEvent.setup();
    const first = renderDialog();
    expect(useUi.getState().newTaskWorktree).toBe(false);

    await user.click(screen.getByRole("button", { name: "Worktree" }));
    expect(useUi.getState().newTaskWorktree).toBe(true);
    first.unmount();

    // Reopening must not reset the choice back to the default.
    renderDialog();
    expect(screen.getByRole("button", { name: "Worktree" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.type(screen.getByPlaceholderText("What should the agent do?"), "Ship it");
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(daemon.request).toHaveBeenCalledWith(
        "task.create",
        expect.objectContaining({ worktree: true }),
      ),
    );
  });
});
