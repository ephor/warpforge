const xtermInstances = vi.hoisted(() => [] as object[]);

vi.mock("@xterm/xterm", () => {
  const MockTerminal = function () {
    const element = document.createElement("div");
    const terminal = {
      element,
      loadAddon: vi.fn<(addon: unknown) => void>(),
      onData: vi
        .fn<(cb: (data: string) => void) => { dispose: () => void }>()
        .mockReturnValue({ dispose: vi.fn<() => void>() }),
      dispose: vi.fn<() => void>(),
      focus: vi.fn<() => void>(),
      open: vi.fn<(host: HTMLElement) => void>((host) => host.appendChild(element)),
      write: vi.fn<(data: Uint8Array | string) => void>(),
      cols: 80,
      rows: 24,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemon } from "../daemon";
import { disposeTerminalWorkspace, getTerminalWorkspace } from "../lib/terminalWorkspace";
import type { PortForwardInfo, ServiceInfo, TerminalInfo } from "../protocol";
import { TerminalWorkspaceView } from "./runtime/TerminalWorkspace";
import { RuntimePanel } from "./RuntimePanel";

interface MockXterm {
  element: HTMLElement;
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

let currentTerminals: TerminalInfo[] = [];
let terminalDataListeners = new Map<string, (data: Uint8Array) => void>();

function terminalInfo(id: string, project = "warpforge"): TerminalInfo {
  return {
    cols: 80,
    command: "sh",
    id,
    project,
    rows: 24,
    startedAt: 1,
  };
}

const webService: ServiceInfo = {
  allocatedPort: 4000,
  command: "bun run dev",
  logSeq: 0,
  name: "web",
  originalPort: 3000,
  project: "warpforge",
  status: "running",
};

const stoppedService: ServiceInfo = {
  allocatedPort: 0,
  command: "cargo run",
  logSeq: 1,
  name: "api",
  originalPort: 8080,
  project: "warpforge",
  status: "stopped",
};

const startingService: ServiceInfo = {
  allocatedPort: 0,
  command: "npm start",
  logSeq: 0,
  name: "worker",
  originalPort: 0,
  project: "warpforge",
  status: "starting",
};

const activePf: PortForwardInfo = {
  localPort: 5432,
  logSeq: 0,
  name: "db-tunnel",
  namespace: "default",
  pod: "postgres-0",
  project: "warpforge",
  remotePort: 5432,
  status: "active",
};

const stoppedPf: PortForwardInfo = {
  localPort: 6379,
  logSeq: 0,
  name: "redis-tunnel",
  namespace: "default",
  pod: "redis-0",
  project: "warpforge",
  remotePort: 6379,
  status: "stopped",
};

const startingPf: PortForwardInfo = {
  localPort: 8080,
  logSeq: 0,
  name: "api-tunnel",
  namespace: "default",
  pod: "api-0",
  project: "warpforge",
  remotePort: 8080,
  status: "starting",
};

function mockTerminalDaemonMethods() {
  vi.spyOn(daemon, "subscribeEvents").mockReturnValue(() => {});
  vi.spyOn(daemon, "subscribe").mockReturnValue(() => {});
  vi.spyOn(daemon, "subscribeTerminalData").mockImplementation((terminalId, listener) => {
    terminalDataListeners.set(terminalId, listener);
    return () => terminalDataListeners.delete(terminalId);
  });
  vi.spyOn(daemon, "clearTerminalBuffer").mockImplementation(() => {});
  vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("");
  vi.spyOn(daemon, "killTerminal").mockResolvedValue(undefined);
  vi.spyOn(daemon, "resizeTerminal").mockImplementation(() => {});
  vi.spyOn(daemon, "sendTerminalInput").mockImplementation(() => {});
  vi.spyOn(daemon, "getState").mockImplementation(() => ({
    connection: "connected",
    connectionError: null,
    pendingAgentSetup: null,
    serviceLogs: {},
    portforwardLogs: {},
    sessionUpdates: {},
    snapshot: {
      projects: [],
      services: [],
      portforwards: [],
      tasks: [],
      terminals: currentTerminals,
    },
  }));
}

beforeEach(() => {
  currentTerminals = [];
  terminalDataListeners = new Map();
  xtermInstances.length = 0;
  mockTerminalDaemonMethods();
});

afterEach(() => {
  disposeTerminalWorkspace("warpforge");
  vi.restoreAllMocks();
});

describe("RuntimePanel — structure", () => {
  it("shows empty state when no services or port-forwards", () => {
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[]} />);
    expect(screen.getByText(/No services or port-forwards configured/)).toBeInTheDocument();
  });

  // The shell moved out to a surface of its own, so this panel is services and
  // port-forwards only — no tab row inside it.
  it("has no tab row of its own", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText("Interactive terminal")).not.toBeInTheDocument();
  });
});

