import { Clock, FolderGit2, Loader2, Play, ShieldCheck, Timer } from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { Badge } from "@/components/ui/badge";
import { agentDisplayName } from "@/lib/agentNames";
import { countdown, describeSchedule, runtimeTimezone } from "@/lib/automationSchedule";
import { cn } from "@/lib/utils";
import type { AgentConfig, Automation, AutomationRun } from "@/protocol";

import { modelLabel, RunSpark, runStatusMeta } from "./labels";

interface Props {
  automation: Automation;
  agents: AgentConfig[];
  runs: AutomationRun[];
  now: number;
  running: boolean;
  onOpen: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
}

/**
 * One automation as a card. The grid is cards rather than rows because the
 * useful facts are not comparable columns: a schedule sentence, a run spark and
 * a status badge each want their own shape, and a table forced them into
 * matching widths that read as noise.
 */
export function AutomationCard({
  agents,
  automation,
  now,
  onOpen,
  onRunNow,
  onToggleEnabled,
  runs,
  running,
}: Props) {
  const last = runStatusMeta(automation.lastStatus);
  const failed = automation.lastStatus === "failed";
  const zone = automation.timezone || runtimeTimezone();
  const showZone = zone !== runtimeTimezone();
  const nextRunMs = (automation.nextRunAt ?? 0) * 1000;
  const agentName = agentDisplayName(automation.agent);

  return (
    <div
      data-testid="automation-card"
      className={cn(
        "flex min-w-0 flex-col rounded-lg border bg-card transition-colors",
        failed ? "border-destructive/45" : "border-border",
        !automation.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2 px-3 pt-3">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title="Open automation details"
        >
          <span className="block truncate text-sm font-semibold text-foreground">
            {automation.name}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {automation.prompt}
          </span>
        </button>
        <EnabledSwitch
          id={`automation-enabled-${automation.id}`}
          checked={automation.enabled}
          label={automation.enabled ? "Pause automation" : "Resume automation"}
          onChange={onToggleEnabled}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
        <Badge variant="outline" className="gap-1 py-0 pl-1 pr-2 text-[11px] font-normal">
          <AgentLogo agentId={automation.agent} displayName={agentName} className="size-3" />
          {agentName}
        </Badge>
        <Badge variant="outline" className="py-0 text-[11px] font-normal">
          {modelLabel(agents, automation.agent, automation.model)}
        </Badge>
        <Badge variant="outline" className="gap-1 py-0 pl-1 pr-2 text-[11px] font-normal">
          <FolderGit2 aria-hidden className="size-3" />
          {automation.project}
        </Badge>
        {automation.precheck && (
          <Badge
            variant="outline"
            className="gap-1 py-0 pl-1 pr-2 text-[11px] font-normal"
            title={`Precheck: ${automation.precheck}`}
          >
            <ShieldCheck aria-hidden className="size-3" />
            precheck
          </Badge>
        )}
      </div>

      <div className="mt-2.5 space-y-1 px-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Clock aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="truncate">
            {describeSchedule(automation.trigger)}
            {showZone && <span className="text-muted-foreground/70"> · {zone}</span>}
          </span>
        </p>
        <p className="flex items-center gap-1.5">
          <Timer aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
          {automation.enabled && nextRunMs > 0 ? (
            <span className="truncate" title={new Date(nextRunMs).toLocaleString()}>
              {countdown(nextRunMs, now)}
            </span>
          ) : (
            <span className="truncate">{automation.enabled ? "not scheduled" : "paused"}</span>
          )}
        </p>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-border/70 px-3 py-2">
        {last ? (
          <Badge variant={last.badge} className="py-0 text-[11px]" title={last.hint}>
            {last.label}
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground/70">never run</span>
        )}
        <RunSpark runs={runs} />
        <span className="flex-1" />
        <button
          type="button"
          onClick={onRunNow}
          disabled={running}
          title="Run this automation now (skips the precheck)"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {running ? (
            <Loader2 aria-hidden className="size-3 animate-spin" />
          ) : (
            <Play aria-hidden className="size-3" />
          )}
          Run now
        </button>
      </div>
    </div>
  );
}

export function EnabledSwitch({
  checked,
  id,
  label,
  onChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="relative inline-flex shrink-0 cursor-pointer items-center">
      <span className="sr-only">{label}</span>
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        title={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div className="h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-primary/80 after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:after:translate-x-4" />
    </label>
  );
}
