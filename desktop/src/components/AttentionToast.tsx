import { BellRing, X } from "lucide-react";

import { Button } from "@/components/ui/button";

interface AttentionToastProps {
  identity: string;
  onDismiss: () => void;
  onOpen: () => void;
  summary: string;
  title: string;
}

export default function AttentionToast({
  identity,
  onDismiss,
  onOpen,
  summary,
  title,
}: AttentionToastProps) {
  return (
    <div className="relative w-[min(420px,calc(100vw-2rem))] max-w-full overflow-hidden rounded-xl border border-border bg-popover p-4 pr-11 text-popover-foreground shadow-2xl">
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-md border border-border bg-secondary text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden="true" />
      </button>

      <div className="flex min-w-0 gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-5">{title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={identity}>
            {identity}
          </p>
          <p className="mt-2 line-clamp-3 break-words text-sm leading-5 [overflow-wrap:anywhere]">
            {summary}
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={onOpen} className="mt-3">
            Open sessions
          </Button>
        </div>
      </div>
    </div>
  );
}
