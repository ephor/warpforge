/**
 * WebSocket client for the warpforge daemon plus a minimal external store.
 *
 * The shell is a thin client by design: this module is the ONLY place that
 * talks to the daemon, and views subscribe to the store it maintains. There
 * is no business logic here — just request/response correlation and applying
 * daemon events onto the last snapshot.
 */

import {
  DaemonEndpoint,
  DaemonEvent,
  EMPTY_SNAPSHOT,
  ServerMessage,
  SessionUpdate,
  Snapshot,
  isEvent,
} from "./protocol";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface DaemonState {
  connection: ConnectionState;
  snapshot: Snapshot;
  /** Retained per-task ACP stream (bounded), keyed by task id. */
  sessionUpdates: Record<string, SessionUpdate[]>;
}

const MAX_SESSION_UPDATES = 500;

type Listener = () => void;

class DaemonClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<Listener>();
  private reconnectDelay = 500;
  private state: DaemonState = {
    connection: "disconnected",
    snapshot: EMPTY_SNAPSHOT,
    sessionUpdates: {},
  };

  // ── external store interface (for useSyncExternalStore) ──
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): DaemonState => this.state;

  private setState(patch: Partial<DaemonState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  // ── connection ──
  async connect(): Promise<void> {
    this.setState({ connection: "connecting" });
    const endpoint = await discoverEndpoint();
    const ws = new WebSocket(endpoint.url);
    this.ws = ws;

    ws.onopen = () => {
      if (endpoint.token) ws.send(JSON.stringify({ auth: endpoint.token }));
      this.setState({ connection: "connected" });
      this.reconnectDelay = 500;
      void this.request("state.subscribe", { topics: [] });
    };
    ws.onmessage = (msg) => {
      const parsed = JSON.parse(msg.data as string) as ServerMessage;
      this.handleMessage(parsed);
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    this.setState({ connection: "disconnected" });
    this.pending.forEach((p) => p.reject(new Error("daemon disconnected")));
    this.pending.clear();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 15_000);
    setTimeout(() => void this.connect().catch(() => this.scheduleReconnect()), delay);
  }

  // ── RPC ──
  request(method: string, params?: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected to daemon"));
    }
    const id = this.nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private handleMessage(msg: ServerMessage) {
    if (isEvent(msg)) {
      this.applyEvent(msg);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if ("error" in msg) {
      pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // ── event → state ──
  private applyEvent(ev: DaemonEvent) {
    const snap = this.state.snapshot;
    switch (ev.event) {
      case "state.snapshot":
        this.setState({ snapshot: ev.data });
        break;
      case "project.added":
        this.setState({
          snapshot: { ...snap, projects: [...snap.projects, ev.data] },
        });
        break;
      case "project.removed":
        this.setState({
          snapshot: {
            ...snap,
            projects: snap.projects.filter((p) => p.name !== ev.data.name),
          },
        });
        break;
      case "service.status":
        this.setState({
          snapshot: {
            ...snap,
            services: snap.services.map((s) =>
              s.project === ev.data.project && s.name === ev.data.service
                ? { ...s, status: ev.data.status, allocatedPort: ev.data.allocated_port }
                : s,
            ),
          },
        });
        break;
      case "portforward.status":
        this.setState({
          snapshot: {
            ...snap,
            portforwards: snap.portforwards.map((pf) =>
              pf.project === ev.data.project && pf.name === ev.data.name
                ? { ...pf, status: ev.data.status }
                : pf,
            ),
          },
        });
        break;
      case "task.created":
        this.setState({
          snapshot: { ...snap, tasks: [...snap.tasks, ev.data] },
        });
        break;
      case "task.updated":
        this.setState({
          snapshot: {
            ...snap,
            tasks: snap.tasks.map((t) => (t.id === ev.data.id ? ev.data : t)),
          },
        });
        break;
      case "session.update": {
        const { task_id, update } = ev.data;
        const existing = this.state.sessionUpdates[task_id] ?? [];
        const trimmed = [...existing, update].slice(-MAX_SESSION_UPDATES);
        this.setState({
          sessionUpdates: { ...this.state.sessionUpdates, [task_id]: trimmed },
        });
        break;
      }
      // Log lines and terminal frames are high-frequency; detail views will
      // maintain their own bounded buffers once implemented.
      case "service.log":
      case "portforward.log":
      case "terminal.screen":
      case "terminal.exited":
        break;
    }
  }
}

/**
 * Find the daemon endpoint. Inside Tauri, the Rust side reads
 * `~/.warpforge/daemon.json`; in a plain browser (vite dev without Tauri)
 * fall back to the default local port so the UI is still exercisable.
 */
async function discoverEndpoint(): Promise<DaemonEndpoint> {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<DaemonEndpoint>("daemon_endpoint");
  }
  return { pid: 0, url: "ws://127.0.0.1:61814", token: "", version: "dev" };
}

export const daemon = new DaemonClient();
