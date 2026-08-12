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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  // The backlog reads its tracker links through TanStack Query; a fresh client
  // per render keeps tests from sharing cached daemon reads.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Projects
        snapshot={projectSnapshot}
        onOpenTask={vi.fn<(id: string) => void>()}
        onNewTask={onNewTask}
        onAddProject={vi.fn<() => void>()}
      />
    </QueryClientProvider>,
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
  vi.spyOn(daemon, "listBacklog").mockImplementation(async (input) => ({
    items: input.pageSize === 1 ? [] : [],
    page: 0,
    pageSize: input.pageSize,
    total: 0,
    hasNextPage: false,
  }));
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

  it("shows local backlog items and hides daemon task trees", async () => {
    vi.mocked(daemon.listBacklog).mockImplementation(async (input) => ({
      items:
        input.pageSize === 1
          ? []
          : [
              {
                id: "item-1",
                number: 1,
                project: "warpforge",
                title: "Local backlog item",
                body: "",
                status: "todo",
                priority: "none",
                source: "local",
                createdAt: 100,
                updatedAt: 110,
              },
            ],
      page: 0,
      pageSize: input.pageSize,
      total: input.pageSize === 1 ? 0 : 1,
      hasNextPage: false,
    }));
    const daemonTask = taskInfo({
      id: "task-1",
      title: "Daemon task",
      status: "running",
      updatedAt: 130,
    });
    currentSnapshot = { ...snapshot, tasks: [daemonTask] };

    renderProjects();

    await waitFor(() => expect(screen.getByText("Local backlog item")).toBeInTheDocument());
    expect(screen.queryByText("Daemon task")).not.toBeInTheDocument();
  });

  it("opens the new work item drawer for the selected project", () => {
    const otherProject: ProjectInfo = {
      ...warpforgeProject,
      name: "other",
      path: "/workspace/other",
    };
    currentSnapshot = { ...snapshot, projects: [warpforgeProject, otherProject] };

    renderProjects(currentSnapshot);
    fireEvent.click(screen.getByRole("button", { name: "New work item in warpforge" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("New work item")).toBeInTheDocument();
    expect(screen.getByText(/Create a task in warpforge/)).toBeInTheDocument();
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

  it("opens Terminal for a project with live terminals and zero tasks", async () => {
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
    // The backlog waits for its tracker pull before it can say it is empty.
    expect(await screen.findByText("Nothing here yet.")).toBeInTheDocument();
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
