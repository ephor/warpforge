/**
 * WebSocket client for the warpforge daemon plus a minimal external store.
 *
 * The shell is a thin client by design: this module is the ONLY place that
 * talks to the daemon, and views subscribe to the store it maintains. There
 * is no business logic here — just request/response correlation and applying
 * daemon events onto the last snapshot.
 */

import { appendCoalescedUpdate, coalesceUpdates } from "./lib/sessionStream";
import { stampSessionHistoryStartTimes } from "./lib/sessionTiming";
import type {
  AccountInfo,
  AgentConfig,
  DaemonEndpoint,
  DaemonEvent,
  DaemonHandshake,
  DetectedAgent,
  ExternalSession,
  FileDoc,
  ServerMessage,
  SessionUpdate,
  Snapshot,
  TaskDiff,
  UpdateHandoff,
} from "./protocol";
import { EMPTY_SNAPSHOT, isEvent } from "./protocol";

export type ConnectionState = "connecting" | "connected" | "disconnected";

const nowSecs = () => Math.floor(Date.now() / 1000);

export interface DaemonState {
  connection: ConnectionState;
  /** Most recent connection, discovery, or handshake failure. Cleared after a successful handshake. */
  connectionError: string | null;
  snapshot: Snapshot;
  /** Retained per-task ACP stream (bounded), keyed by task id. */
  sessionUpdates: Record<string, SessionUpdate[]>;
  /** Service log lines keyed by "project/service", bounded to MAX_SERVICE_LOGS. */
  serviceLogs: Record<string, string[]>;
  /** Port-forward log lines keyed by "project/name", bounded to MAX_PORTFORWARD_LOGS. */
  portforwardLogs: Record<string, string[]>;
  /** Non-null when daemon signals first-run setup is needed. */
  pendingAgentSetup: DetectedAgent[] | null;
}

const MAX_SERVICE_LOGS = 1000;
const MAX_PORTFORWARD_LOGS = 500;
const MAX_TERMINAL_BUFFER_BYTES = 64 * 1024;
const MAX_TERMINAL_BUFFER_GLOBAL_BYTES = 512 * 1024;
const TERMINAL_BUFFER_TTL_MS = 30_000;
export const DAEMON_PROTOCOL_VERSION = 1;

