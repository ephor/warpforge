import type { Update } from "@tauri-apps/plugin-updater";

import { daemon } from "@/daemon";

export type UpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdaterState {
  status: UpdateStatus;
  currentVersion: string;
  nextVersion?: string;
  notes?: string;
  progress?: number;
  error?: string;
}

type Listener = () => void;

export class DesktopUpdater {
  private listeners = new Set<Listener>();
  private update: Update | null = null;
  private initialized = false;
  private state: UpdaterState = {
    currentVersion: "dev",
    status: "idle",
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private setState(patch: Partial<UpdaterState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!("__TAURI_INTERNALS__" in window)) {
      this.setState({ status: "unsupported" });
      return;
    }
    const { getVersion } = await import("@tauri-apps/api/app");
    this.setState({ currentVersion: await getVersion() });
  }

  async check() {
    await this.initialize();
    if (this.state.status === "unsupported") return this.state;
    this.setState({ error: undefined, progress: undefined, status: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      this.update = await check();
      if (!this.update) {
        this.setState({ nextVersion: undefined, notes: undefined, status: "upToDate" });
      } else {
        this.setState({
          nextVersion: this.update.version,
          notes: this.update.body ?? undefined,
          status: "available",
        });
      }
    } catch (error) {
      this.setState({ error: messageOf(error), status: "error" });
    }
    return this.state;
  }

  async download() {
    if (!this.update) return;
    let downloaded = 0;
    let total: number | undefined;
    this.setState({ error: undefined, progress: 0, status: "downloading" });
    try {
      await this.update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        this.setState({ progress: total ? Math.min(100, (downloaded / total) * 100) : undefined });
      });
      this.setState({ progress: 100, status: "ready" });
    } catch (error) {
      this.setState({ error: messageOf(error), status: "error" });
    }
  }

  async installAndRestart() {
    if (!this.update || this.state.status !== "ready") return;
    this.setState({ error: undefined, status: "installing" });
    let handoffAccepted = false;
    try {
      const handoff = await daemon.prepareUpdateHandoff();
      if (!handoff.ready) {
        this.setState({
          error: `Finish active work before updating: ${handoff.blockers.join(", ")}`,
          status: "ready",
        });
        return;
      }
      handoffAccepted = true;
      await daemon.waitForDisconnect();
      await this.update.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      if (handoffAccepted) {
        // The owned daemon is already gone. Relaunch even when installation
        // fails so setup can restore the current bundled daemon and the app
        // never remains connected to a dead runtime.
        try {
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
          return;
        } catch (relaunchError) {
          this.setState({
            error: `${messageOf(error)}; Warpforge could not relaunch: ${messageOf(relaunchError)}`,
            status: "error",
          });
          return;
        }
      }
      daemon.resumeAfterFailedUpdate();
      // The downloaded and verified update is still reusable when handoff was
      // refused (for example because an external daemon is running).
      this.setState({ error: messageOf(error), status: "ready" });
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const updater = new DesktopUpdater();
