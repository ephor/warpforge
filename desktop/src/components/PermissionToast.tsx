import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

interface PermissionToastProps {
  context: string;
  identity?: string;
  onApprove?: () => Promise<void>;
  onDismiss: () => void;
  onReview: () => void;
}

/** Bounded custom Sonner content; intentionally independent of rich-color toast styles. */
export default function PermissionToast({
  context,
  identity,
  onApprove,
  onDismiss,
  onReview,
}: PermissionToastProps) {
  const [approving, setApproving] = useState(false);

  const approve = async () => {
    if (!onApprove || approving) return;
    setApproving(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="relative w-[min(420px,calc(100vw-2rem))] max-w-full overflow-hidden rounded-xl border border-border bg-popover p-4 pr-11 text-popover-foreground shadow-2xl">
      <button
        type="button"
        aria-label="Dismiss permission notification"
        onClick={onDismiss}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-md border border-border bg-secondary text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>

      <div className="flex min-w-0 gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-5 text-popover-foreground">Permission needed</p>
          {identity && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={identity}>
              {identity}
            </p>
          )}
          <p className="mt-2 line-clamp-3 break-words text-sm leading-5 text-popover-foreground [overflow-wrap:anywhere]">
            {context}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {onApprove && (
              <Button
                type="button"
                size="sm"
                disabled={approving}
                onClick={() => void approve()}
                className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
              >
                {approving ? "Approving…" : "Approve"}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onReview}
              className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
            >
              Review
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
