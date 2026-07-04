/**
 * WebSocket client for the warpforge daemon plus a minimal external store.
 *
 * The shell is a thin client by design: this module is the ONLY place that
 * talks to the daemon, and views subscribe to the store it maintains. There
 * is no business logic here — just request/response correlation and applying
 * daemon events onto the last snapshot.
 */

import {
  AgentConfig,
  DaemonEndpoint,
  DaemonEvent,
  DetectedAgent,
  EMPTY_SNAPSHOT,
  FileDoc,
  ServerMessage,
  SessionUpdate,
  Snapshot,
  TaskDiff,
  isEvent,
} from "./protocol";

export type ConnectionState = "connecting" | "connected" | "disconnected";

const nowSecs = () => Math.floor(Date.now() / 1000);

export interface DaemonState {
  connection: ConnectionState;
  snapshot: Snapshot;
  /** Retained per-task ACP stream (bounded), keyed by task id. */
  sessionUpdates: Record<string, SessionUpdate[]>;
  /** Service log lines keyed by "project/service", bounded to MAX_SERVICE_LOGS. */
  serviceLogs: Record<string, string[]>;
  /** Non-null when daemon signals first-run setup is needed. */
  pendingAgentSetup: DetectedAgent[] | null;
}

const MAX_SESSION_UPDATES = 500;
const MAX_SERVICE_LOGS = 1000;

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
    serviceLogs: {},
    pendingAgentSetup: null,
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

  // ── demo mode (no daemon; used for UI review and `?demo` dev runs) ──
  private demoDiff: ((taskId: string) => TaskDiff) | null = null;
  private demoFileDoc: ((path: string) => FileDoc) | null = null;

  enableDemoMode(seed: {
    snapshot: Snapshot;
    sessionUpdates: Record<string, SessionUpdate[]>;
    diffFor: (taskId: string) => TaskDiff;
    fileDocFor: (path: string) => FileDoc;
  }) {
    this.demoDiff = seed.diffFor;
    this.demoFileDoc = seed.fileDocFor;
    this.setState({
      connection: "connected",
      snapshot: seed.snapshot,
      sessionUpdates: seed.sessionUpdates,
    });
  }

  /** Inject a daemon event locally (demo mode only). */
  demoEvent(ev: DaemonEvent) {
    if (this.demoDiff) this.applyEvent(ev);
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
    if (this.demoDiff) return this.demoRequest(method, params);
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

  private appendUpdate(taskId: string, update: SessionUpdate) {
    const updates = this.state.sessionUpdates[taskId] ?? [];
    this.setState({
      sessionUpdates: { ...this.state.sessionUpdates, [taskId]: [...updates, update] },
    });
  }

  private demoRequest(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "diff.get":
        return Promise.resolve(this.demoDiff!(String(p.task_id)));
      case "file.contents":
        return Promise.resolve(this.demoFileDoc!(String(p.path)));
      case "file.save":
        return Promise.resolve({});
      case "session.permission": {
        const taskId = String(p.task_id);
        this.appendUpdate(taskId, {
          kind: "agent_text",
          text: `(permission ${String(p.outcome)} — continuing)`,
        });
        // Reflect the answer on the task so it leaves the attention rail.
        this.patchTask(taskId, (t) => ({ ...t, status: "running", updatedAt: nowSecs() }));
        return Promise.resolve({});
      }
      case "session.prompt": {
        const taskId = String(p.task_id);
        this.appendUpdate(taskId, { kind: "user_message", text: String(p.text) });
        // Fake an agent acknowledgement shortly after.
        setTimeout(
          () =>
            this.appendUpdate(taskId, {
              kind: "agent_text",
              text: "Got it — adjusting course.",
            }),
          700,
        );
        return Promise.resolve({});
      }
      case "task.create": {
        const id = `t${Math.random().toString(36).slice(2, 7)}`;
        const task = {
          id,
          project: String(p.project),
          prompt: String(p.prompt),
          agent: String(p.agent ?? "claude"),
          status: "running" as const,
          tags: (p.tags as string[]) ?? [],
          createdAt: nowSecs(),
          updatedAt: nowSecs(),
          filesChanged: 0,
          blockedReason: null,
        };
        this.applyEvent({ event: "task.created", data: task });
        if (p.include_runtime_context) {
          this.appendUpdate(id, {
            kind: "agent_text",
            text: "Context received: services are up on their dev ports. Starting.",
          });
        }
        return Promise.resolve({ taskId: id });
      }
      case "task.cancel": {
        this.patchTask(String(p.task_id), (t) => ({
          ...t,
          status: "done",
          updatedAt: nowSecs(),
        }));
        return Promise.resolve({});
      }
      default:
        return Promise.resolve({});
    }
  }

  private patchTask(id: string, fn: (t: import("./protocol").TaskInfo) => import("./protocol").TaskInfo) {
    const task = this.state.snapshot.tasks.find((t) => t.id === id);
    if (task) this.applyEvent({ event: "task.updated", data: fn(task) });
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
      case "state.snapshot": {
        const { sessionHistory, ...snap } = ev.data;
        this.setState({
          snapshot: snap as Snapshot,
          ...(sessionHistory ? { sessionUpdates: sessionHistory } : {}),
        });
        break;
      }
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
      case "service.status": {
        const exists = snap.services.some(
          (s) => s.project === ev.data.project && s.name === ev.data.service,
        );
        const services = exists
          ? snap.services.map((s) =>
              s.project === ev.data.project && s.name === ev.data.service
                ? { ...s, status: ev.data.status, allocatedPort: ev.data.allocated_port }
                : s,
            )
          : // A service started after we subscribed — add it. command/originalPort
            // fill in on the next full snapshot; status + port are what matter now.
            [
              ...snap.services,
              {
                project: ev.data.project,
                name: ev.data.service,
                command: "",
                status: ev.data.status,
                originalPort: 0,
                allocatedPort: ev.data.allocated_port,
                logSeq: 0,
              },
            ];
        this.setState({ snapshot: { ...snap, services } });
        break;
      }
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
      case "service.log": {
        const key = `${ev.data.project}/${ev.data.service}`;
        const existing = this.state.serviceLogs[key] ?? [];
        const trimmed = [...existing, ev.data.line].slice(-MAX_SERVICE_LOGS);
        this.setState({ serviceLogs: { ...this.state.serviceLogs, [key]: trimmed } });
        break;
      }
      case "agents.setup_needed":
        this.setState({ pendingAgentSetup: ev.data.detected });
        break;
      case "agents.updated":
        this.setState({
          snapshot: { ...snap, agents: ev.data.agents },
          pendingAgentSetup: null,
        });
        break;
      // High-frequency events with no retained state yet.
      case "portforward.log":
      case "terminal.screen":
      case "terminal.exited":
        break;
    }
  }

  dismissAgentSetup() {
    this.setState({ pendingAgentSetup: null });
  }

  async detectAgents(): Promise<DetectedAgent[]> {
    const result = await this.request("agents.detect", {});
    return Array.isArray(result) ? (result as DetectedAgent[]) : [];
  }

  async saveAgents(agents: AgentConfig[]) {
    await this.request("agents.update", { agents });
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
