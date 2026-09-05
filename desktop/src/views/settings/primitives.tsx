import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Shared building blocks for the Settings pages. */

export function hsl(triplet: string): string {
  return `hsl(${triplet})`;
}

/**
 * A titled group of settings, on a card.
 *
 * Every section on every page is this card — one surface, one border, and the
 * rows inside are separated by dividers rather than each carrying a box of its
 * own. Content that is a form or a grid of toggles rather than a list of rows
 * passes `padded`.
 */
export function Section({
  title,
  padded,
  children,
}: {
  title: string;
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
        <span className="mr-2 inline-block h-px w-3 bg-border" aria-hidden />
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
        {padded ? <div className="p-4">{children}</div> : children}
      </div>
    </section>
  );
}

/**
 * One changeable setting: what it is on the left, the control on the right.
 *
 * `description` is a single line — the shortest sentence that says what the
 * control does. Everything longer (install steps, where the file lives, what
 * the daemon does about it) belongs in `hint`, behind the info icon, because a
 * three-line paragraph per row turns a settings list into a document nobody
 * scans. The control column has a floor width so every control on a page
 * shares one right edge instead of ragging by label length.
 */
export function SettingRow({
  title,
  description,
  hint,
  control,
  resetAction,
}: {
  title: string;
  description: string;
  hint?: string;
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
        <p className="flex items-center gap-1 text-xs text-muted-foreground/80">
          {description}
          {hint && (
            <span
              role="img"
              aria-label={hint}
              title={hint}
              className="inline-flex shrink-0 cursor-help text-muted-foreground/60"
            >
              <Info className="size-3" aria-hidden />
            </span>
          )}
        </p>
      </div>
      <div className="flex min-w-52 shrink-0 items-center justify-end gap-2">{control}</div>
    </div>
  );
}

/**
 * Facts at the foot of a section: counts, detected state, values the daemon
 * owns and this screen cannot change.
 *
 * They used to be setting rows with a `<span>` where the control belongs,
 * which invites a click that does nothing. A strip states them as what they
 * are — readings, not switches.
 */
export function StatusStrip({
  items,
}: {
  items: { label: string; value: React.ReactNode; title?: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border/60 px-4 py-2.5">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 text-[11px]" title={item.title}>
          <span className="text-muted-foreground/70">{item.label}</span>
          <span className="tabular-nums text-foreground/80">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

/** A sentence at the foot of a section, tying its rows together. */
export function SectionNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground/70">
      {children}
    </p>
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
