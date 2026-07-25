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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimePanel } from "../components/RuntimePanel";
import { daemon } from "../daemon";
import { disposeTerminalWorkspace, getTerminalWorkspace } from "../lib/terminalWorkspace";
import type { ProjectInfo, Snapshot, TerminalInfo } from "../protocol";
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

function renderProjects(projectSnapshot = currentSnapshot) {
  return render(
    <Projects
      snapshot={projectSnapshot}
      onOpenTask={vi.fn<(id: string) => void>()}
      onNewTask={vi.fn<(project?: string) => void>()}
      onProjectAdded={vi.fn<(project: string) => void>()}
    />,
  );
}

async function openRemoveDialog(project: string) {
  const user = userEvent.setup();
  const selectProject = screen.getByRole("button", { name: `Select project ${project}` });
  fireEvent.mouseEnter(selectProject.parentElement!);
  await user.click(screen.getByRole("button", { name: "Project menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));
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

  it("opens Terminal for a project with live terminals and zero tasks", () => {
    currentSnapshot = {
      ...snapshot,
      tasks: [],
      terminals: [terminalInfo("term-1", "warpforge")],
    };
    renderProjects();

    expect(screen.getAllByLabelText("1 active terminal")).toHaveLength(2);
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

    expect(screen.getAllByLabelText("2 active terminals")).toHaveLength(2);
    expect(screen.getByLabelText("1 active terminal")).toBeInTheDocument();
    expect(screen.getByLabelText("1 running service")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle alpha Runtime" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("alpha-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select project beta" }));
    expect(screen.getByRole("button", { name: "Toggle beta Runtime" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByTestId("alpha-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle beta Runtime" }));
    expect(useUi.getState().runtimeOpenByProject).toEqual({ alpha: true, beta: true });
    expect(screen.getByTestId("beta-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select project alpha" }));
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

  it("confirms live resource teardown before removing a project", async () => {
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
          allocatedPort: 4000,
          command: "bun run dev",
          logSeq: 0,
          name: "web",
          originalPort: 3000,
          project: "alpha",
          status: "running",
        },
        {
          allocatedPort: 4001,
          command: "bun run worker",
          logSeq: 0,
          name: "worker",
          originalPort: 3001,
          project: "alpha",
          status: "starting",
        },
      ],
      portforwards: [
        {
          localPort: 5432,
          logSeq: 0,
          name: "db",
          namespace: "dev",
          pod: "postgres",
          project: "alpha",
          remotePort: 5432,
          status: "active",
        },
      ],
      terminals: [terminalInfo("alpha-terminal", "alpha")],
    };
    useUi.setState({ runtimeOpenByProject: { alpha: true, beta: true } });
    const workspace = getTerminalWorkspace("alpha");
    renderProjects();

    await openRemoveDialog("alpha");

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "This removes the project registration from Warpforge.",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "It does not delete the project folder or files.",
    );
    expect(screen.getByText("2 running or starting services")).toBeInTheDocument();
    expect(screen.getByText("1 active or starting port-forward")).toBeInTheDocument();
    expect(screen.getByText("1 live terminal")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop resources & remove" }));

    await waitFor(() => expect(daemon.removeProject).toHaveBeenCalledWith("alpha", true));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Remove alpha?" })).not.toBeInTheDocument(),
    );
    expect(useUi.getState().runtimeOpenByProject).toEqual({ beta: true });
    expect(getTerminalWorkspace("alpha")).not.toBe(workspace);
    expect(screen.getByRole("heading", { name: "beta" })).toBeInTheDocument();
  });

  it("keeps project terminal and UI state when removal fails, then allows cancel", async () => {
    currentSnapshot = {
      ...snapshot,
      terminals: [terminalInfo("term-1", "warpforge")],
    };
    useUi.setState({ runtimeOpenByProject: { warpforge: true } });
    const workspace = getTerminalWorkspace("warpforge");
    vi.mocked(daemon.removeProject).mockRejectedValueOnce(
      new Error("conflict: project still has live resources"),
    );
    renderProjects();

    await openRemoveDialog("warpforge");
    fireEvent.click(screen.getByRole("button", { name: "Stop resources & remove" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Removal failed: conflict: project still has live resources",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The project remains registered, though some resources may already have stopped.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Its terminal workspace and Runtime visibility were kept.",
    );
    expect(useUi.getState().runtimeOpenByProject).toEqual({ warpforge: true });
    expect(getTerminalWorkspace("warpforge")).toBe(workspace);
    expect(screen.getByRole("button", { name: "Stop resources & remove" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the compact removal action when no resources are live", async () => {
    renderProjects();

    await openRemoveDialog("warpforge");

    expect(screen.getByRole("button", { name: "Remove project" })).toBeInTheDocument();
    expect(screen.queryByText("Live resources to stop")).not.toBeInTheDocument();
  });
});
