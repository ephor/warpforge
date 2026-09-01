import { AlertCircle, CalendarClock } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  describeSchedule,
  nextOccurrences,
  runtimeTimezone,
  WEEKDAY_LABELS,
} from "@/lib/automationSchedule";
import { cn } from "@/lib/utils";
import type { AutomationPreset, ProjectInfo } from "@/protocol";

import { EnabledSwitch } from "./AutomationCard";
import { type AutomationForm, effectiveTrigger, type FormProblems } from "./form";

const PRESETS: { id: AutomationPreset; label: string }[] = [
  { id: "hourly", label: "Hourly" },
  { id: "every5", label: "Every 5 min" },
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Weekly" },
  { id: "custom", label: "Custom cron" },
];

interface Props {
  form: AutomationForm;
  patch: (change: Partial<AutomationForm>) => void;
  problems: FormProblems;
  projects: ProjectInfo[];
  now: number;
}

/** "Sat, 6 Sep, 09:00" in the automation's own zone — the preview has to be in
 *  the zone the schedule is written in, or 09:00 would read as a bug. */
function previewTime(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "short",
      timeZone: timezone || undefined,
      weekday: "short",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toLocaleString();
  }
}

export function ScheduleFields({ form, now, patch, problems, projects }: Props) {
  const trigger = effectiveTrigger(form);
  const upcoming = problems.cron ? [] : nextOccurrences(trigger, form.timezone, now, 3);
  const zone = form.timezone || runtimeTimezone();

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Schedule" className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={form.preset === preset.id}
            onClick={() => patch({ preset: preset.id })}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs transition-colors",
              form.preset === preset.id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {form.preset === "custom" ? (
        <div className="space-y-1">
          <Input
            aria-label="Cron expression"
            value={form.cron}
            spellCheck={false}
            onChange={(event) => patch({ cron: event.target.value })}
            placeholder="0 9 * * MON-FRI"
            className={cn("font-mono text-xs", problems.cron && "border-destructive/60")}
          />
          <p className="text-[11px] text-muted-foreground/80">
            minute hour day-of-month month day-of-week · day-of-week is 1–7 with 1 = Sunday, and
            names like <code>MON-FRI</code> work.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {form.preset === "weekly" && (
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Day
              <select
                value={form.weekday}
                onChange={(event) => patch({ weekday: Number(event.target.value) })}
                className="bg-deep-surface h-8 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {WEEKDAY_LABELS.map((label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.preset === "hourly" ? (
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Minute of the hour
              <select
                value={form.minute}
                onChange={(event) => patch({ minute: Number(event.target.value) })}
                className="bg-deep-surface h-8 w-24 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {Array.from({ length: 12 }, (_, index) => index * 5).map((minute) => (
                  <option key={minute} value={minute}>
                    :{String(minute).padStart(2, "0")}
                  </option>
                ))}
              </select>
            </label>
          ) : form.preset === "every5" ? null : (
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Time
              <Input
                type="time"
                value={`${String(form.hour).padStart(2, "0")}:${String(form.minute).padStart(2, "0")}`}
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(":");
                  patch({ hour: Number(hour ?? 9), minute: Number(minute ?? 0) });
                }}
                className="h-8 w-28 text-xs"
              />
            </label>
          )}
        </div>
      )}

      <div className="rounded-md border border-border/70 bg-secondary/25 px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs">
          <CalendarClock aria-hidden className="size-3.5 shrink-0 text-primary" />
          {problems.cron ? (
            <span className="text-destructive">{problems.cron}</span>
          ) : (
            <span className="text-foreground">
              {describeSchedule(trigger)} <span className="text-muted-foreground">· {zone}</span>
            </span>
          )}
        </p>
        {upcoming.length > 0 && (
          <p className="tnum mt-1 truncate text-[11px] text-muted-foreground">
            next: {upcoming.map((epochMs) => previewTime(epochMs, form.timezone)).join(" · ")}
          </p>
        )}
        {!problems.cron && upcoming.length === 0 && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-warn">
            <AlertCircle aria-hidden className="size-3" />
            This schedule has no occurrence in the next year.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project" error={problems.project}>
          <select
            value={form.project}
            onChange={(event) => patch({ project: event.target.value })}
            className="bg-deep-surface h-8 w-full rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          >
            {projects.length === 0 && <option value="">No projects registered</option>}
            {projects.map((project) => (
              <option key={project.name} value={project.name}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timezone" error={problems.timezone} hint="IANA name; empty = daemon host.">
          <Input
            value={form.timezone}
            spellCheck={false}
            placeholder={runtimeTimezone()}
            onChange={(event) => patch({ timezone: event.target.value })}
            className={cn("h-8 text-xs", problems.timezone && "border-destructive/60")}
          />
        </Field>
        <Field
          label="Precheck"
          hint="Run before each scheduled run. If it fails, the run is skipped."
        >
          <Input
            value={form.precheck}
            spellCheck={false}
            placeholder="git fetch --quiet"
            onChange={(event) => patch({ precheck: event.target.value })}
            className="h-8 font-mono text-xs md:text-xs"
          />
        </Field>
        <Field
          label="Missed-run grace"
          error={problems.graceMinutes}
          hint="If the app was off at the scheduled time, run it anyway if it's less than this late. Otherwise skip."
        >
          <div className="flex items-center gap-2">
            <Input
              value={form.graceMinutes}
              inputMode="numeric"
              onChange={(event) => patch({ graceMinutes: event.target.value })}
              className={cn("h-8 w-24 text-xs", problems.graceMinutes && "border-destructive/60")}
            />
            <span className="text-[11px] text-muted-foreground">minutes</span>
          </div>
        </Field>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
        <ToggleRow
          id="automation-reuse-session"
          checked={form.reuseSession}
          label="Same task every run"
          hint="Off: each run creates a new task in the sidebar. On: every run continues one task, so the sidebar never fills up."
          onChange={(reuseSession) => patch({ reuseSession })}
        />
        <ToggleRow
          id="automation-worktree"
          checked={form.worktree}
          label="Isolated worktree"
          hint="Run each new task in its own git worktree."
          onChange={(worktree) => patch({ worktree })}
        />
        <ToggleRow
          id="automation-enabled"
          checked={form.enabled}
          label="Enabled"
          hint="Paused automations keep their history but never fire."
          onChange={(enabled) => patch({ enabled })}
        />
      </div>
    </div>
  );
}

function Field({
  children,
  error,
  hint,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  label: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-[11px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground/70">{hint}</span>
      ) : null}
    </label>
  );
}

function ToggleRow({
  checked,
  hint,
  id,
  label,
  onChange,
}: {
  checked: boolean;
  hint: string;
  id: string;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2" title={hint}>
      <EnabledSwitch id={id} checked={checked} label={label} onChange={onChange} />
      <span className="text-xs text-foreground">{label}</span>
    </div>
  );
}
