import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonClient } from "./daemon";

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

});
