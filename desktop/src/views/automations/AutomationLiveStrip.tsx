import { CalendarClock } from "lucide-react";

import { countdown } from "@/lib/automationSchedule";
import { cn } from "@/lib/utils";
import type { Automation, AutomationRun } from "@/protocol";

import { isSkipped, RUN_STATUS_META, runSummary } from "./labels";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Props {
  automations: Automation[];
  runsById: Record<string, AutomationRun[]>;
  now: number;
  onOpenRun: (run: AutomationRun) => void;
}

function nextUp(automations: Automation[]): Automation | null {
  const scheduled = automations.filter(
    (automation) => automation.enabled && (automation.nextRunAt ?? 0) > 0,
  );
  if (scheduled.length === 0) return null;
  return scheduled.reduce((soonest, candidate) =>
    (candidate.nextRunAt ?? 0) < (soonest.nextRunAt ?? 0) ? candidate : soonest,
  );
}

/**
 * The overnight digest: what fires next, and every run of the last 24 hours as
 * a marker you can click straight into. Deliberately not generated prose — the
 * markers *are* the summary, and a sentence would need reading to trust.
 */
export function AutomationLiveStrip({ automations, runsById, now, onOpenRun }: Props) {
  const next = nextUp(automations);
  const nextRunMs = (next?.nextRunAt ?? 0) * 1000;
  const windowStart = now - DAY_MS;
  const recent = Object.values(runsById)
    .flat()
    .filter((run) => run.startedAt * 1000 >= windowStart)
    .sort((a, b) => a.startedAt - b.startedAt);
  const nameOf = (run: AutomationRun) =>
    automations.find((automation) => automation.id === run.automationId)?.name ?? "automation";
  const completed = recent.filter((run) => run.status === "completed").length;
  const failed = recent.filter((run) => run.status === "failed").length;
  const skipped = recent.filter((run) => isSkipped(run.status)).length;

  return (
    <section
      data-testid="automation-live-strip"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card px-4 py-3 lg:flex-row lg:items-center lg:gap-6"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-3 lg:w-[22rem]">
        <CalendarClock
          aria-hidden
          className={cn("size-4 shrink-0", next ? "text-primary" : "text-muted-foreground/50")}
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Next run
          </p>
          {next ? (
            <p className="truncate text-sm">
              <span className="font-medium text-foreground">{next.name}</span>
              <span className="text-muted-foreground"> — {countdown(nextRunMs, now)}</span>
            </p>
          ) : (
            <p className="truncate text-sm text-muted-foreground">
              {automations.length === 0 ? "No automations yet" : "Nothing scheduled — all paused"}
            </p>
          )}
          {next && (
            <p className="truncate text-[11px] text-muted-foreground/80">
              {new Date(nextRunMs).toLocaleString()} · {next.project}
            </p>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Last 24 hours
          </p>
          <p className="tnum truncate text-[11px] text-muted-foreground">
            {recent.length === 0
              ? "no runs"
              : [
                  completed > 0 ? `${completed} completed` : null,
                  failed > 0 ? `${failed} failed` : null,
                  skipped > 0 ? `${skipped} skipped` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
        </div>
        <div className="relative mt-2 h-7">
          <div aria-hidden className="absolute inset-x-0 top-3.5 h-px bg-border" />
          {[0, 6, 12, 18].map((hour) => (
            <span
              key={hour}
              aria-hidden
              className="absolute top-2 h-3 w-px bg-border"
              style={{ left: `${(hour / 24) * 100}%` }}
            />
          ))}
          {recent.map((run) => {
            const position = ((run.startedAt * 1000 - windowStart) / DAY_MS) * 100;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onOpenRun(run)}
                title={`${nameOf(run)} · ${runSummary(run)}`}
                aria-label={`${nameOf(run)} run ${run.runNumber}, ${RUN_STATUS_META[run.status].label}`}
                className="absolute top-1.5 grid size-5 -translate-x-1/2 place-items-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ left: `${Math.min(99.5, Math.max(0.5, position))}%` }}
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    RUN_STATUS_META[run.status].dot,
                    run.status === "running" && "animate-pulse",
                  )}
                />
              </button>
            );
          })}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground/70">
          <span>24h ago</span>
          <span>now</span>
        </div>
      </div>
    </section>
  );
}
