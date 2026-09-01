import type { BadgeProps } from "@/lib/badgeVariants";
import { configRole } from "@/lib/configRole";
import { cn } from "@/lib/utils";
import type { AgentConfig, AutomationRun, AutomationRunStatus, ConfigOption } from "@/protocol";

interface RunStatusMeta {
  label: string;
  badge: BadgeProps["variant"];
  /** Timeline / spark marker colour. */
  dot: string;
  /** One line explaining why a run ended this way. */
  hint: string;
}

export const RUN_STATUS_META: Record<AutomationRunStatus, RunStatusMeta> = {
  completed: {
    badge: "ok",
    dot: "bg-ok",
    hint: "The agent finished its turn.",
    label: "Completed",
  },
  failed: {
    badge: "destructive",
    dot: "bg-destructive",
    hint: "The run started but the agent did not finish.",
    label: "Failed",
  },
  pending: {
    badge: "outline",
    dot: "bg-muted-foreground/50",
    hint: "Waiting for the precheck before any work is dispatched.",
    label: "Pending",
  },
  running: {
    badge: "warn",
    dot: "bg-warn",
    hint: "A task is running the prompt right now.",
    label: "Running",
  },
  skipped_missed: {
    badge: "outline",
    dot: "bg-muted-foreground/40",
    hint: "Came due while Warpforge was closed, and past the grace window.",
    label: "Skipped · missed",
  },
  skipped_precheck: {
    badge: "outline",
    dot: "bg-muted-foreground/40",
    hint: "The precheck command did not authorize this run.",
    label: "Skipped · precheck",
  },
  skipped_running: {
    badge: "outline",
    dot: "bg-muted-foreground/40",
    hint: "The previous run of this automation had not finished.",
    label: "Skipped · overlap",
  },
};

export function runStatusMeta(
  status: AutomationRunStatus | null | undefined,
): RunStatusMeta | null {
  return status ? RUN_STATUS_META[status] : null;
}

/** The agent's model selector, as reported by its last ACP probe. */
export function modelOptionOf(agents: AgentConfig[], agentId: string): ConfigOption | null {
  const agent = agents.find((candidate) => candidate.id === agentId);
  return agent?.models.find((option) => configRole(option) === "model") ?? null;
}

/** Display name for a stored model id, falling back to the raw id so an
 *  automation created before the agent was probed still shows what it will run. */
export function modelLabel(
  agents: AgentConfig[],
  agentId: string,
  model: string | null | undefined,
): string {
  if (!model) return "agent default";
  const option = modelOptionOf(agents, agentId);
  return option?.options.find((choice) => choice.value === model)?.name ?? model;
}

export function isSkipped(status: AutomationRunStatus): boolean {
  return status.startsWith("skipped_");
}

/** One run as a tooltip line: "#12 · Completed · manual". */
export function runSummary(run: AutomationRun): string {
  const meta = RUN_STATUS_META[run.status];
  const when = new Date(run.startedAt * 1000).toLocaleString();
  const detail = run.error ? ` — ${run.error}` : "";
  return `#${run.runNumber} · ${meta.label} · ${run.trigger} · ${when}${detail}`;
}

/**
 * The last N runs as a row of ✓/✗ dots, newest on the right so the row reads
 * left-to-right like time does. Runs the daemon has not produced yet leave no
 * placeholder — an empty slot would read as a skipped run.
 */
export function RunSpark({ runs, limit = 10 }: { runs: AutomationRun[]; limit?: number }) {
  const recent = runs.slice(0, limit).reverse();
  if (recent.length === 0) {
    return <span className="text-[11px] text-muted-foreground/60">no runs yet</span>;
  }
  return (
    <span className="flex items-center gap-1" aria-label={`Last ${recent.length} runs`}>
      {recent.map((run) => (
        <span
          key={run.id}
          title={runSummary(run)}
          className={cn(
            "size-1.5 rounded-full",
            RUN_STATUS_META[run.status].dot,
            run.status === "running" && "animate-pulse",
          )}
        />
      ))}
    </span>
  );
}
