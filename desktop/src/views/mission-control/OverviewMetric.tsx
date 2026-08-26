import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function OverviewMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <Card
      className={cn(
        "min-w-0 rounded-md border-border/70 bg-card/35 px-3 py-2.5 shadow-none",
        tone === "warn" && "border-warn/40 bg-warn/[0.06]",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("tnum text-xl font-semibold", tone === "warn" && "text-warn")}>
          {value}
        </span>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground/80">{detail}</p>
    </Card>
  );
}

export { OverviewMetric };
