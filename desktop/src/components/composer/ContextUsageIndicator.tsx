import { memo } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { compactTokenCount, type ContextUsage } from "../../lib/sessionUsage";

export const ContextUsageIndicator = memo(function ContextUsageIndicator({
  usage,
}: {
  usage: ContextUsage;
}) {
  const used = Math.max(0, usage.used);
  const size = Math.max(1, usage.size);
  const remaining = Math.max(0, size - used);
  const percentage = Math.min(100, Math.round((used / size) * 100));
  const tone =
    percentage >= 90
      ? "text-destructive"
      : percentage >= 75
        ? "text-warn"
        : "text-muted-foreground";
  const progressTone =
    percentage >= 90 ? "bg-destructive" : percentage >= 75 ? "bg-warn" : "bg-primary";
  const cost = usage.cost
    ? ` · ${usage.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${usage.cost.currency}`
    : "";
  const detail = `${compactTokenCount(used)} used · ${compactTokenCount(remaining)} remaining · ${compactTokenCount(size)} total${cost}`;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Context window: ${detail}`}
          title="Context window"
          className={cn(
            "flex size-6 items-center justify-center rounded-md outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
            tone,
          )}
        >
          <span
            aria-hidden="true"
            className="relative size-4 rounded-full"
            style={{
              background: `conic-gradient(currentColor ${percentage * 3.6}deg, hsl(var(--secondary)) 0deg)`,
            }}
          >
            <span className="bg-deep-surface absolute inset-[3px] rounded-full" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 space-y-3 rounded-lg p-4"
      >
        <div className="tnum flex items-center justify-between gap-4 text-sm">
          <span className="font-semibold text-foreground">Context Window</span>
          <span className={cn("shrink-0", tone)}>
            {percentage}% · {compactTokenCount(used)}/{compactTokenCount(size)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full transition-[width]", progressTone)}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The agent can compact its context automatically when needed.
        </p>
        {usage.cost && (
          <p className="tnum border-t pt-3 text-xs text-muted-foreground">
            Session cost ·{" "}
            {usage.cost.amount.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            {usage.cost.currency}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
