import { useEffect } from "react";

import { daemon } from "@/daemon";

export function useTauriClose() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let disposed = false;
    let allowClose = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) {
          return;
        }
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (allowClose) {
            return;
          }
          event.preventDefault();

          const activeServices = daemon
            .getState()
            .snapshot.services.filter(
              (service) => service.status === "running" || service.status === "starting",
            );

          if (activeServices.length > 0) {
            const preview = activeServices
              .slice(0, 4)
              .map((service) => `${service.project}/${service.name}`)
              .join(", ");
            const suffix =
              activeServices.length > 4 ? `, and ${activeServices.length - 4} more` : "";
            const confirmed = window.confirm(
              `You have ${activeServices.length} service${
                activeServices.length === 1 ? "" : "s"
              } still running:\n${preview}${suffix}\n\nStop them and quit Warpforge?`,
            );
            if (!confirmed) {
              return;
            }
          }

          try {
            await daemon.stopRuntime();
          } catch {}

          allowClose = true;
          await appWindow.close();
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
