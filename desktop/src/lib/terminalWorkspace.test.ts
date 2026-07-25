vi.mock("@xterm/xterm", () => {
  const MockTerminal = function () {
    const element = document.createElement("div");
    return {
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
  };
  return { Terminal: MockTerminal };
});
vi.mock("@xterm/addon-fit", () => {
  const MockFitAddon = function () {
    return { fit: vi.fn<() => void>() };
  };
  return { FitAddon: MockFitAddon };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemon, type ConnectionState } from "../daemon";
import { disposeTerminalWorkspace, getTerminalWorkspace } from "../lib/terminalWorkspace";
import type { DaemonEvent, TerminalInfo } from "../protocol";

type EventHandler = (ev: DaemonEvent) => void;

let eventHandlers: EventHandler[] = [];
let storeHandlers: Array<() => void> = [];
let currentTerminals: TerminalInfo[] = [];
let connectionState: ConnectionState = "connected";

function emitDaemonEvent(event: string, data: unknown) {
  const ev = { event, data } as unknown as DaemonEvent;
  for (const handler of eventHandlers) handler(ev);
}

function triggerStoreUpdate() {
  for (const handler of storeHandlers) handler();
}

beforeEach(() => {
  eventHandlers = [];
  storeHandlers = [];
  currentTerminals = [];
  connectionState = "connected";

  vi.spyOn(daemon, "request").mockResolvedValue({ terminalId: "term-1" });
  vi.spyOn(daemon, "subscribeEvents").mockImplementation((fn: (ev: DaemonEvent) => void) => {
    eventHandlers.push(fn);
    return () => {
      eventHandlers = eventHandlers.filter((h) => h !== fn);
    };
  });
  vi.spyOn(daemon, "subscribe").mockImplementation((fn: () => void) => {
    storeHandlers.push(fn);
    return () => {
      storeHandlers = storeHandlers.filter((h) => h !== fn);
    };
  });
  vi.spyOn(daemon, "subscribeTerminalData").mockReturnValue(() => {});
  vi.spyOn(daemon, "clearTerminalBuffer").mockImplementation(() => {});
  vi.spyOn(daemon, "killTerminal").mockResolvedValue(undefined);
  vi.spyOn(daemon, "resizeTerminal").mockImplementation(() => {});
  vi.spyOn(daemon, "sendTerminalInput").mockImplementation(() => {});
  vi.spyOn(daemon, "getState").mockImplementation(() => ({
    connection: connectionState,
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
});

afterEach(() => {
  disposeTerminalWorkspace("test-project");
  vi.restoreAllMocks();
});

describe("TerminalWorkspace — lifecycle", () => {
  it("starts empty with no active terminal", () => {
    const ws = getTerminalWorkspace("test-project");
    expect(ws.getTerminals()).toEqual([]);
    expect(ws.getActiveId()).toBeNull();
  });

  it("getTerminalWorkspace returns same instance for same project", () => {
    const a = getTerminalWorkspace("same-project");
    const b = getTerminalWorkspace("same-project");
    expect(a).toBe(b);
    disposeTerminalWorkspace("same-project");
  });

  it("getTerminalWorkspace returns different instances for different projects", () => {
    const a = getTerminalWorkspace("proj-a");
    const b = getTerminalWorkspace("proj-b");
    expect(a).not.toBe(b);
    disposeTerminalWorkspace("proj-a");
    disposeTerminalWorkspace("proj-b");
  });

  it("disposes only the removed project's workspace on a daemon event", () => {
    const removed = getTerminalWorkspace("test-project");
    const retained = getTerminalWorkspace("other-project");

    emitDaemonEvent("project.removed", { name: "test-project" });

    expect(getTerminalWorkspace("test-project")).not.toBe(removed);
    expect(getTerminalWorkspace("other-project")).toBe(retained);
    disposeTerminalWorkspace("other-project");
  });
});

describe("TerminalWorkspace — spawn/kill via events", () => {
  it("spawn calls daemon.spawnTerminal and terminal.spawned attaches controller", async () => {
    const ws = getTerminalWorkspace("test-project");
    const spy = vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    const id = await ws.spawn();
    expect(id).toBe("term-1");
    expect(spy).toHaveBeenCalled();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getActiveId()).toBe("term-1");
  });

  it("kill sends closing, terminal.exited keeps tab as exited, remove clears it", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    const killSpy = vi.spyOn(daemon, "killTerminal").mockResolvedValue(undefined);
    await ws.kill("term-1");
    expect(killSpy).toHaveBeenCalledWith("term-1");
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("closing");
    emitDaemonEvent("terminal.exited", { code: 0, terminal_id: "term-1" });
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("exited");
    ws.remove("term-1");
    expect(ws.getTerminals()).toEqual([]);
    expect(ws.getActiveId()).toBeNull();
  });

  it("two preexisting terminals: deterministic active ID when activeId null", () => {
    const ws = getTerminalWorkspace("test-project");
    currentTerminals = [
      {
        cols: 80,
        command: "sh",
        id: "term-b",
        project: "test-project",
        rows: 24,
        startedAt: 1,
      },
      {
        cols: 80,
        command: "sh",
        id: "term-a",
        project: "test-project",
        rows: 24,
        startedAt: 2,
      },
    ];
    ws["reconcileFromSnapshot"]();
    const terminals = ws.getTerminals();
    expect(terminals).toHaveLength(2);
    expect(ws.getActiveId()).toBe("term-b");
  });

  it("unrelated store update does not remove spawned terminal", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(ws.getTerminals()).toHaveLength(1);
    currentTerminals = [];
    triggerStoreUpdate();
    triggerStoreUpdate();
    expect(ws.getTerminals()).toHaveLength(1);
  });

  it("terminal.exited then unrelated store update does not resurrect", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    emitDaemonEvent("terminal.exited", { code: 0, terminal_id: "term-1" });
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("exited");
    ws.remove("term-1");
    currentTerminals = [
      {
        cols: 80,
        command: "sh",
        id: "term-1",
        project: "test-project",
        rows: 24,
        startedAt: 1,
      },
    ];
    triggerStoreUpdate();
    expect(ws.getTerminals()).toEqual([]);
  });
});

describe("TerminalWorkspace — lifecycle initialization", () => {
  it("terminal spawned while already connected becomes active immediately", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    connectionState = "connected";
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("active");
  });

  it("terminal spawned while disconnected becomes disconnected", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    connectionState = "disconnected";
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("disconnected");
  });
});

