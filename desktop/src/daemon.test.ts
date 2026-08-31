import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonClient } from "./daemon";
import type { Snapshot } from "./protocol";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = MockWebSocket.CLOSING;
  }

  send(message: string) {
    this.sent.push(message);
  }
}

describe("DaemonClient connection state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves a handshake mismatch until a compatible connection succeeds", async () => {
    const client = new DaemonClient();
    await client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.readyState = MockWebSocket.OPEN;
    void firstSocket.onopen?.();
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));

    const firstHandshake = JSON.parse(firstSocket.sent[0]) as { id: number };
    firstSocket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: firstHandshake.id,
          result: {
            daemonVersion: "0.1.0",
            exactVersionMatch: true,
            owner: "external",
            protocolCompatible: false,
            protocolVersion: 99,
          },
        }),
      }),
    );
    await vi.waitFor(() => expect(firstSocket.readyState).toBe(MockWebSocket.CLOSING));

    expect(client.getState()).toMatchObject({
      connectionError:
        "daemon protocol 99 is incompatible with desktop protocol 1. Stop the running daemon and relaunch Warpforge.",
    });

    firstSocket.readyState = MockWebSocket.CLOSED;
    firstSocket.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.readyState = MockWebSocket.OPEN;
    void secondSocket.onopen?.();
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    const secondHandshake = JSON.parse(secondSocket.sent[0]) as { id: number };
    secondSocket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: secondHandshake.id,
          result: {
            daemonVersion: "dev",
            exactVersionMatch: true,
            owner: "desktop",
            protocolCompatible: true,
            protocolVersion: 1,
          },
        }),
      }),
    );

    await vi.waitFor(() => expect(client.getState().connection).toBe("connected"));
    expect(client.getState().connectionError).toBeNull();
  });

  it("waitForDisconnect resolves when state is already disconnected", async () => {
    const client = new DaemonClient();

    await expect(client.waitForDisconnect()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces only one project's config-derived state", () => {
    const client = new DaemonClient();
    const snapshot: Snapshot = {
      agents: [],
      portforwards: [],
      projects: [
        {
          agentTemplates: {},
          declaredServices: ["old"],
          name: "demo",
          path: "/demo",
          portRange: [4000, 4099],
        },
        {
          agentTemplates: {},
          declaredServices: ["api"],
          name: "other",
          path: "/other",
          portRange: [4100, 4199],
        },
      ],
      services: [
        {
          allocatedPort: 0,
          command: "old",
          logSeq: 0,
          name: "old",
          originalPort: 3000,
          project: "demo",
          status: "stopped",
        },
        {
          allocatedPort: 4101,
          command: "api",
          logSeq: 0,
          name: "api",
          originalPort: 3001,
          project: "other",
          status: "running",
        },
      ],
      tasks: [],
      terminals: [],
    };
    client.enableDemoMode({
      snapshot,
      sessionUpdates: {},
      diffFor: (taskId) => ({ files: [], taskId }),
      fileDocFor: (path) => ({
        newText: "",
        oldText: "",
        path,
        status: "modified",
      }),
    });

    client.demoEvent({
      event: "project.configChanged",
      data: {
        project: {
          ...snapshot.projects[0],
          declaredServices: ["web"],
        },
        services: [
          {
            allocatedPort: 0,
            command: "bun dev",
            logSeq: 0,
            name: "web",
            originalPort: 5173,
            project: "demo",
            status: "stopped",
          },
        ],
        portforwards: [
          {
            localPort: 5432,
            logSeq: 0,
            name: "db",
            namespace: "dev",
            pod: "postgres",
            project: "demo",
            remotePort: 5432,
            status: "stopped",
          },
        ],
      },
    });

    expect(client.getState().snapshot.projects[0].declaredServices).toEqual(["web"]);
    expect(client.getState().snapshot.services.map((service) => service.name)).toEqual([
      "api",
      "web",
    ]);
    expect(client.getState().snapshot.portforwards[0].name).toBe("db");
  });

  it("projects project removal across all project-owned runtime state", () => {
    const client = new DaemonClient();
    client.enableDemoMode({
      snapshot: {
        projects: [
          {
            agentTemplates: {},
            declaredServices: ["web"],
            name: "demo",
            path: "/demo",
            portRange: [4000, 4099],
          },
          {
            agentTemplates: {},
            declaredServices: [],
            name: "other",
            path: "/other",
            portRange: [4100, 4199],
          },
        ],
        services: [
          {
            allocatedPort: 4000,
            command: "bun dev",
            logSeq: 0,
            name: "web",
            originalPort: 3000,
            project: "demo",
            status: "running",
          },
        ],
        portforwards: [
          {
            localPort: 5432,
            logSeq: 0,
            name: "db",
            namespace: "dev",
            pod: "postgres",
            project: "demo",
            remotePort: 5432,
            status: "active",
          },
        ],
        tasks: [],
        terminals: [
          {
            cols: 80,
            command: "sh",
            id: "terminal-1",
            project: "demo",
            rows: 24,
            startedAt: 1,
          },
        ],
      },
      sessionUpdates: {},
      diffFor: (taskId) => ({ files: [], taskId }),
      fileDocFor: (path) => ({ newText: "", oldText: "", path, status: "modified" }),
    });
    client.demoEvent({
      event: "service.log",
      data: { line: "ready", project: "demo", seq: 1, service: "web" },
    });
    client.demoEvent({
      event: "portforward.log",
      data: { line: "forwarding", name: "db", project: "demo", seq: 1 },
    });

    client.demoEvent({ event: "project.removed", data: { name: "demo" } });

    expect(client.getState().snapshot).toMatchObject({
      portforwards: [],
      projects: [{ name: "other" }],
      services: [],
      terminals: [],
    });
    expect(client.getState().serviceLogs).toEqual({});
    expect(client.getState().portforwardLogs).toEqual({});
  });

  it("sends explicit project resource teardown authorization", async () => {
    const client = new DaemonClient();
    const request = vi.spyOn(client, "request").mockResolvedValue(null);

    await client.removeProject("demo", true);

    expect(request).toHaveBeenCalledWith("project.remove", {
      name: "demo",
      stop_resources: true,
    });
  });

  /** A daemon that never answers must surface as an error, not as a spinner
   * that never stops: a wedged subprocess inside `lsp.detect` left the Settings
   * language-server list loading forever. */
  it("fails a request the daemon never answers instead of waiting forever", async () => {
    const client = new DaemonClient();
    const socket = await connectedSocket(client);

    const detect = client.detectLanguageServers();
    const rejected = detect.catch((error: Error) => error.message);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await rejected).toBe("lsp.detect did not answer within 120s");
  });

  /** Installing a language server shells out to a package manager, so it must
   * outlive the ordinary ceiling. */
  it("gives a package-manager request a wider ceiling", async () => {
    const client = new DaemonClient();
    const socket = await connectedSocket(client);

    const install = client.installLanguageServer("typescript");
    const settled = install.then(
      () => "resolved",
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(150_000);
    const sent = JSON.parse(socket.sent[socket.sent.length - 1]) as { id: number };
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ id: sent.id, result: { command: "", ok: true, output: "" } }),
      }),
    );

    expect(await settled).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Drive a client through connect + handshake and hand back its socket. */
async function connectedSocket(client: DaemonClient): Promise<MockWebSocket> {
  await client.connect();
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  socket.readyState = MockWebSocket.OPEN;
  void socket.onopen?.();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  const handshake = JSON.parse(socket.sent[0]) as { id: number };
  socket.onmessage?.(
    new MessageEvent("message", {
      data: JSON.stringify({
        id: handshake.id,
        result: {
          daemonVersion: "dev",
          exactVersionMatch: true,
          owner: "desktop",
          protocolCompatible: true,
          protocolVersion: 1,
        },
      }),
    }),
  );
  await vi.waitFor(() => expect(client.getState().connection).toBe("connected"));
  return socket;
}
