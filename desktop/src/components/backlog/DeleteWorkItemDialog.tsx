import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { WorkItem } from "./types";

/**
 * Confirmation for dropping a work item, in the shape the rest of the app
 * confirms destructive work (`RemoveProjectDialog`, `FileSystemActionDialog`):
 * a named title, what will happen, then Cancel next to a destructive button.
 *
 * It stays open when the delete fails, so a failure is not a dialog that
 * vanishes and a row that is somehow still there.
 */
export function DeleteWorkItemDialog({
  item,
  onCancel,
  onConfirm,
}: {
  /** The item to delete; `null` keeps the dialog closed. */
  item: WorkItem | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (error) {
      toast.error("Could not delete the work item", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this item?</DialogTitle>
          <DialogDescription>
            “{item?.title}” will be removed from the backlog. This cannot be undone.
            {item?.taskId ? " The task it started keeps running." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void submit()}>
            {busy ? "Deleting…" : "Delete item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
