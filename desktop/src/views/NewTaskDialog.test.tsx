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

const snapshot: Snapshot = {
  agents: [agent],
  portforwards: [],
  projects: [project],
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
    openTaskId: null,
    textGenAgentId: null,
    textGenModel: null,
  });

  vi.spyOn(daemon, "request").mockImplementation(async (method) => {
    if (method === "file.list") return [{ changed: false, path: "src/app.ts" }];
    if (method === "task.create") return { taskId: "created-task" };
    return {};
  });
  vi.spyOn(daemon, "listSessions").mockResolvedValue([]);
  vi.spyOn(daemon, "workflowList").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  useUi.setState({ openTaskId: null });
});

describe("NewTaskDialog", () => {
  it("puts prompt before execution settings while keeping model controls available", () => {
    renderDialog();

    const prompt = screen.getByRole("heading", { name: "What are you trying to ship?" });
    const execution = screen.getByRole("heading", { name: "Where and how should it run?" });
    expect(
      prompt.compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model: Default" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning effort: Default" })).toBeInTheDocument();
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

  it("opens resumed session task after daemon returns its id", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    vi.mocked(daemon.listSessions).mockResolvedValueOnce([
      {
        agent: "claude",
        messageCount: 4,
        sessionId: "session-1",
        title: "Continue API review",
        updatedAt: 1,
      },
    ]);
    vi.spyOn(daemon, "resumeTask").mockResolvedValue("resumed-task");
    renderDialog(onOpenChange);

    await user.click(await screen.findByRole("button", { name: /Continue API review/ }));

    await waitFor(() =>
      expect(daemon.resumeTask).toHaveBeenCalledWith(
        "warpforge",
        "claude",
        "session-1",
        "Continue API review",
      ),
    );
    expect(useUi.getState().openTaskId).toBe("resumed-task");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
