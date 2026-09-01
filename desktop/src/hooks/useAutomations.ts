import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { daemon } from "@/daemon";
import type { Automation, AutomationRun, DaemonEvent } from "@/protocol";

/** How much run history one automation keeps client-side: enough for the card
 *  spark (10), the 24h timeline and a readable history list. */
export const RUN_HISTORY_LIMIT = 25;

export const automationsKey = ["automations"] as const;
export const automationRunsKey = (id: string) => ["automationRuns", id] as const;

export function useAutomationsQuery() {
  return useQuery({
    queryFn: () => daemon.listAutomations(),
    queryKey: automationsKey,
  });
}

/** Run history for many automations at once, keyed by automation id. */
export function useAutomationRuns(ids: string[]): Record<string, AutomationRun[]> {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryFn: () => daemon.automationRuns(id, RUN_HISTORY_LIMIT),
      queryKey: automationRunsKey(id),
    })),
  });
  const byId: Record<string, AutomationRun[]> = {};
  for (let index = 0; index < ids.length; index++) {
    byId[ids[index]!] = results[index]?.data ?? [];
  }
  return byId;
}

function upsertRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  const next = runs.some((candidate) => candidate.id === run.id)
    ? runs.map((candidate) => (candidate.id === run.id ? run : candidate))
    : [run, ...runs];
  return next.sort((a, b) => b.runNumber - a.runNumber).slice(0, RUN_HISTORY_LIMIT);
}

/**
 * Keep the automation caches live off the daemon's three `automation.*` events.
 * Mounted by the Automations screen rather than the app shell: nothing else
 * reads these caches, and a background subscription would hold run history for
 * a view nobody has open.
 */
export function useAutomationEvents() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      daemon.subscribeEvents((event: DaemonEvent) => {
        if (event.event === "automation.updated") {
          const updated = event.data;
          queryClient.setQueryData<Automation[]>(automationsKey, (previous) => {
            if (!previous) return previous;
            return previous.some((candidate) => candidate.id === updated.id)
              ? previous.map((candidate) => (candidate.id === updated.id ? updated : candidate))
              : [updated, ...previous];
          });
          return;
        }
        if (event.event === "automation.removed") {
          const { id } = event.data;
          queryClient.setQueryData<Automation[]>(automationsKey, (previous) =>
            previous?.filter((candidate) => candidate.id !== id),
          );
          queryClient.removeQueries({ queryKey: automationRunsKey(id) });
          return;
        }
        if (event.event === "automation.runUpdated") {
          const run = event.data;
          queryClient.setQueryData<AutomationRun[]>(
            automationRunsKey(run.automationId),
            (previous) => (previous ? upsertRun(previous, run) : previous),
          );
        }
      }),
    [queryClient],
  );
}

/**
 * A clock that advances on an interval, for countdowns. Coarse by design — the
 * strip shows minutes, so a per-second re-render would buy nothing.
 */
export function useTicker(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