type Listener = () => void;
type EventListener = (event: DaemonEvent) => void;
export type TerminalDataListener = (data: Uint8Array) => void;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();
  private reconnectDelay = 500;
  private reconnectTimer: number | null = null;
  private reconnectSuspended = false;
  private handshake: DaemonHandshake | null = null;
  private toolCallStarts = new Map<string, number>();
  private terminalDataSubscribers = new Map<string, Set<TerminalDataListener>>();
  private terminalDataBuffers = new Map<
    string,
    { chunks: Array<{ data: Uint8Array; ts: number }>; bytes: number }
  >();
  private state: DaemonState = {
    connection: "disconnected",
    connectionError: null,
    pendingAgentSetup: null,
    serviceLogs: {},
    portforwardLogs: {},
    sessionUpdates: {},
    snapshot: EMPTY_SNAPSHOT,
  };

  // ── external store interface (for useSyncExternalStore) ──
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  subscribeEvents = (fn: EventListener): (() => void) => {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  };
  getState = (): DaemonState => this.state;

  subscribeTerminalData(terminalId: string, listener: TerminalDataListener): () => void {
    let subs = this.terminalDataSubscribers.get(terminalId);
    if (!subs) {
      subs = new Set();
      this.terminalDataSubscribers.set(terminalId, subs);
    }
    subs.add(listener);
    const buf = this.terminalDataBuffers.get(terminalId);
    if (buf) {
      for (const chunk of buf.chunks) listener(chunk.data);
      this.terminalDataBuffers.delete(terminalId);
    }
    return () => {
      const s = this.terminalDataSubscribers.get(terminalId);
      if (s) {
        s.delete(listener);
        if (s.size === 0) this.terminalDataSubscribers.delete(terminalId);
      }
    };
  }

  clearTerminalBuffer(terminalId: string) {
    this.terminalDataBuffers.delete(terminalId);
  }

  private deliverTerminalData(terminalId: string, data: Uint8Array) {
    const subs = this.terminalDataSubscribers.get(terminalId);
    if (subs && subs.size > 0) {
      for (const listener of subs) listener(data);
      return;
    }
    let buf = this.terminalDataBuffers.get(terminalId);
    if (!buf) {
      buf = { chunks: [], bytes: 0 };
      this.terminalDataBuffers.set(terminalId, buf);
    }
    const now = Date.now();
    buf.chunks.push({ data, ts: now });
    buf.bytes += data.length;
    while (buf.chunks.length > 1 && buf.bytes > MAX_TERMINAL_BUFFER_BYTES) {
      const dropped = buf.chunks.shift()!;
      buf.bytes -= dropped.data.length;
    }
    this.pruneGlobalTerminalBuffers(now);
  }

  private pruneGlobalTerminalBuffers(now: number) {
    let globalBytes = 0;
    for (const buf of this.terminalDataBuffers.values()) globalBytes += buf.bytes;
    while (globalBytes > MAX_TERMINAL_BUFFER_GLOBAL_BYTES) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [key, buf] of this.terminalDataBuffers.entries()) {
        if (buf.chunks.length > 0 && buf.chunks[0].ts < oldestTs) {
          oldestTs = buf.chunks[0].ts;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const ob = this.terminalDataBuffers.get(oldestKey)!;
      if (ob.chunks.length === 0) break;
      if (now - ob.chunks[0].ts > TERMINAL_BUFFER_TTL_MS || ob.chunks.length > 1) {
        const dropped = ob.chunks.shift()!;
        ob.bytes -= dropped.data.length;
        globalBytes -= dropped.data.length;
        if (ob.chunks.length === 0) {
          this.terminalDataBuffers.delete(oldestKey);
        }
      } else {
        break;
      }
    }
    for (const [key, buf] of this.terminalDataBuffers.entries()) {
      while (buf.chunks.length > 0 && now - buf.chunks[0].ts > TERMINAL_BUFFER_TTL_MS) {
        const dropped = buf.chunks.shift()!;
        buf.bytes -= dropped.data.length;
      }
      if (buf.chunks.length === 0) {
        this.terminalDataBuffers.delete(key);
      }
    }
  }

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
    const sessionUpdates = this.stampSessionHistories(
      Object.fromEntries(
        Object.entries(seed.sessionUpdates).map(([taskId, updates]) => [
          taskId,
          updates.some((update) => update.kind === "prompt_capabilities")
            ? updates
            : [
                { embedded_context: true, image: true, kind: "prompt_capabilities" as const },
                ...updates,
              ],
        ]),
      ),
    );
    this.setState({
      connection: "connected",
      connectionError: null,
      sessionUpdates,
      snapshot: seed.snapshot,
    });
  }

  /** Inject a daemon event locally (demo mode only). */
  demoEvent(ev: DaemonEvent) {
    if (this.demoDiff) {
      this.applyEvent(ev);
    }
  }

  // ── connection ──
  async connect(): Promise<void> {
    if (this.reconnectSuspended || this.state.connection !== "disconnected") return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState({ connection: "connecting" });
    let endpoint: DaemonEndpoint;
    try {
      endpoint = await discoverEndpoint();
    } catch (error) {
      this.setState({
        connection: "disconnected",
        connectionError: connectionErrorMessage(error),
      });
      this.scheduleReconnect();
      throw error;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint.url);
    } catch (error) {
      this.setState({
        connection: "disconnected",
        connectionError: connectionErrorMessage(error),
      });
      this.scheduleReconnect();
      throw error;
    }
    this.ws = ws;

    ws.onopen = async () => {
      if (endpoint.token) {
        ws.send(JSON.stringify({ auth: endpoint.token }));
      }
      try {
        const clientVersion = await desktopVersion();
        const handshake = (await this.request("system.handshake", {
          client_version: clientVersion,
          protocol_version: DAEMON_PROTOCOL_VERSION,
        })) as DaemonHandshake;
        const requiresExactVersion = clientVersion !== "dev";
        if (
          !handshake.protocolCompatible ||
          (requiresExactVersion && !handshake.exactVersionMatch)
        ) {
          throw new Error(
            !handshake.protocolCompatible
              ? `daemon protocol ${handshake.protocolVersion} is incompatible with desktop protocol ${DAEMON_PROTOCOL_VERSION}`
              : `daemon version ${handshake.daemonVersion} does not match this desktop app (${clientVersion})`,
          );
        }
        this.handshake = handshake;
        this.setState({ connection: "connected", connectionError: null });
        this.reconnectDelay = 500;
        await this.request("state.subscribe", { topics: [] });
      } catch (error) {
        this.setState({ connectionError: connectionErrorMessage(error) });
        ws.close();
      }
    };
    ws.onmessage = (msg) => {
      const parsed = JSON.parse(msg.data as string) as ServerMessage;
      this.handleMessage(parsed);
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      this.setState({
        connectionError: "Could not connect to the daemon. Warpforge will keep retrying.",
      });
      ws.close();
    };
  }

  private scheduleReconnect() {
    this.ws = null;
    this.handshake = null;
    this.setState({
      connection: "disconnected",
      ...(!this.state.connectionError && !this.reconnectSuspended
        ? { connectionError: "Daemon disconnected. Warpforge will keep retrying." }
        : {}),
    });
    this.pending.forEach((p) => p.reject(new Error("daemon disconnected")));
    this.pending.clear();
    this.terminalDataBuffers.clear();
    if (this.reconnectSuspended || this.reconnectTimer !== null) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 15_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // Endpoint discovery failures schedule their own retry. WebSocket
        // failures flow through onclose and do the same.
      });
    }, delay);
  }

  // ── RPC ──
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.demoDiff) {
      return this.demoRequest(method, params);
    }
    if (method !== "system.handshake" && this.state.connection !== "connected") {
      return Promise.reject(new Error("daemon handshake has not completed"));
    }
    const { ws } = this;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected to daemon"));
    }
    const id = this.nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
  }

  async prepareUpdateHandoff(): Promise<UpdateHandoff> {
    if (!this.handshake) {
      throw new Error("The daemon handshake has not completed");
    }
    if (this.handshake.owner !== "desktop") {
      throw new Error(
        "This daemon was started outside the desktop app. Stop it and relaunch Warpforge before updating.",
      );
    }
    this.reconnectSuspended = true;
    try {
      const handoff = (await this.request("update.prepareShutdown", {
        expected_daemon_version: this.handshake.daemonVersion,
        protocol_version: DAEMON_PROTOCOL_VERSION,
      })) as UpdateHandoff;
      if (!handoff.ready) {
        this.reconnectSuspended = false;
      }
      return handoff;
    } catch (error) {
      this.reconnectSuspended = false;
      throw error;
    }
  }

  waitForDisconnect(timeoutMs = 5_000): Promise<void> {
    if (
      this.state.connection === "disconnected" ||
      !this.ws ||
      this.ws.readyState === WebSocket.CLOSED
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error("The daemon did not stop in time; the update was not installed"));
      }, timeoutMs);
      const unsubscribe = this.subscribe(() => {
        if (this.state.connection === "disconnected") {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  resumeAfterFailedUpdate() {
    this.reconnectSuspended = false;
    if (this.state.connection === "disconnected") {
      void this.connect().catch(() => {
        // connect() owns retry scheduling.
      });
    }
  }

  private appendUpdate(taskId: string, update: SessionUpdate) {
    const updates = this.state.sessionUpdates[taskId] ?? [];
    const stamped = this.stampSessionUpdate(taskId, update);
    this.setState({
      sessionUpdates: {
        ...this.state.sessionUpdates,
        [taskId]: appendCoalescedUpdate(updates, stamped),
      },
    });
  }

  private stampSessionUpdate(taskId: string, update: SessionUpdate): SessionUpdate {
    if (update.kind !== "tool_call") return update;
    const key = `${taskId}\0${update.tool_call_id}`;
    const startedAt = update.started_at ?? this.toolCallStarts.get(key) ?? Date.now();
    this.toolCallStarts.set(key, startedAt);
    return update.started_at === startedAt ? update : { ...update, started_at: startedAt };
  }

  private stampSessionHistories(histories: Record<string, SessionUpdate[]>) {
    this.toolCallStarts.clear();
    return Object.fromEntries(
      Object.entries(histories).map(([taskId, updates]) => {
        const stamped = stampSessionHistoryStartTimes(coalesceUpdates(updates));
        for (const update of stamped) {
          if (update.kind === "tool_call" && update.started_at !== undefined) {
            this.toolCallStarts.set(`${taskId}\0${update.tool_call_id}`, update.started_at);
          }
        }
        return [taskId, stamped];
      }),
    );
  }

  private demoRequest(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "diff.get":
        return Promise.resolve(this.demoDiff!(String(p.task_id)));
      case "file.contents":
        return Promise.resolve(this.demoFileDoc!(String(p.path)));
      case "file.list": {
        const diff = this.demoDiff!(String(p.task_id));
        const files = diff.files.map((f) => ({ changed: true, path: f.path }));
        return Promise.resolve(files);
      }
      case "file.search":
        return Promise.resolve([]);
      case "file.save":
        return Promise.resolve({});
      case "git.pushInfo": {
        const taskId = String(p.task_id);
        const task = this.state.snapshot.tasks.find((item) => item.id === taskId);
        return Promise.resolve({
          branch: "feature/demo-push",
          commits: [
            {
              hash: "7bc91e2d36d05a89f86e58d27060edeb36cf91c2",
              shortHash: "7bc91e2",
              subject: task?.prompt || "Improve workspace flow",
              author: "Warpforge Developer",
              files: this.demoDiff!(taskId).files.map((file) => ({
                path: file.path,
                status: file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M",
              })),
            },
          ],
          hasUpstream: true,
          remote: "origin",
          remoteBranch: "feature/demo-push",
          upstream: "origin/feature/demo-push",
        });
      }
      case "git.push":
        return Promise.resolve({
          branch: "feature/demo-push",
          conflicts: [],
          message: p.force ? "pushed with force-with-lease" : "pushed to origin",
          status: "ok",
        });
      case "service.logs":
        return Promise.resolve([
          `[${String(p.service)}] starting process`,
          `[${String(p.service)}] loading workspace config`,
          `[${String(p.service)}] listening on allocated port`,
        ]);
      case "portforward.logs":
        return Promise.resolve([
          `[${String(p.name)}] resolving pod`,
          `[${String(p.name)}] starting kubectl port-forward`,
          `[${String(p.name)}] forwarding :${String(p.localPort ?? 8080)}`,
        ]);
      case "runtime.stopAll":
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
        const attachments = Array.isArray(p.attachments)
          ? p.attachments.map((attachment: any) =>
              attachment.type === "file"
                ? { path: String(attachment.path), type: "file" as const }
                : { name: String(attachment.name), type: "image" as const },
            )
          : [];
        this.appendUpdate(taskId, { attachments, kind: "user_message", text: String(p.text) });
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
        const promptText = String(p.prompt);
        const task = {
          agent: String(p.agent ?? "claude"),
          blockedReason: null,
          createdAt: nowSecs(),
          filesChanged: 0,
          id,
          project: String(p.project),
          prompt: promptText,
          status: "running" as const,
          tags: (p.tags as string[]) ?? [],
          title: promptText.trim().split("\n")[0]?.trim().slice(0, 80) ?? "",
          updatedAt: nowSecs(),
        };
        this.applyEvent({ data: task, event: "task.created" });
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
      case "task.archive": {
        this.patchTask(String(p.task_id), (t) => ({
          ...t,
          status: "done",
          updatedAt: nowSecs(),
        }));
        return Promise.resolve({});
      }
      case "task.delete": {
        this.applyEvent({ data: { id: String(p.task_id) }, event: "task.removed" });
        return Promise.resolve({});
      }
      case "sessions.list":
        return Promise.resolve({ sessions: [] });
      case "orchestrate.start": {
        const graphId = `g${Math.random().toString(36).slice(2, 7)}`;
        const taskId = `t${Math.random().toString(36).slice(2, 7)}`;
        const goal = String(p.goal ?? "");
        // Create a parent task with orchestration graph
        const graph = {
          goal,
          id: graphId,
          nodes: [
            {
              id: `${graphId}_plan`,
              kind: "plan" as const,
              agent: "claude",
              status: "running" as const,
              taskId,
            },
          ],
        };
        const task = {
          agent: "claude",
          blockedReason: null,
          createdAt: nowSecs(),
          filesChanged: 0,
          id: taskId,
          orchestrationGraph: graph,
          project: String(p.project),
          prompt: goal,
          status: "running" as const,
          tags: ["orchestrator"],
          title: goal.trim().split("\n")[0]?.trim().slice(0, 80) ?? "",
          updatedAt: nowSecs(),
        };
        this.applyEvent({ data: task, event: "task.created" });
        return Promise.resolve({ graphId, taskId });
      }
      case "orchestrate.list": {
        const graphs: { goal: string; id: string; project: string; totalNodes: number }[] = [];
        for (const t of this.state.snapshot.tasks) {
          if (t.orchestrationGraph) {
            graphs.push({
              goal: t.orchestrationGraph.goal,
              id: t.orchestrationGraph.id,
              project: t.project,
              totalNodes: t.orchestrationGraph.nodes.length,
            });
          }
        }
        return Promise.resolve({ graphs });
      }
      case "terminal.spawn": {
        const id = `t${Math.random().toString(36).slice(2, 10)}`;
        // Synthesize a TerminalInfo entry so the workspace sees it.
        this.applyEvent({
          event: "state.snapshot",
          data: {
            ...this.state.snapshot,
            terminals: [
              ...this.state.snapshot.terminals,
              {
                cols: Number(p.cols) || 80,
                command: 'exec "${SHELL:-/bin/sh}" -l',
                id,
                project: String(p.project),
                rows: Number(p.rows) || 24,
                startedAt: nowSecs(),
              },
            ],
          },
        });
        // Emit a fake prompt via terminal.data.
        setTimeout(() => {
          const prompt = "$ ";
          const b64 = bytesToBase64(new TextEncoder().encode(prompt));
          this.applyEvent({
            event: "terminal.data",
            data: { data_b64: b64, terminal_id: id },
          });
        }, 50);
        return Promise.resolve({ terminalId: id });
      }
      case "terminal.input":
      case "terminal.resize":
      case "terminal.kill":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  private patchTask(
    id: string,
    fn: (t: import("./protocol").TaskInfo) => import("./protocol").TaskInfo,
  ) {
    const task = this.state.snapshot.tasks.find((t) => t.id === id);
    if (task) {
      this.applyEvent({ event: "task.updated", data: fn(task) });
    }
  }

  private handleMessage(msg: ServerMessage) {
    if (isEvent(msg)) {
      this.applyEvent(msg);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    if ("error" in msg) {
      pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // ── event → state ──
  private applyEvent(ev: DaemonEvent) {
    this.eventListeners.forEach((listener) => listener(ev));
    const snap = this.state.snapshot;
    switch (ev.event) {
      case "state.snapshot": {
        const { sessionHistory, ...snapshotData } = ev.data;
        this.setState({
          snapshot: snapshotData as Snapshot,
          ...(sessionHistory ? { sessionUpdates: this.stampSessionHistories(sessionHistory) } : {}),
        });
        break;
      }
      case "project.added":
        this.setState({
          snapshot: { ...snap, projects: [...snap.projects, ev.data] },
        });
        break;
      case "project.removed":
        for (const terminal of snap.terminals) {
          if (terminal.project === ev.data.name) {
            this.clearTerminalBuffer(terminal.id);
          }
        }
        this.setState({
          snapshot: {
            ...snap,
            projects: snap.projects.filter((p) => p.name !== ev.data.name),
            services: snap.services.filter((service) => service.project !== ev.data.name),
            portforwards: snap.portforwards.filter(
              (portforward) => portforward.project !== ev.data.name,
            ),
            terminals: snap.terminals.filter((terminal) => terminal.project !== ev.data.name),
          },
          serviceLogs: Object.fromEntries(
            Object.entries(this.state.serviceLogs).filter(
              ([key]) => !key.startsWith(`${ev.data.name}/`),
            ),
          ),
          portforwardLogs: Object.fromEntries(
            Object.entries(this.state.portforwardLogs).filter(
              ([key]) => !key.startsWith(`${ev.data.name}/`),
            ),
          ),
        });
        break;
      case "project.configChanged": {
        const { project, services, portforwards } = ev.data;
        const exists = snap.projects.some((item) => item.name === project.name);
        this.setState({
          snapshot: {
            ...snap,
            projects: exists
              ? snap.projects.map((item) => (item.name === project.name ? project : item))
              : [...snap.projects, project],
            services: [
              ...snap.services.filter((item) => item.project !== project.name),
              ...services,
            ],
            portforwards: [
              ...snap.portforwards.filter((item) => item.project !== project.name),
              ...portforwards,
            ],
          },
        });
        break;
      }
      case "service.status": {
        const exists = snap.services.some(
          (s) => s.project === ev.data.project && s.name === ev.data.service,
        );
        const services = exists
          ? snap.services.map((s) =>
              s.project === ev.data.project && s.name === ev.data.service
                ? { ...s, allocatedPort: ev.data.allocated_port, status: ev.data.status }
                : s,
            )
          : // A service started after we subscribed — add it. command/originalPort
            // Fill in on the next full snapshot; status + port are what matter now.
            [
              ...snap.services,
              {
                allocatedPort: ev.data.allocated_port,
                command: "",
                logSeq: 0,
                name: ev.data.service,
                originalPort: 0,
                project: ev.data.project,
                status: ev.data.status,
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
      case "task.removed": {
        const prefix = `${ev.data.id}\0`;
        for (const key of this.toolCallStarts.keys()) {
          if (key.startsWith(prefix)) this.toolCallStarts.delete(key);
        }
        const { [ev.data.id]: _dropped, ...sessionUpdates } = this.state.sessionUpdates;
        this.setState({
          sessionUpdates,
          snapshot: { ...snap, tasks: snap.tasks.filter((t) => t.id !== ev.data.id) },
        });
        break;
      }
      case "session.update": {
        // Keep the full semantic history, but fold sub-word text chunks and
        // repeated tool lifecycle frames instead of retaining transport noise.
        const { task_id, update } = ev.data;
        const existing = this.state.sessionUpdates[task_id] ?? [];
        const stamped = this.stampSessionUpdate(task_id, update);
        this.setState({
          sessionUpdates: {
            ...this.state.sessionUpdates,
            [task_id]: appendCoalescedUpdate(existing, stamped),
          },
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
      case "portforward.log": {
        const key = `${ev.data.project}/${ev.data.name}`;
        const existing = this.state.portforwardLogs[key] ?? [];
        const trimmed = [...existing, ev.data.line].slice(-MAX_PORTFORWARD_LOGS);
        this.setState({ portforwardLogs: { ...this.state.portforwardLogs, [key]: trimmed } });
        break;
      }
      case "agents.setup_needed":
        this.setState({ pendingAgentSetup: ev.data.detected });
        break;
      case "agents.updated":
        this.setState({
          pendingAgentSetup: null,
          snapshot: { ...snap, agents: ev.data.agents },
        });
        break;
      case "accounts.updated":
        this.setState({ snapshot: { ...snap, accounts: ev.data.accounts } });
        break;
      // Screen snapshots consumed by TUI clients; desktop uses terminal.data.
      case "terminal.screen":
        break;
      case "terminal.spawned": {
        const info = ev.data;
        const exists = snap.terminals.some((t) => t.id === info.id);
        if (!exists) {
          this.setState({ snapshot: { ...snap, terminals: [...snap.terminals, info] } });
        }
        break;
      }
      case "terminal.data": {
        const bytes = base64ToBytes(ev.data.data_b64);
        if (bytes.length > 0) this.deliverTerminalData(ev.data.terminal_id, bytes);
        break;
      }
      case "terminal.exited": {
        const { terminal_id } = ev.data;
        this.clearTerminalBuffer(terminal_id);
        const remaining = snap.terminals.filter((t) => t.id !== terminal_id);
        if (remaining.length !== snap.terminals.length) {
          this.setState({ snapshot: { ...snap, terminals: remaining } });
        }
        break;
      }
      // ── Orchestration events: update parent task's orchestrationGraph ──
      case "orchestration.nodeDispatched":
      case "orchestration.nodeCompleted":
      case "orchestration.nodeFailed":
      case "orchestration.allComplete":
        // The parent task is updated via task.updated events from the daemon.
        // These events are consumed by the UI for real-time graph updates.
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

  // ── Agent accounts ──
  // Every mutation answers with the full list, so callers replace rather than
  // patch; the daemon also broadcasts `accounts.updated` for other clients.

  async listAccounts(): Promise<AccountInfo[]> {
    const result = (await this.request("accounts.list", {})) as { accounts?: AccountInfo[] };
    return result?.accounts ?? [];
  }

  // Method names are camelCase; their *params* are snake_case, matching the
  // Rust variant fields (`rename_all` on the Method enum renames variants, not
  // fields). A mismatch makes the daemon drop the frame with no reply.
  async importAccount(agentId: string, label: string): Promise<AccountInfo[]> {
    const result = (await this.request("accounts.import", { agent_id: agentId, label })) as {
      accounts?: AccountInfo[];
    };
    return result?.accounts ?? [];
  }

  async renameAccount(accountId: string, label: string): Promise<AccountInfo[]> {
    const result = (await this.request("accounts.rename", { account_id: accountId, label })) as {
      accounts?: AccountInfo[];
    };
    return result?.accounts ?? [];
  }

  async removeAccount(accountId: string): Promise<AccountInfo[]> {
    const result = (await this.request("accounts.remove", { account_id: accountId })) as {
      accounts?: AccountInfo[];
    };
    return result?.accounts ?? [];
  }

  async setActiveAccount(agentId: string, accountId: string): Promise<AccountInfo[]> {
    const result = (await this.request("accounts.setActive", {
      account_id: accountId,
      agent_id: agentId,
    })) as {
      accounts?: AccountInfo[];
    };
    return result?.accounts ?? [];
  }

  /** Install or update an agent's global package. Resolves with the command's
   *  success flag and captured output. */
  async installAgent(id: string): Promise<{ ok: boolean; command: string; output: string }> {
    const result = (await this.request("agents.install", { id })) as {
      ok: boolean;
      command: string;
      output: string;
    };
    return result;
  }

  /** Draft a commit message or PR description by running the chosen agent
   *  one-shot over the task's diff. Resolves with the generated text. */
  async generateText(
    taskId: string,
    agentId: string,
    kind: "commit_message" | "pr_description" | "task_title",
    model?: string,
  ): Promise<string> {
    const result = (await this.request("text.generate", {
      agent_id: agentId,
      kind,
      model,
      task_id: taskId,
    })) as { text: string };
    return result.text;
  }

  /** Update a task's title. */
  async setTaskTitle(taskId: string, title: string) {
    await this.request("task.setTitle", { task_id: taskId, title });
  }

  async deleteTask(taskId: string) {
    await this.request("task.delete", { task_id: taskId });
  }

  async archiveTask(taskId: string) {
    await this.request("task.archive", { task_id: taskId });
  }

  async stopRuntime() {
    await this.request("runtime.stopAll", {});
  }

  async fetchServiceLogs(
    project: string,
    service: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<string[]> {
    const result = await this.request("service.logs", {
      after: options.after ?? 0,
      limit: options.limit ?? 300,
      project,
      service,
    });
    const payload = result as { lines?: unknown };
    const rawLines = Array.isArray(result)
      ? result
      : Array.isArray(payload?.lines)
        ? payload.lines
        : [];
    const lines = rawLines.map(String);
    const key = `${project}/${service}`;
    this.setState({
      serviceLogs: {
        ...this.state.serviceLogs,
        [key]: lines.slice(-MAX_SERVICE_LOGS),
      },
    });
    return lines;
  }

  async fetchPortForwardLogs(
    project: string,
    name: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<string[]> {
    const result = await this.request("portforward.logs", {
      after: options.after ?? 0,
      limit: options.limit ?? 300,
      project,
      name,
    });
    const payload = result as { lines?: unknown };
    const rawLines = Array.isArray(result)
      ? result
      : Array.isArray(payload?.lines)
        ? payload.lines
        : [];
    const lines = rawLines.map(String);
    const key = `${project}/${name}`;
    this.setState({
      portforwardLogs: {
        ...this.state.portforwardLogs,
        [key]: lines.slice(-MAX_PORTFORWARD_LOGS),
      },
    });
    return lines;
  }

  /** Remove a project registration, optionally authorizing resource teardown. */
  async removeProject(name: string, stopResources = false): Promise<void> {
    await this.request("project.remove", { name, stop_resources: stopResources });
  }

  /** List resumable claude/codex sessions on disk for a project's cwd. */
  async listSessions(project: string): Promise<ExternalSession[]> {
    const result = await this.request("sessions.list", { project });
    const sessions = (result as { sessions?: ExternalSession[] })?.sessions;
    return Array.isArray(sessions) ? sessions : [];
  }

  /** Resume an external session as a new task; returns the new task id. */
  async resumeTask(
    project: string,
    agent: string,
    sessionId: string,
    title: string,
  ): Promise<string> {
    const result = await this.request("task.resume", {
      agent,
      project,
      session_id: sessionId,
      title,
    });
    return (result as { taskId?: string })?.taskId ?? "";
  }

  /** Start an orchestration: planner → workers → reviewers pipeline. */
  async orchestrateStart(
    project: string,
    goal: string,
  ): Promise<{ graphId: string; taskId: string }> {
    const result = await this.request("orchestrate.start", { goal, project });
    const r = result as { graphId?: string; taskId?: string };
    return { graphId: r.graphId ?? "", taskId: r.taskId ?? "" };
  }

  /** List active orchestration graphs. */
  async orchestrateList(): Promise<unknown[]> {
    const result = await this.request("orchestrate.list", {});
    const graphs = (result as { graphs?: unknown[] })?.graphs;
    return Array.isArray(graphs) ? graphs : [];
  }

  /** Get the orchestrator configuration. */
  async orchestrateGetConfig(): Promise<import("./protocol").OrchestratorConfig> {
    const result = await this.request("orchestrate.getConfig", {});
    return result as import("./protocol").OrchestratorConfig;
  }

  /** Save the orchestrator configuration. */
  async orchestrateSaveConfig(config: import("./protocol").OrchestratorConfig): Promise<boolean> {
    const result = await this.request("orchestrate.saveConfig", { config });
    return (result as { ok?: boolean })?.ok ?? false;
  }

  // ── Workflow RPCs ──

  /** Workflows selectable for a project: its own files plus built-ins. */
  async workflowList(project: string): Promise<import("./protocol").WorkflowMeta[]> {
    const result = await this.request("workflow.list", { project });
    const workflows = (result as { workflows?: import("./protocol").WorkflowMeta[] })?.workflows;
    return Array.isArray(workflows) ? workflows : [];
  }

  /** Copy a built-in workflow into the project so it can be customized. */
  async workflowEject(project: string, id: string): Promise<string> {
    const result = await this.request("workflow.eject", { id, project });
    return (result as { path?: string })?.path ?? "";
  }

  /** Soft-pause a pipeline: the running stage finishes, the next won't start. */
  async workflowPause(task: string): Promise<void> {
    await this.request("workflow.pause", { task });
  }

  /** Resume a paused pipeline; `note` reaches the next stage as guidance. */
  async workflowResume(task: string, note?: string): Promise<void> {
    await this.request("workflow.resume", { note, task });
  }

  /** Answer a stage's pending question. */
  async workflowReply(task: string, message: string): Promise<void> {
    await this.request("workflow.reply", { message, task });
  }

  /** Decide what an out-of-rounds pipeline does next. */
  async workflowDecide(
    task: string,
    decision: import("./protocol").WorkflowDecision,
    opts?: { rounds?: number; note?: string },
  ): Promise<void> {
    await this.request("workflow.decide", {
      decision,
      note: opts?.note,
      rounds: opts?.rounds,
      task,
    });
  }

  // ── Terminal PTY RPCs ──

  async spawnTerminal(project: string, cols: number, rows: number): Promise<string> {
    const result = await this.request("terminal.spawn", {
      project,
      command: 'exec "${SHELL:-/bin/sh}" -l',
      cols,
      rows,
    });
    return (result as { terminalId?: string })?.terminalId ?? "";
  }

  sendTerminalInput(terminalId: string, data: Uint8Array) {
    this.request("terminal.input", {
      terminal_id: terminalId,
      data_b64: bytesToBase64(data),
    }).catch(() => {});
  }

  resizeTerminal(terminalId: string, cols: number, rows: number) {
    this.request("terminal.resize", {
      terminal_id: terminalId,
      cols,
      rows,
    }).catch(() => {});
  }

  async killTerminal(terminalId: string): Promise<void> {
    await this.request("terminal.kill", { terminal_id: terminalId });
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
  return {
    owner: "external",
    pid: 0,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    token: "",
    url: "ws://127.0.0.1:61814",
    version: "dev",
  };
}

async function desktopVersion(): Promise<string> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return "dev";
  }
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("does not match") ||
    (message.includes("daemon protocol") && message.includes("incompatible"))
  ) {
    if (message.toLowerCase().includes("stop the running daemon")) {
      return message;
    }
    return `${message}. Stop the running daemon and relaunch Warpforge.`;
  }
  return message || "Could not connect to the daemon. Warpforge will keep retrying.";
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(data: Uint8Array): string {
  if (data.length === 0) return "";
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

export const daemon = new DaemonClient();
