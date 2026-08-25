import { DismissableLayer } from "radix-ui/internal";
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

/**
 * Ask before doing something that cannot be taken back.
 *
 * `window.confirm` is not an option in this app: the webview answers it without
 * ever drawing it, so the action went through with nobody asked. This is the
 * shape the app already confirms destructive work in (`RemoveProjectDialog`,
 * `FileSystemActionDialog`), kept in one place so every caller asks the same
 * way — and so no caller reaches for the native one again.
 *
 * The dialog owns the in-flight state: it stays open and reports the failure if
 * `onConfirm` rejects, because a destructive step that failed must not look
 * like one that worked. The caller closes it when the work is done.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  busyLabel = "Working…",
  destructive = true,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  /** Shown on the confirm button while `onConfirm` is in flight. */
  busyLabel?: string;
  /** False for a confirmation that only warns — a switch, not a deletion. */
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape and click-outside are a cancel — but not while the work they
        // would cancel is already on its way.
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        {/* A confirmation usually opens over another dialog, and its content is
            portaled out of that one's DOM — so answering it reads to the layer
            underneath as a click outside, which dismisses it. Cancelling then
            asked the same question again, forever. Registering the answer as a
            branch of the layer stack is how Radix says "this belongs to what is
            already open". `contents` keeps it out of the content grid. */}
        <DismissableLayer.Branch className="contents" data-layer-branch>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? busyLabel : confirmLabel}
            </Button>
          </DialogFooter>
        </DismissableLayer.Branch>
      </DialogContent>
    </Dialog>
  );
}
