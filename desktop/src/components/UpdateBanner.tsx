import { ArrowUpCircle, LoaderCircle } from "lucide-react";
import { useSyncExternalStore } from "react";

import { updater } from "@/lib/updater";
import { cn } from "@/lib/utils";

/**
 * Loud counterpart to the sidebar's update dot: a single header pill that says
 * an update exists and starts it on one click — no dialog in between. People
 * were missing the quiet indicator entirely, so this one carries the whole
 * flow (download → restart) and only shows up while there is something to do.
 * The dialog stays available for release notes and manual checks.
 */
export function UpdateBanner() {
  const state = useSyncExternalStore(updater.subscribe, updater.getState);

  const label =
    state.status === "available"
      ? `Update to ${state.nextVersion ?? "the latest version"}`
      : state.status === "downloading"
        ? `Downloading${state.progress === undefined ? "…" : ` ${Math.round(state.progress)}%`}`
        : state.status === "ready"
          ? "Restart to update"
          : state.status === "installing"
            ? "Preparing restart…"
            : // An update that failed mid-flight must not vanish silently —
              // that is exactly the case where the quiet dot loses people.
              state.status === "error" && state.nextVersion
              ? "Update failed — retry"
              : null;
  if (label === null) return null;

  const busy = state.status === "downloading" || state.status === "installing";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (state.status === "available") void updater.download();
        if (state.status === "ready") void updater.installAndRestart();
        if (state.status === "error") void updater.check();
      }}
      title={
        state.status === "available"
          ? "Download this update now"
          : state.status === "ready"
            ? "Restart Warpforge to finish updating"
            : undefined
      }
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
        state.status === "error"
          ? "bg-destructive text-destructive-foreground"
          : "bg-primary text-primary-foreground",
        "shadow-sm transition-opacity",
        busy ? "opacity-80" : "hover:opacity-90",
      )}
    >
      {busy ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <ArrowUpCircle className="size-3.5" />
      )}
      {label}
    </button>
  );
}
