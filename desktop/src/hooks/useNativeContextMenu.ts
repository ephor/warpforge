import { useEffect, useRef } from "react";

/**
 * Native context-menu framing info: the frontend's first-party naming for the
 * Rust `context_menu` module. Keeping this boundary here means components just
 * declare items and handlers without reaching into `@tauri-apps/api`.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export type ContextMenuItemOrSeparator =
  | { type: "item"; id: string; label: string; disabled?: boolean }
  | { type: "separator" };

export interface ShowContextMenuRequest {
  requestId: string;
  items: ContextMenuItemOrSeparator[];
}

let invokeFn:
  | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
  | undefined;

async function ensureTauri() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (invokeFn) return;
  const mod = await import("@tauri-apps/api/core");
  invokeFn = mod.invoke;
}

/** Open a native OS context menu at the cursor. No-op outside Tauri. */
export async function showContextMenu(request: ShowContextMenuRequest): Promise<void> {
  await ensureTauri();
  if (!invokeFn) return;
  await invokeFn("show_context_menu", { request });
}

/**
 * Wire a native context-menu request to item handlers. Pass a stable
 * `requestId` per component; when the OS menu is clicked, only the handler
 * matching `itemId` fires, and only components sharing that `requestId` react.
 */
export function useNativeContextMenu(
  requestId: string,
  handlers: Map<string, () => void>,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        if (disposed) return;
        unlisten = await listen<{ requestId: string; itemId: string }>(
          "context-menu:clicked",
          (event) => {
            if (event.payload.requestId !== requestId) return;
            handlersRef.current.get(event.payload.itemId)?.();
          },
        );
        if (disposed) {
          unlisten();
          unlisten = undefined;
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [requestId]);
}