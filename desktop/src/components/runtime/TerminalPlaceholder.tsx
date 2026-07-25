import { TerminalSquare } from "lucide-react";

export function TerminalPlaceholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/30">
        <TerminalSquare className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Interactive terminal</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Interactive terminal sessions will be available in a future release.
        </p>
      </div>
      <div className="mt-1 rounded-full border bg-muted/20 px-3 py-1 text-[10px] text-muted-foreground">
        Coming soon
      </div>
    </div>
  );
}
