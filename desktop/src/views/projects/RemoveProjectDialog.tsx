import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ProjectLiveCounts {
  services: number;
  portforwards: number;
  terminals: number;
}

interface Props {
  project: string | null;
  liveCounts: ProjectLiveCounts;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function RemoveProjectDialog({ project, liveCounts, onCancel, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLiveResources = liveCounts.services + liveCounts.portforwards + liveCounts.terminals > 0;
  const actorRejectedRemoval =
    error?.startsWith("conflict:") === true || error?.startsWith("internal:") === true;

  useEffect(() => {
    setSubmitting(false);
    setError(null);
  }, [project]);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(event) => {
          if (submitting) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (submitting) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Remove {project}?</DialogTitle>
          <DialogDescription>
            This removes the project registration from Warpforge. It does not delete the project
            folder or files. Any live resources for this project will be stopped.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-10">
          {hasLiveResources && (
            <div className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2">
              <p className="text-xs font-medium text-foreground">Live resources to stop</p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {liveCounts.services > 0 && (
                  <li>{countLabel(liveCounts.services, "running or starting service")}</li>
                )}
                {liveCounts.portforwards > 0 && (
                  <li>{countLabel(liveCounts.portforwards, "active or starting port-forward")}</li>
                )}
                {liveCounts.terminals > 0 && (
                  <li>{countLabel(liveCounts.terminals, "live terminal")}</li>
                )}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {actorRejectedRemoval
                ? `Removal failed: ${error}. The project remains registered, though some resources may already have stopped. Its terminal workspace and Runtime visibility were kept. Retry or cancel.`
                : `Removal status is uncertain: ${error}. The local terminal workspace and Runtime visibility were kept. Refresh daemon state before retrying.`}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={submitting} onClick={() => void handleConfirm()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {hasLiveResources ? "Stop resources & remove" : "Remove project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