describe("TerminalWorkspaceView", () => {
  it("offers to start a shell when the project has none", () => {
    render(<TerminalWorkspaceView project="warpforge" />);

    expect(screen.getByText("Interactive terminal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start terminal/i })).toBeInTheDocument();
  });

  it("does not spin while waiting to be started", () => {
    const { container } = render(<TerminalWorkspaceView project="warpforge" />);

    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });
});

describe("TerminalWorkspaceView — remount ownership", () => {
  function RuntimeMount({
    mounted,
    project = "warpforge",
    taskId,
  }: {
    mounted: boolean;
    project?: string;
    taskId: string;
  }) {
    if (!mounted) return null;
    return <TerminalWorkspaceView key={taskId} project={project} />;
  }

  it("reattaches the same terminal after the surface is left and returned to", async () => {
    currentTerminals = [terminalInfo("term-1")];
    const { rerender } = render(<RuntimeMount mounted project="warpforge" taskId="task-a" />);
    const workspace = getTerminalWorkspace("warpforge");
    const controller = workspace.getController("term-1");
    expect(controller).not.toBeNull();
    const terminal = controller!.term as unknown as MockXterm;

    await waitFor(() => expect(terminal.element.isConnected).toBe(true));
    terminalDataListeners.get("term-1")?.(new TextEncoder().encode("before collapse"));
    expect(terminal.write).toHaveBeenCalledTimes(1);

    rerender(<RuntimeMount mounted={false} project="warpforge" taskId="task-a" />);
    expect(terminal.element.isConnected).toBe(false);

    rerender(<RuntimeMount mounted project="warpforge" taskId="task-a" />);
    await waitFor(() => expect(terminal.element.isConnected).toBe(true));

    expect(getTerminalWorkspace("warpforge").getController("term-1")).toBe(controller);
    expect(terminal.open).toHaveBeenCalledTimes(1);
    expect(xtermInstances).toHaveLength(1);
    expect(terminal.write).toHaveBeenCalledWith(new TextEncoder().encode("before collapse"));
  });

  it("retains terminal identity and output across same-project task navigation", async () => {
    currentTerminals = [terminalInfo("term-1")];
    const { rerender } = render(<RuntimeMount mounted project="warpforge" taskId="task-a" />);
    const controller = getTerminalWorkspace("warpforge").getController("term-1");
    expect(controller).not.toBeNull();
    const terminal = controller!.term as unknown as MockXterm;

    await waitFor(() => expect(terminal.element.isConnected).toBe(true));
    terminalDataListeners.get("term-1")?.(new TextEncoder().encode("task a output"));

    rerender(<RuntimeMount mounted project="warpforge" taskId="task-b" />);
    await waitFor(() => expect(terminal.element.isConnected).toBe(true));
    rerender(<RuntimeMount mounted project="warpforge" taskId="task-a" />);
    await waitFor(() => expect(terminal.element.isConnected).toBe(true));

    expect(getTerminalWorkspace("warpforge").getController("term-1")).toBe(controller);
    expect(terminal.open).toHaveBeenCalledTimes(1);
    expect(xtermInstances).toHaveLength(1);
    expect(terminal.write).toHaveBeenCalledWith(new TextEncoder().encode("task a output"));
  });
});

describe("RuntimePanel — service controls", () => {
  it("shows Start for stopped service, no Stop or Restart", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[stoppedService]} portforwards={[]} />);
    expect(screen.getByLabelText("Start api")).toBeInTheDocument();
    expect(screen.queryByLabelText("Stop api")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/restart api/i)).not.toBeInTheDocument();
  });

  it("shows Stop + Restart for running service, no Start", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    expect(screen.getByLabelText("Stop web")).toBeInTheDocument();
    expect(screen.getByLabelText(/restart web/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Start web")).not.toBeInTheDocument();
  });

  it("shows Stop only for starting service (no Start, no Restart)", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[startingService]} portforwards={[]} />);
    expect(screen.getByLabelText("Stop worker")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start worker")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/restart worker/i)).not.toBeInTheDocument();
  });

  it("calls service.start on Start click", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    render(<RuntimePanel project="warpforge" services={[stoppedService]} portforwards={[]} />);
    fireEvent.click(screen.getByLabelText("Start api"));
    expect(requestSpy).toHaveBeenCalledWith("service.start", {
      project: "warpforge",
      service: "api",
    });
  });

  it("calls service.stop on Stop click", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    fireEvent.click(screen.getByLabelText("Stop web"));
    expect(requestSpy).toHaveBeenCalledWith("service.stop", {
      project: "warpforge",
      service: "web",
    });
  });

  it("calls service.restart on Restart click", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    fireEvent.click(screen.getByLabelText(/restart web/i));
    expect(requestSpy).toHaveBeenCalledWith("service.restart", {
      project: "warpforge",
      service: "web",
    });
  });

  it("shows error banner when service action is rejected", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "request").mockRejectedValue(new Error("daemon disconnected"));
    render(<RuntimePanel project="warpforge" services={[stoppedService]} portforwards={[]} />);
    fireEvent.click(screen.getByLabelText("Start api"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("daemon disconnected");
    });
  });

  it("error banner clears when service status changes", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "request").mockRejectedValueOnce(new Error("oops"));
    const { rerender } = render(
      <RuntimePanel project="warpforge" services={[stoppedService]} portforwards={[]} />,
    );
    fireEvent.click(screen.getByLabelText("Start api"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    rerender(
      <RuntimePanel
        project="warpforge"
        services={[{ ...stoppedService, status: "starting" }]}
        portforwards={[]}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("error persists when services array gets new identity but same statuses", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "request").mockRejectedValue(new Error("persist me"));
    const { rerender } = render(
      <RuntimePanel project="warpforge" services={[stoppedService]} portforwards={[]} />,
    );
    fireEvent.click(screen.getByLabelText("Start api"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("persist me");
    });
    const sameServiceNewArray = { ...stoppedService };
    rerender(
      <RuntimePanel project="warpforge" services={[sameServiceNewArray]} portforwards={[]} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("persist me");
  });
});