describe("TerminalWorkspace — close intent", () => {
  it("explicit close removes tab after terminal.exited", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(ws.getTerminals()).toHaveLength(1);
    const killSpy = vi.spyOn(daemon, "killTerminal").mockResolvedValue(undefined);
    ws.close("term-1");
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("closing");
    emitDaemonEvent("terminal.exited", { terminal_id: "term-1", code: 0 });
    expect(killSpy).toHaveBeenCalledWith("term-1");
    expect(ws.getTerminals()).toHaveLength(0);
  });

  it("natural exit retains tab with Restart option", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(ws.getTerminals()).toHaveLength(1);
    emitDaemonEvent("terminal.exited", { terminal_id: "term-1", code: 0 });
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("exited");
  });
});

describe("TerminalWorkspace — subscribe", () => {
  it("notifies listener on spawn event", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    const listener = vi.fn<() => void>();
    ws.subscribe(listener);
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    expect(listener).toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    const listener = vi.fn<() => void>();
    const unsub = ws.subscribe(listener);
    unsub();
    await ws.spawn();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("TerminalWorkspace — dispose", () => {
  it("dispose clears all terminals", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    ws.dispose();
    expect(ws.getTerminals()).toEqual([]);
    expect(ws.getActiveId()).toBeNull();
  });
});

describe("TerminalWorkspace — connection changes", () => {
  it("disconnect marks terminals disconnected", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    connectionState = "disconnected";
    triggerStoreUpdate();
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("disconnected");
  });
});

describe("TerminalWorkspace — kill rejection", () => {
  it("failed kill marks error and retains tab; retry retries kill", async () => {
    const ws = getTerminalWorkspace("test-project");
    vi.spyOn(daemon, "spawnTerminal").mockResolvedValue("term-1");
    await ws.spawn();
    emitDaemonEvent("terminal.spawned", {
      cols: 80,
      command: "sh",
      id: "term-1",
      project: "test-project",
      rows: 24,
      startedAt: 1,
    });
    const killSpy = vi
      .spyOn(daemon, "killTerminal")
      .mockRejectedValueOnce(new Error("daemon unreachable"))
      .mockResolvedValueOnce(undefined);
    await ws.kill("term-1");
    expect(ws.getTerminals()).toHaveLength(1);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("error");
    expect(ws.getTerminals()[0].controller.getError()).toBe("daemon unreachable");
    await ws.kill("term-1");
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(ws.getTerminals()[0].controller.getLifecycle()).toBe("closing");
  });
});
