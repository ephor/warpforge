const xtermInstances = vi.hoisted(() => [] as object[]);

vi.mock("@xterm/xterm", () => {
  const MockTerminal = function () {
    const element = document.createElement("div");
    const terminal = {
      cols: 80,
      dispose: vi.fn<() => void>(),
      element,
      focus: vi.fn<() => void>(),
      loadAddon: vi.fn<(addon: unknown) => void>(),
      onData: vi
        .fn<(cb: (data: string) => void) => { dispose: () => void }>()
        .mockReturnValue({ dispose: vi.fn<() => void>() }),
      open: vi.fn<(host: HTMLElement) => void>((host) => host.appendChild(element)),
      rows: 24,
      write: vi.fn<(data: Uint8Array | string) => void>(),
    };
    xtermInstances.push(terminal);
    return terminal;
  };
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  const MockFitAddon = function () {
    return { fit: vi.fn<() => void>() };
  };
  return { FitAddon: MockFitAddon };
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimePanel } from "../components/RuntimePanel";
import { daemon } from "../daemon";
import { disposeTerminalWorkspace, getTerminalWorkspace } from "../lib/terminalWorkspace";
import type { ProjectInfo, Snapshot, TaskInfo, TerminalInfo } from "../protocol";
import { useUi } from "../store/ui";
import Projects from "./Projects";

interface MockXterm {
  element: HTMLElement;
  open: ReturnType<typeof vi.fn>;
}

const warpforgeProject: ProjectInfo = {
  agentTemplates: {},
  declaredServices: [],
  name: "warpforge",
  path: "/workspace/warpforge",
  portRange: [4000, 4099],
};

const snapshot: Snapshot = {
  portforwards: [],
  projects: [warpforgeProject],
  services: [],
  tasks: [],
  terminals: [],
};

let currentSnapshot: Snapshot;

function terminalInfo(id: string, project: string): TerminalInfo {
  return {
    cols: 80,
    command: "sh",
    id,
    project,
    rows: 24,
    startedAt: 1,
  };
}

function renderProjects(
  projectSnapshot = currentSnapshot,
  onNewTask = vi.fn<(project?: string, prompt?: string) => void>(),
) {
  return render(
    <Projects
      snapshot={projectSnapshot}
      onOpenTask={vi.fn<(id: string) => void>()}
      onNewTask={onNewTask}
      onAddProject={vi.fn<() => void>()}
    />,
  );
}

function taskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    agent: "codex",
    blockedReason: null,
    createdAt: 100,
    filesChanged: 0,
    id: "task-1",
    project: "warpforge",
    prompt: "Task prompt",
    status: "running",
    tags: [],
    title: "Task",
    updatedAt: 110,
    ...overrides,
  };
}

beforeEach(() => {
  currentSnapshot = snapshot;
  xtermInstances.length = 0;
  localStorage.clear();
  useUi.setState({ runtimeOpenByProject: {} });

  vi.spyOn(daemon, "subscribeEvents").mockReturnValue(() => {});
  vi.spyOn(daemon, "subscribe").mockReturnValue(() => {});
  vi.spyOn(daemon, "subscribeTerminalData").mockReturnValue(() => {});
  vi.spyOn(daemon, "clearTerminalBuffer").mockImplementation(() => {});
  vi.spyOn(daemon, "resizeTerminal").mockImplementation(() => {});
  vi.spyOn(daemon, "sendTerminalInput").mockImplementation(() => {});
  vi.spyOn(daemon, "removeProject").mockResolvedValue();
  vi.spyOn(daemon, "getState").mockImplementation(() => ({
    connection: "connected",
    connectionError: null,
    pendingAgentSetup: null,
    portforwardLogs: {},
    serviceLogs: {},
    sessionUpdates: {},
    snapshot: currentSnapshot,
  }));
});

afterEach(() => {
  disposeTerminalWorkspace("warpforge");
  disposeTerminalWorkspace("alpha");
  disposeTerminalWorkspace("beta");
  vi.restoreAllMocks();
});

