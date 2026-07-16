import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updater } from "@/lib/updater";

interface UpdateControlProps {
  daemonConnected: boolean;
}

export default function UpdateControl({ daemonConnected }: UpdateControlProps) {
  const state = useSyncExternalStore(updater.subscribe, updater.getState);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void updater.initialize();
  }, []);

  useEffect(() => {
    if (!daemonConnected || state.status !== "idle") return;
    const timeout = window.setTimeout(() => void updater.check(), 3_000);
    return () => window.clearTimeout(timeout);
  }, [daemonConnected, state.status]);

  if (state.status === "unsupported") return null;

  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const updateReady = state.status === "ready" || state.status === "installing";
  const hasUpdate = ["available", "downloading", "ready", "installing"].includes(state.status);

  return (
    <>
      <Button
        aria-label="App updates"
        className="relative size-7"
        onClick={() => setOpen(true)}
        size="icon"
        title="App updates"
        type="button"
        variant="ghost"
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
        {hasUpdate && (
          <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Warpforge updates</DialogTitle>
            <DialogDescription>
              You are running version {state.currentVersion}. Updates include both the desktop app
              and its matching daemon.
            </DialogDescription>
          </DialogHeader>

          {state.status === "upToDate" && <p className="text-sm">Warpforge is up to date.</p>}
          {hasUpdate && (
            <div className="space-y-3 text-sm">
              <p className="font-medium">Version {state.nextVersion} is available.</p>
              {state.notes && (
                <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/60 p-3 text-muted-foreground">
                  {state.notes}
                </div>
              )}
              {state.status === "downloading" && (
                <p className="text-muted-foreground">
                  Downloading
                  {state.progress === undefined ? "…" : ` ${Math.round(state.progress)}%`}
                </p>
              )}
              {updateReady && (
                <p className="text-muted-foreground">
                  Ready to install. Warpforge will only restart after the daemon confirms no agent
                  task or runtime transition would be interrupted.
                </p>
              )}
            </div>
          )}
          {state.error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {state.error}
            </p>
          )}

          <DialogFooter>
            {(state.status === "idle" ||
              state.status === "upToDate" ||
              state.status === "error") && (
              <Button
                disabled={busy || !daemonConnected}
                onClick={() => void updater.check()}
                variant="outline"
              >
                <RefreshCw /> Check for updates
              </Button>
            )}
            {state.status === "available" && (
              <Button onClick={() => void updater.download()}>
                <Download /> Download update
              </Button>
            )}
            {state.status === "ready" && (
              <Button onClick={() => void updater.installAndRestart()}>Restart and update</Button>
            )}
            {state.status === "installing" && <Button disabled>Preparing safe restart…</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
