import { Button } from "@/components/ui/button";

/** Shared building blocks for the Settings pages. */

export function hsl(triplet: string): string {
  return `hsl(${triplet})`;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
        <span className="mr-2 inline-block h-px w-3 bg-border" aria-hidden />
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">{children}</div>
    </section>
  );
}

export function SettingRow({
  title,
  description,
  control,
  resetAction,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
  resetAction?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-h-5 items-center gap-1.5">
          <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
          {resetAction}
        </div>
        <p className="text-xs text-muted-foreground/80">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

export function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 w-7 p-0 text-xs"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      >
        −
      </Button>
      <span className="w-10 text-center text-sm tabular-nums">{value}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 w-7 p-0 text-xs"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      >
        +
      </Button>
    </div>
  );
}

/** A toggle switch styled as a settings row control. */
export function Toggle({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="relative inline-flex cursor-pointer items-center">
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-foreground/80 after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:after:translate-x-4" />
    </label>
  );
}
