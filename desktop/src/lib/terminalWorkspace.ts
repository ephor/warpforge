import { daemon, type ConnectionState } from "../daemon";
import type { DaemonEvent } from "../protocol";
import { TerminalController, type TerminalLifecycle } from "./terminalController";

export interface TerminalEntry {
  terminalId: string;
  project: string;
  command: string;
  startedAt: number;
  label: string;
  controller: TerminalController;
}

type WorkspaceListener = () => void;

export class TerminalWorkspace {
  private entries = new Map<string, TerminalEntry>();
  private insertionOrder: string[] = [];
  private activeId: string | null = null;
  private listeners = new Set<WorkspaceListener>();
  private unsubEvents: (() => void) | null = null;
  private unsubStore: (() => void) | null = null;
  private disposed = false;
  private nextLabel = 1;
  private cachedTerminals: TerminalEntry[] = [];
  private lastConnectionState: ConnectionState | null = null;
  private lastTerminalSignature: string | null = null;
  private spawnError: string | null = null;
  private exitedTombstones = new Set<string>();
  private closeIntentTerminals = new Set<string>();

  constructor(private readonly project: string) {
    this.unsubEvents = daemon.subscribeEvents((ev) => this.handleDaemonEvent(ev));
    this.unsubStore = daemon.subscribe(() => this.handleStoreUpdate());
    this.reconcileFromSnapshot();
  }

