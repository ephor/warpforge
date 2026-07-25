import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { daemon } from "../daemon";

export type TerminalLifecycle =
  | "starting"
  | "active"
  | "closing"
  | "exited"
  | "disconnected"
  | "error";

export interface TerminalControllerInit {
  terminalId: string;
  project: string;
}

const RESIZE_DEBOUNCE_MS = 80;

export class TerminalController {
  readonly terminalId: string;
  readonly project: string;
  readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  private unsubData: (() => void) | null = null;
  private inputDisposable: { dispose(): void } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private attachFrame: number | null = null;
  private lastCols = 0;
  private lastRows = 0;
  private opened = false;
  private lifecycle: TerminalLifecycle = "starting";
  private exited = false;
  private error: string | null = null;
  private lifecycleListeners = new Set<() => void>();

  constructor(init: TerminalControllerInit) {
    this.terminalId = init.terminalId;
    this.project = init.project;
    this.fitAddon = new FitAddon();
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      theme: {
        background: "#0b0d0f",
        foreground: "#d1d5db",
        cursor: "#d1d5db",
        selectionBackground: "#3b82f640",
        black: "#111315",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#d1d5db",
        brightBlack: "#4b5563",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#f3f4f6",
      },
    });
    this.term.loadAddon(this.fitAddon);
    this.unsubData = daemon.subscribeTerminalData(this.terminalId, (data) => {
      if (this.lifecycle === "starting" || this.lifecycle === "disconnected") {
        this.markActive();
      }
      this.term.write(data);
    });
  }

  getLifecycle(): TerminalLifecycle {
    return this.lifecycle;
  }

  getError(): string | null {
    return this.error;
  }

  subscribeLifecycle(listener: () => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  private setLifecycle(lc: TerminalLifecycle) {
    if (this.lifecycle === lc) return;
    this.lifecycle = lc;
    for (const fn of this.lifecycleListeners) fn();
  }

  markActive() {
    if (this.exited || this.lifecycle === "closing" || this.lifecycle === "error") return;
    this.setLifecycle("active");
  }

  markDisconnected() {
    if (this.exited || this.lifecycle === "closing" || this.lifecycle === "error") return;
    this.setLifecycle("disconnected");
  }

  markClosing() {
    if (this.exited) return;
    this.setLifecycle("closing");
  }

  markExited() {
    this.exited = true;
    this.setLifecycle("exited");
  }

  markError(message: string) {
    this.error = message;
    this.setLifecycle("error");
  }

  attach(element: HTMLElement, focus = false) {
    if (!this.opened) {
      this.opened = true;
      this.term.open(element);
      this.inputDisposable = this.term.onData((data) => {
        const bytes = new TextEncoder().encode(data);
        daemon.sendTerminalInput(this.terminalId, bytes);
      });
    } else {
      const terminalElement = this.term.element;
      if (terminalElement && terminalElement.parentElement !== element) {
        element.appendChild(terminalElement);
      }
    }
    this.scheduleAttachLayout(focus);
  }

  detach(element: HTMLElement) {
    if (this.term.element?.parentElement !== element || this.attachFrame === null) return;
    cancelAnimationFrame(this.attachFrame);
    this.attachFrame = null;
  }

  private scheduleAttachLayout(focus: boolean) {
    if (this.attachFrame !== null) cancelAnimationFrame(this.attachFrame);
    this.attachFrame = requestAnimationFrame(() => {
      this.attachFrame = null;
      this.fitAndResize();
      if (focus) this.focus();
    });
  }

  fit() {
    if (!this.opened) return;
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    this.maybeSendResize();
  }

  private fitAndResize() {
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    daemon.resizeTerminal(this.terminalId, cols, rows);
  }

  private maybeSendResize() {
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      daemon.resizeTerminal(this.terminalId, cols, rows);
    }, RESIZE_DEBOUNCE_MS);
  }

  focus() {
    if (this.opened) this.term.focus();
  }

  dispose() {
    if (this.attachFrame !== null) {
      cancelAnimationFrame(this.attachFrame);
      this.attachFrame = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.unsubData) {
      this.unsubData();
      this.unsubData = null;
    }
    if (this.inputDisposable) {
      this.inputDisposable.dispose();
      this.inputDisposable = null;
    }
    daemon.clearTerminalBuffer(this.terminalId);
    this.term.dispose();
    this.opened = false;
    this.lifecycleListeners.clear();
  }
}
