import { useEffect, useRef, useState } from "react";

import { daemon } from "@/daemon";

/** How many service names the question names before it says "and N more". */
const NAMED_SERVICES = 4;

/**
 * Whether a quit is already under way, parked on `window` rather than in this
 * module or a closure.
 *
 * A hot reload re-evaluates the module and remounts the hook, but the listener
 * the previous generation registered with the window stays registered. Each
 * generation refusing the close on behalf of its own private flag is how a dev
 * session ends up with a window that cannot be closed at all: one generation
 * asks the window to close, every other generation refuses it. A flag they all
 * read survives the reload and lets a quit that has begun finish.
 */
const QUITTING = "__warpforgeQuitting";

function isQuitting(): boolean {
  return (window as unknown as Record<string, unknown>)[QUITTING] === true;
}

/**
 * A quit that is waiting on an answer, because services are still running.
 * The window has already refused to close; nothing happens until `confirm`.
 */
export interface PendingQuit {
  /** Service names to show, at most [`NAMED_SERVICES`] of them. */
  services: string[];
  /** How many more are running beyond the named ones. */
  more: number;
  confirm: () => Promise<void>;
  cancel: () => void;
}

/**
 * Hold the window open while services are running, and hand the question to
 * the app to ask.
 *
 * The question used to be `window.confirm`, which this webview answers without
 * ever drawing it — so quitting stopped every running service with nobody
 * asked. The state comes back out to be rendered as a real dialog.
 */
export function useTauriClose(): PendingQuit | null {
  const [pending, setPending] = useState<{ services: string[]; more: number } | null>(null);
  // The quit itself belongs to the listener's closure (it owns the window
  // handle and the flag that lets the second close through), so the dialog
  // reaches it through a ref rather than rebuilding it.
  const quitRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) {
          return;
        }
        const appWindow = getCurrentWindow();

        const quit = async () => {
          try {
            await daemon.stopRuntime();
          } catch {}
          (window as unknown as Record<string, unknown>)[QUITTING] = true;
          await appWindow.close();
        };
        quitRef.current = quit;

        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (isQuitting()) {
            return;
          }
          event.preventDefault();

          const activeServices = daemon
            .getState()
            .snapshot.services.filter(
              (service) => service.status === "running" || service.status === "starting",
            );

          if (activeServices.length === 0) {
            await quit();
            return;
          }
          setPending({
            services: activeServices
              .slice(0, NAMED_SERVICES)
              .map((service) => `${service.project}/${service.name}`),
            more: Math.max(0, activeServices.length - NAMED_SERVICES),
          });
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      quitRef.current = null;
      unlisten?.();
    };
  }, []);

  if (!pending) return null;
  return {
    services: pending.services,
    more: pending.more,
    // No `setPending(null)` on the way out: the window is closing, and a
    // dialog that clears itself first would flash the app back into view.
    confirm: async () => {
      await quitRef.current?.();
    },
    cancel: () => setPending(null),
  };
}