describe("Projects", () => {
  it("renders project context in the shared workspace surface", () => {
    renderProjects();

    expect(screen.getByRole("heading", { name: "warpforge" })).toBeInTheDocument();
    expect(screen.getByText("Agent context")).toBeInTheDocument();
    expect(screen.getByText("No services declared in .warpforge.yaml.")).toBeInTheDocument();
  });

  // Hooks run before the `if (!project)` guard, so an empty registry used to
  // dereference `project.declaredServices` and blank the view.
  it("renders the empty state when the registry has no projects", () => {
    currentSnapshot = { ...snapshot, projects: [] };

    expect(() => renderProjects()).not.toThrow();

    expect(screen.getByText(/No projects registered\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "warpforge" })).not.toBeInTheDocument();
  });

  it("groups real tasks by activity and keeps parent-child hierarchy", () => {
    const parent = taskInfo({
      id: "parent",
      title: "Parent task",
      status: "running",
      updatedAt: 130,
      worktree: "/workspace/warpforge/.worktrees/parent",
    });
    const child = taskInfo({
      id: "child",
      parentTaskId: "parent",
      title: "Child task",
      status: "waiting",
      filesChanged: 2,
      updatedAt: 140,
    });
    const recent = taskInfo({
      id: "recent",
      title: "Finished task",
      status: "done",
      updatedAt: 150,
    });
    currentSnapshot = { ...snapshot, tasks: [recent, child, parent] };

    renderProjects();

    expect(screen.getByText("Active work")).toBeInTheDocument();
    expect(screen.getByText("Parent task")).toBeInTheDocument();
    expect(screen.queryByText("Finished task")).not.toBeInTheDocument();
    expect(screen.queryByText("Child task")).not.toBeInTheDocument();
    expect(screen.queryByText("feature/oauth-callback")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show 1 done task/ }));

    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Finished task")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Expand agents" })[0]);

    expect(screen.getByText("Child task")).toBeInTheDocument();
    // Changed-file count moved into the compact right-hand cluster ("2f", with
    // the spelled-out count in its title) when rows became single-line.
    expect(screen.getByTitle("2 changed files")).toBeInTheDocument();
    expect(screen.queryByText("worktree unavailable")).not.toBeInTheDocument();
  });

  it("starts new task in selected project", () => {
    const onNewTask = vi.fn<(project?: string, prompt?: string) => void>();
    const otherProject: ProjectInfo = {
      ...warpforgeProject,
      name: "other",
      path: "/workspace/other",
    };
    currentSnapshot = { ...snapshot, projects: [warpforgeProject, otherProject] };

    renderProjects(currentSnapshot, onNewTask);
    fireEvent.click(screen.getByRole("button", { name: "New task in warpforge" }));

    expect(onNewTask).toHaveBeenCalledWith("warpforge");
  });

  it("exposes full runtime names on hover", () => {
    const serviceName = "payments-api-with-a-very-long-runtime-name";
    const portForwardName = "production-postgres-primary-port-forward";
    currentSnapshot = {
      ...snapshot,
      projects: [{ ...warpforgeProject, declaredServices: [serviceName] }],
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

    renderProjects();

    expect(screen.getByTitle(serviceName)).toBeInTheDocument();
    expect(screen.getByTitle(portForwardName)).toBeInTheDocument();
  });

  it("keeps declared service controls available before runtime status arrives", () => {
    currentSnapshot = {
      ...snapshot,
      projects: [{ ...warpforgeProject, declaredServices: ["api"] }],
    };
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    renderProjects();

    expect(screen.queryByLabelText("Start api")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle warpforge Runtime" }));

    expect(screen.getByLabelText("Start api")).toBeInTheDocument();
  });

  it("opens Terminal for a project with live terminals and zero tasks", () => {
    currentSnapshot = {
      ...snapshot,
      tasks: [],
      terminals: [terminalInfo("term-1", "warpforge")],
    };
    renderProjects();

    expect(screen.getByLabelText("1 active terminal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle warpforge Runtime" }));

    expect(useUi.getState().runtimeOpenByProject.warpforge).toBe(true);
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("term-1")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet.")).toBeInTheDocument();
  });

  it("isolates terminal counts and persisted Runtime visibility by project", async () => {
    const alpha: ProjectInfo = {
      ...warpforgeProject,
      name: "alpha",
      path: "/workspace/alpha",
    };
    const beta: ProjectInfo = {
      ...warpforgeProject,
      name: "beta",
      path: "/workspace/beta",
      portRange: [4100, 4199],
    };
    currentSnapshot = {
      ...snapshot,
      projects: [alpha, beta],
      services: [
        {
          allocatedPort: 4100,
          command: "bun run dev",
          logSeq: 0,
          name: "web",
          originalPort: 3000,
          project: "beta",
          status: "running",
        },
      ],
      terminals: [
        terminalInfo("alpha-1", "alpha"),
        terminalInfo("alpha-2", "alpha"),
        terminalInfo("beta-1", "beta"),
      ],
    };
    useUi.setState({ runtimeOpenByProject: { alpha: true, beta: false } });
    renderProjects();

    expect(screen.getByLabelText("2 active terminals")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle alpha Runtime" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("alpha-1")).toBeInTheDocument();

    act(() => useUi.setState({ selectedProjectId: "beta" }));
    expect(screen.getByRole("button", { name: "Toggle beta Runtime" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByTestId("alpha-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle beta Runtime" }));
    expect(useUi.getState().runtimeOpenByProject).toEqual({ alpha: true, beta: true });
    expect(screen.getByTestId("beta-1")).toBeInTheDocument();

    act(() => useUi.setState({ selectedProjectId: "alpha" }));
    await waitFor(() => expect(screen.getByTestId("alpha-1")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Toggle alpha Runtime" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reattaches the same project terminal when moving from a task Runtime to Projects", async () => {
    currentSnapshot = {
      ...snapshot,
      terminals: [terminalInfo("term-1", "warpforge")],
    };
    useUi.setState({ runtimeOpenByProject: { warpforge: true } });

    const taskSurface = render(
      <RuntimePanel project="warpforge" services={[]} portforwards={[]} initialTab="terminal" />,
    );
    const controller = getTerminalWorkspace("warpforge").getController("term-1");
    expect(controller).not.toBeNull();
    const xterm = controller!.term as unknown as MockXterm;
    await waitFor(() => expect(xterm.element.isConnected).toBe(true));

    taskSurface.unmount();
    expect(xterm.element.isConnected).toBe(false);
    renderProjects();
    await waitFor(() => expect(xterm.element.isConnected).toBe(true));

    expect(getTerminalWorkspace("warpforge").getController("term-1")).toBe(controller);
    expect(xterm.open).toHaveBeenCalledTimes(1);
    expect(xtermInstances).toHaveLength(1);
  });
});
