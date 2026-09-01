import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { daemon } from "@/daemon";
import {
  automationRunsKey,
  useAutomationEvents,
  useAutomationRuns,
  useAutomationsQuery,
  useTicker,
} from "@/hooks/useAutomations";
import { cn } from "@/lib/utils";
import type { Automation, AutomationRun, Snapshot } from "@/protocol";

import { AutomationCard } from "./automations/AutomationCard";
import { AutomationDialog } from "./automations/AutomationDialog";
import { AutomationDrawer } from "./automations/AutomationDrawer";
import { AutomationLiveStrip } from "./automations/AutomationLiveStrip";
import { isSkipped } from "./automations/labels";
import { RunOutputDialog } from "./automations/RunOutputDialog";

type StateFilter = "all" | "enabled" | "paused";
type OutcomeFilter = "all" | "completed" | "failed" | "skipped" | "never";

const STATE_FILTERS: { id: StateFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "paused", label: "Paused" },
];

const OUTCOME_FILTERS: { id: OutcomeFilter; label: string }[] = [
  { id: "all", label: "Any outcome" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "skipped", label: "Skipped" },
  { id: "never", label: "Never run" },
];

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
}

/** Stable identity for the pre-fetch render, so the id memo below holds. */
const NO_AUTOMATIONS: Automation[] = [];

/**
 * The Automations screen: what runs next, what ran overnight, and one card per
 * schedule. Automations are not in the connect snapshot, so this view fetches
 * them and stays live off the `automation.*` events for as long as it is open.
 */
export default function Automations({ onOpenTask, snapshot }: Props) {
  const queryClient = useQueryClient();
  useAutomationEvents();
  const now = useTicker();
  const automationsQuery = useAutomationsQuery();
  const automations = automationsQuery.data ?? NO_AUTOMATIONS;
  const ids = useMemo(() => automations.map((automation) => automation.id), [automations]);
  const runsById = useAutomationRuns(ids);
  const agents = snapshot.agents ?? [];

  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const [openRun, setOpenRun] = useState<AutomationRun | null>(null);
  const [runningIds, setRunningIds] = useState<string[]>([]);

  const term = search.trim().toLowerCase();
  const visible = automations.filter((automation) => {
    if (term && !`${automation.name}\n${automation.prompt}`.toLowerCase().includes(term)) {
      return false;
    }
    if (stateFilter === "enabled" && !automation.enabled) return false;
    if (stateFilter === "paused" && automation.enabled) return false;
    const last = automation.lastStatus;
    switch (outcomeFilter) {
      case "completed":
        return last === "completed";
      case "failed":
        return last === "failed";
      case "skipped":
        return !!last && isSkipped(last);
      case "never":
        return !last;
      default:
        return true;
    }
  });

  const drawerAutomation = automations.find((automation) => automation.id === openId) ?? null;
  const runOutputName =
    automations.find((automation) => automation.id === openRun?.automationId)?.name ?? "Automation";

  const toggleEnabled = async (automation: Automation, enabled: boolean) => {
    try {
      await daemon.updateAutomation(automation.id, { enabled });
    } catch (error) {
      toast.error(enabled ? "Could not resume the automation" : "Could not pause the automation", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runNow = async (automation: Automation) => {
    setRunningIds((previous) => [...previous, automation.id]);
    try {
      await daemon.runAutomationNow(automation.id);
      await queryClient.invalidateQueries({ queryKey: automationRunsKey(automation.id) });
      toast.success(`${automation.name} is running now`, {
        description: "The next scheduled run is unchanged.",
      });
    } catch (error) {
      toast.error("Could not start the run", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunningIds((previous) => previous.filter((id) => id !== automation.id));
    }
  };

  const remove = async (automation: Automation) => {
    await daemon.deleteAutomation(automation.id);
    setOpenId(null);
    toast.success(`${automation.name} deleted`);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1 pb-3 pt-2">
        <div className="min-w-0 space-y-1.5">
          <h1 className="truncate text-xl font-semibold leading-none tracking-tight">
            Automations
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            Prompts the daemon runs on a schedule. Each run becomes a real task.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 px-2.5"
          disabled={snapshot.projects.length === 0}
          title={
            snapshot.projects.length === 0
              ? "Add a project first — an automation runs in one."
              : "Create an automation"
          }
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4" />
          New automation
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        <AutomationLiveStrip
          automations={automations}
          runsById={runsById}
          now={now}
          onOpenRun={setOpenRun}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-72">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70"
            />
            <Input
              aria-label="Search automations"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or prompt"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <FilterGroup
            label="State"
            options={STATE_FILTERS}
            value={stateFilter}
            onChange={setStateFilter}
          />
          <FilterGroup
            label="Last run"
            options={OUTCOME_FILTERS}
            value={outcomeFilter}
            onChange={setOutcomeFilter}
          />
        </div>

        {automationsQuery.isLoading ? (
          <p className="mt-10 flex items-center justify-center gap-2 text-xs text-muted-foreground/70">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            Loading automations…
          </p>
        ) : automationsQuery.error ? (
          <p className="mt-10 text-center text-xs text-destructive">
            {automationsQuery.error instanceof Error
              ? automationsQuery.error.message
              : "Could not load automations."}
          </p>
        ) : automations.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center text-muted-foreground">
            <CalendarClock aria-hidden className="size-6 text-muted-foreground/50" />
            <p className="max-w-md text-sm">
              No automations yet. Schedule a prompt — a morning PR triage, a nightly dependency
              check — and every run shows up here with its own task.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={snapshot.projects.length === 0}
              onClick={() => setCreating(true)}
            >
              <Plus className="mr-1 size-4" />
              New automation
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p className="mt-16 text-center text-sm text-muted-foreground">
            No automations match these filters.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((automation) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                agents={agents}
                runs={runsById[automation.id] ?? []}
                now={now}
                running={runningIds.includes(automation.id)}
                onOpen={() => setOpenId(automation.id)}
                onToggleEnabled={(enabled) => void toggleEnabled(automation, enabled)}
                onRunNow={() => void runNow(automation)}
              />
            ))}
          </div>
        )}
      </div>

      <AutomationDrawer
        automation={drawerAutomation}
        agents={agents}
        runs={drawerAutomation ? (runsById[drawerAutomation.id] ?? []) : []}
        now={now}
        running={!!drawerAutomation && runningIds.includes(drawerAutomation.id)}
        onClose={() => setOpenId(null)}
        onEdit={(automation) => {
          setOpenId(null);
          setEditing(automation);
        }}
        onRunNow={(automation) => void runNow(automation)}
        onToggleEnabled={(automation, enabled) => void toggleEnabled(automation, enabled)}
        onDelete={remove}
        onOpenTask={onOpenTask}
        onOpenRun={setOpenRun}
      />

      {(creating || editing) && (
        <AutomationDialog
          // Remounting per target is what resets the form: the dialog owns its
          // draft, and reusing one instance would carry it between edits.
          key={editing?.id ?? "new"}
          open
          onOpenChange={(next) => {
            if (next) return;
            setCreating(false);
            setEditing(null);
          }}
          snapshot={snapshot}
          automation={editing}
          defaultProject={editing?.project ?? snapshot.projects[0]?.name ?? null}
        />
      )}

      <RunOutputDialog
        run={openRun}
        automationName={runOutputName}
        onClose={() => setOpenRun(null)}
        onOpenTask={onOpenTask}
      />
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (next: T) => void;
  options: { id: T; label: string }[];
  value: T;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-card p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "h-7 rounded px-2 text-[11px] transition-colors",
            value === option.id
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