describe("RuntimePanel — ARIA: no nested buttons", () => {
  it("selection button and lifecycle controls are siblings, not nested", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    const selectBtn = screen.getByLabelText(/select web/i);
    expect(selectBtn.tagName).toBe("BUTTON");
    const stopBtn = screen.getByLabelText("Stop web");
    expect(stopBtn.tagName).toBe("BUTTON");
    expect(selectBtn.contains(stopBtn)).toBe(false);
    expect(stopBtn.contains(selectBtn)).toBe(false);
  });

  it("clicking lifecycle control does not change selection", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "request").mockResolvedValue({});
    render(
      <RuntimePanel
        project="warpforge"
        services={[stoppedService, webService]}
        portforwards={[]}
      />,
    );
    expect(screen.getByLabelText(/select api/i)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByLabelText("Stop web"));
    expect(screen.getByLabelText(/select api/i)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(/select web/i)).toHaveAttribute("aria-pressed", "false");
  });
});

describe("RuntimePanel — port-forward controls", () => {
  it("shows Stop for active PF, no Start", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[activePf]} />);
    expect(screen.getByLabelText("Stop db-tunnel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start db-tunnel")).not.toBeInTheDocument();
  });

  it("shows Start for stopped PF, no Stop", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf]} />);
    expect(screen.getByLabelText("Start redis-tunnel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Stop redis-tunnel")).not.toBeInTheDocument();
  });

  it("shows spinner for starting PF, no Start or Stop button", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[startingPf]} />);
    expect(screen.getByLabelText("api-tunnel is starting")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start api-tunnel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Stop api-tunnel")).not.toBeInTheDocument();
  });

  it("calls portforward.start on Start click", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf]} />);
    fireEvent.click(screen.getByLabelText("Start redis-tunnel"));
    expect(requestSpy).toHaveBeenCalledWith("portforward.start", {
      project: "warpforge",
      name: "redis-tunnel",
    });
  });

  it("calls portforward.stop on Stop click", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[activePf]} />);
    fireEvent.click(screen.getByLabelText("Stop db-tunnel"));
    expect(requestSpy).toHaveBeenCalledWith("portforward.stop", {
      project: "warpforge",
      name: "db-tunnel",
    });
  });

  it("shows error when PF action is rejected", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "request").mockRejectedValue(new Error("kubectl not found"));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf]} />);
    fireEvent.click(screen.getByLabelText("Start redis-tunnel"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("kubectl not found");
    });
  });
});