  subscribe = (listener: WorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private rebuildTerminalsCache() {
    this.cachedTerminals = this.insertionOrder
      .filter((id) => this.entries.has(id))
      .map((id) => this.entries.get(id)!);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  getTerminals(): TerminalEntry[] {
    return this.cachedTerminals;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getActive(): TerminalEntry | null {
    if (!this.activeId) return null;
    return this.entries.get(this.activeId) ?? null;
  }

  getController(terminalId: string): TerminalController | null {
    return this.entries.get(terminalId)?.controller ?? null;
  }

  getSpawnError(): string | null {
    return this.spawnError;
  }

  async spawn(): Promise<string | null> {
    this.spawnError = null;
    try {
      const terminalId = await daemon.spawnTerminal(this.project, 80, 24);
      if (!terminalId) {
        this.spawnError = "Daemon returned no terminal id.";
        this.notify();
        return null;
      }
      this.activeId = terminalId;
      this.notify();
      return terminalId;
    } catch (err) {
      this.spawnError = err instanceof Error ? err.message : String(err);
      this.notify();
      return null;
    }
  }

  async kill(terminalId: string): Promise<void> {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    const lc = entry.controller.getLifecycle();
    if (lc === "exited") return;
    if (lc === "closing") return;
    entry.controller.markClosing();
    this.notify();
    try {
      await daemon.killTerminal(terminalId);
    } catch (err) {
      entry.controller.markError(err instanceof Error ? err.message : String(err));
      this.notify();
    }
  }

  remove(terminalId: string) {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.controller.dispose();
    this.entries.delete(terminalId);
    this.insertionOrder = this.insertionOrder.filter((id) => id !== terminalId);
    this.exitedTombstones.add(terminalId);
    this.closeIntentTerminals.delete(terminalId);
    this.rebuildTerminalsCache();
    if (this.activeId === terminalId) {
      this.activeId = this.resolveActiveId();
    }
    this.notify();
  }

  close(terminalId: string) {
    this.closeIntentTerminals.add(terminalId);
    void this.kill(terminalId);
  }

  async restart(terminalId: string): Promise<string | null> {
    this.remove(terminalId);
    return this.spawn();
  }

  setActive(terminalId: string | null) {
    if (this.activeId === terminalId) return;
    this.activeId = terminalId;
    this.notify();
  }

  private resolveActiveId(): string | null {
    if (this.activeId && this.entries.has(this.activeId)) {
      const lc = this.entries.get(this.activeId)!.controller.getLifecycle();
      if (lc !== "exited") return this.activeId;
    }
    for (const id of this.insertionOrder) {
      const entry = this.entries.get(id);
      if (entry && entry.controller.getLifecycle() !== "exited") return id;
    }
    return this.insertionOrder.length > 0 ? this.insertionOrder[0] : null;
  }

  private allocateLabel(): string {
    const label = `Terminal ${this.nextLabel}`;
    this.nextLabel++;
    return label;
  }

  private attachTerminal(info: { id: string; project: string; command: string; startedAt: number }) {
    if (this.entries.has(info.id)) return;
    if (this.exitedTombstones.has(info.id)) return;
    const controller = new TerminalController({ terminalId: info.id, project: info.project });
    controller.subscribeLifecycle(() => this.notify());
    const connState = daemon.getState().connection;
    if (connState === "connected") {
      controller.markActive();
    } else if (connState === "disconnected") {
      controller.markDisconnected();
    }
    const label = this.allocateLabel();
    const entry: TerminalEntry = {
      terminalId: info.id,
      project: info.project,
      command: info.command,
      startedAt: info.startedAt,
      label,
      controller,
    };
    this.entries.set(info.id, entry);
    this.insertionOrder.push(info.id);
    this.rebuildTerminalsCache();
  }

  private getTerminalSignature(): string {
    const snap = daemon.getState().snapshot;
    const projectTerminals = snap.terminals.filter((t) => t.project === this.project);
    return projectTerminals.map((t) => t.id).sort().join(",");
  }

  private reconcileFromSnapshot() {
    if (this.disposed) return;
    const snap = daemon.getState().snapshot;
    const projectTerminals = snap.terminals.filter((t) => t.project === this.project);

    for (const info of projectTerminals) {
      if (!this.entries.has(info.id) && !this.exitedTombstones.has(info.id)) {
        this.attachTerminal(info);
      }
    }

    this.rebuildTerminalsCache();
    this.activeId = this.resolveActiveId();
  }

  private handleStoreUpdate() {
    if (this.disposed) return;
    const state = daemon.getState();
    const connState = state.connection;
    const sig = this.getTerminalSignature();

    let changed = false;

    if (connState !== this.lastConnectionState) {
      this.lastConnectionState = connState;
      for (const entry of this.entries.values()) {
        const lc = entry.controller.getLifecycle();
        if (lc === "exited" || lc === "closing" || lc === "error") continue;
        if (connState === "disconnected") {
          entry.controller.markDisconnected();
        } else if (connState === "connected") {
          entry.controller.markActive();
        }
      }
      changed = true;
    }

    if (sig !== this.lastTerminalSignature) {
      this.lastTerminalSignature = sig;
      this.reconcileFromSnapshot();
      changed = true;
    }

    if (changed) this.notify();
  }

  private handleDaemonEvent(ev: DaemonEvent) {
    if (this.disposed) return;
    if (ev.event === "project.removed" && ev.data.name === this.project) {
      disposeTerminalWorkspace(this.project);
      return;
    }
    if (ev.event === "terminal.spawned") {
      const info = ev.data;
      if (info.project !== this.project) return;
      if (!this.entries.has(info.id) && !this.exitedTombstones.has(info.id)) {
        this.attachTerminal(info);
        if (!this.activeId) this.activeId = info.id;
        this.rebuildTerminalsCache();
        this.notify();
      }
      return;
    }
    if (ev.event === "terminal.exited") {
      const { terminal_id } = ev.data;
      const entry = this.entries.get(terminal_id);
      if (entry) {
        entry.controller.markExited();
        this.exitedTombstones.add(terminal_id);
        if (this.closeIntentTerminals.has(terminal_id)) {
          this.closeIntentTerminals.delete(terminal_id);
          this.remove(terminal_id);
        } else {
          if (this.activeId === terminal_id) {
            this.activeId = this.resolveActiveId();
          }
          this.notify();
        }
      }
      return;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.unsubEvents) {
      this.unsubEvents();
      this.unsubEvents = null;
    }
    if (this.unsubStore) {
      this.unsubStore();
      this.unsubStore = null;
    }
    for (const entry of this.entries.values()) {
      entry.controller.dispose();
    }
    this.entries.clear();
    this.insertionOrder = [];
    this.cachedTerminals = [];
    this.activeId = null;
    this.listeners.clear();
    this.exitedTombstones.clear();
    this.closeIntentTerminals.clear();
  }
}

const workspaces = new Map<string, TerminalWorkspace>();

export function getTerminalWorkspace(project: string): TerminalWorkspace {
  let ws = workspaces.get(project);
  if (!ws) {
    ws = new TerminalWorkspace(project);
    workspaces.set(project, ws);
  }
  return ws;
}

export function disposeTerminalWorkspace(project: string) {
  const ws = workspaces.get(project);
  if (ws) {
    ws.dispose();
    workspaces.delete(project);
  }
}

export type { TerminalLifecycle };