describe("RuntimePanel — Start all port-forwards", () => {
  it("shows start-all button when at least one PF is startable", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf, activePf]} />);
    expect(screen.getByLabelText("Start all port-forwards")).toBeInTheDocument();
  });

  it("hides start-all button when all PFs are active", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[activePf]} />);
    expect(screen.queryByLabelText("Start all port-forwards")).not.toBeInTheDocument();
  });

  it("disables start-all button when a PF is starting", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    render(
      <RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf, startingPf]} />,
    );
    expect(screen.getByLabelText("Start all port-forwards")).toBeDisabled();
  });

  it("calls portforward.startAll with correct payload", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf, activePf]} />);
    fireEvent.click(screen.getByLabelText("Start all port-forwards"));
    expect(requestSpy).toHaveBeenCalledWith("portforward.startAll", {
      project: "warpforge",
    });
  });

  it("shows error when start-all is rejected", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "request").mockRejectedValue(new Error("cluster unreachable"));
    render(<RuntimePanel project="warpforge" services={[]} portforwards={[stoppedPf]} />);
    fireEvent.click(screen.getByLabelText("Start all port-forwards"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("cluster unreachable");
    });
  });
});

// Services used to have no bulk control at all while port-forwards did, which
// read as a missing feature rather than a distinction between the two lists.
describe("RuntimePanel — bulk controls are the same for both lists", () => {
  function renderWith(services: ServiceInfo[], portforwards: PortForwardInfo[]) {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(daemon, "fetchPortForwardLogs").mockReturnValue(new Promise(() => {}));
    return render(
      <RuntimePanel project="warpforge" services={services} portforwards={portforwards} />,
    );
  }

  it("offers start-all for services with something stopped", () => {
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    renderWith([webService, stoppedService], []);

    fireEvent.click(screen.getByLabelText("Start all services"));

    expect(requestSpy).toHaveBeenCalledWith("service.startAll", { project: "warpforge" });
  });

  it("offers stop-all for services with something up", () => {
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    renderWith([webService], []);

    // Everything is running, so starting is not on offer — stopping is.
    expect(screen.queryByLabelText("Start all services")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Stop all services"));

    expect(requestSpy).toHaveBeenCalledWith("service.stopAll", { project: "warpforge" });
  });

  it("waits for a starting service instead of firing start-all again", () => {
    renderWith([stoppedService, startingService], []);

    expect(screen.getByLabelText("Start all services")).toBeDisabled();
  });

  it("offers stop-all for port-forwards that are up", () => {
    const requestSpy = vi.spyOn(daemon, "request").mockResolvedValue({});
    renderWith([], [activePf]);

    fireEvent.click(screen.getByLabelText("Stop all port-forwards"));

    expect(requestSpy).toHaveBeenCalledWith("portforward.stopAll", { project: "warpforge" });
  });

  it("reports a failed bulk action in the panel's error line", async () => {
    vi.spyOn(daemon, "request").mockRejectedValue(new Error("port 4000 is taken"));
    renderWith([stoppedService], []);

    fireEvent.click(screen.getByLabelText("Start all services"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("port 4000 is taken");
    });
  });
});

describe("RuntimePanel — log viewer isolation", () => {
  it("fetches logs only once per target (not per logSeq change)", () => {
    const fetchSpy = vi.spyOn(daemon, "fetchServiceLogs").mockResolvedValue(["line1"]);
    const { rerender } = render(
      <RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    rerender(
      <RuntimePanel
        project="warpforge"
        services={[{ ...webService, logSeq: 5 }]}
        portforwards={[]}
      />,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("switching target does not show old fetched logs", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockImplementation((_project, service) => {
      if (service === "web") return Promise.resolve(["web-log-line"]);
      return Promise.resolve(["api-log-line"]);
    });
    const { rerender } = render(
      <RuntimePanel
        project="warpforge"
        services={[webService, stoppedService]}
        portforwards={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("web-log-line")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/select api/i));
    rerender(
      <RuntimePanel
        project="warpforge"
        services={[webService, { ...stoppedService, status: "running" }]}
        portforwards={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("api-log-line")).toBeInTheDocument();
    });
    expect(screen.queryByText("web-log-line")).not.toBeInTheDocument();
  });
});

describe("RuntimePanel — service port link", () => {
  it("running service with allocatedPort renders clickable link", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    const link = screen.getByLabelText(/open http:\/\/localhost:4000/i);
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "http://localhost:4000");
    expect(link).toHaveTextContent(":4000");
  });

  it("port link opens via openExternalLink on click", async () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const openSpy = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(await import("@/lib/externalLinks"), "openExternalLink").mockImplementation(openSpy);
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    fireEvent.click(screen.getByLabelText(/open http:\/\/localhost:4000/i));
    expect(openSpy).toHaveBeenCalledWith("http://localhost:4000");
  });

  it("service with zero allocatedPort has no port link", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const zeroPortService: ServiceInfo = { ...stoppedService, allocatedPort: 0 };
    render(<RuntimePanel project="warpforge" services={[zeroPortService]} portforwards={[]} />);
    expect(screen.queryByLabelText(/open http:\/\/localhost/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/:0/)).not.toBeInTheDocument();
  });

  it("stopped service with allocatedPort shows port as non-actionable text", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const stoppedWithPort: ServiceInfo = { ...stoppedService, allocatedPort: 8080 };
    render(<RuntimePanel project="warpforge" services={[stoppedWithPort]} portforwards={[]} />);
    expect(screen.queryByLabelText(/open http:\/\/localhost/i)).not.toBeInTheDocument();
    expect(screen.getByText(/:8080/)).toBeInTheDocument();
    expect(screen.getByText(/:8080/).tagName).not.toBe("A");
  });
});

describe("RuntimePanel — pinned service ports", () => {
  it("marks a pinned port and explains that it fails rather than move", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    const pinned: ServiceInfo = { ...webService, portPinned: true };
    render(<RuntimePanel project="warpforge" services={[pinned]} portforwards={[]} />);

    const pin = screen.getByLabelText("web port is pinned");
    expect(pin).toBeInTheDocument();
    expect(pin.closest("span")).toHaveAttribute(
      "title",
      "This port is fixed by the project's config. If it is already taken, the service fails instead of moving.",
    );
  });

  it("does not mark an allocated (non-pinned) port", () => {
    vi.spyOn(daemon, "fetchServiceLogs").mockReturnValue(new Promise(() => {}));
    render(<RuntimePanel project="warpforge" services={[webService]} portforwards={[]} />);
    expect(screen.queryByLabelText(/port is pinned/)).not.toBeInTheDocument();
  });
});
