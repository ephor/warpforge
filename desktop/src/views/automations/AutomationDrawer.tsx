import { Loader2, Pencil, Play, Trash2, X } from "lucide-react";
import { useState } from "react";

import { AgentLogo } from "@/components/AgentLogo";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { agentDisplayName } from "@/lib/agentNames";
import { countdown, describeSchedule, runtimeTimezone } from "@/lib/automationSchedule";
import { cn } from "@/lib/utils";
import type { AgentConfig, Automation, AutomationRun } from "@/protocol";

import { EnabledSwitch } from "./AutomationCard";
import { modelLabel, RUN_STATUS_META } from "./labels";

interface Props {
  automation: Automation | null;
  agents: AgentConfig[];
  runs: AutomationRun[];
  now: number;
  running: boolean;
  onClose: () => void;
  onEdit: (automation: Automation) => void;
  onRunNow: (automation: Automation) => void;
  onToggleEnabled: (automation: Automation, enabled: boolean) => void;
  onDelete: (automation: Automation) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (run: AutomationRun) => void;
}

/** Details for one automation, in a sheet over the grid: closing it leaves the
 *  grid, its filters and its scroll exactly as they were. */
export function AutomationDrawer({
  agents,
  automation,
  now,
  onClose,
  onDelete,
  onEdit,
  onOpenRun,
  onOpenTask,
  onRunNow,
  onToggleEnabled,
  runs,
  running,
}: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <>
      <Dialog open={automation !== null} onOpenChange={(next) => !next && onClose()}>
        <DialogContent
          hideClose
          className="fixed inset-y-0 right-0 left-auto top-0 flex h-full w-[min(40rem,calc(100vw-4rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 bg-popover p-0 shadow-2xl data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
        >
          {automation && (
            <>
              <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="truncate text-base">{automation.name}</DialogTitle>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {describeSchedule(automation.trigger)} ·{" "}
                    {automation.timezone || runtimeTimezone()} ·{" "}
                    {automation.enabled && (automation.nextRunAt ?? 0) > 0
                      ? countdown((automation.nextRunAt ?? 0) * 1000, now)
                      : automation.enabled
                        ? "not scheduled"
                        : "paused"}
                  </p>
                </div>
                <EnabledSwitch
                  id={`automation-drawer-enabled-${automation.id}`}
                  checked={automation.enabled}
                  label={automation.enabled ? "Pause automation" : "Resume automation"}
                  onChange={(enabled) => onToggleEnabled(automation, enabled)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={onClose}
                  aria-label="Close automation details"
                >
                  <X className="size-4" />
                </Button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <Fact label="Agent">
                    <span className="flex items-center gap-1.5">
                      <AgentLogo
                        agentId={automation.agent}
                        displayName={agentDisplayName(automation.agent)}
                        className="size-3.5"
                      />
                      {agentDisplayName(automation.agent)}
                    </span>
                  </Fact>
                  <Fact label="Model">
                    {modelLabel(agents, automation.agent, automation.model)}
                  </Fact>
                  <Fact label="Project">{automation.project}</Fact>
                  <Fact label="Cron">
                    <code className="font-mono text-[11px]">{automation.trigger.cron}</code>
                  </Fact>
                  <Fact label="Last run">
                    {automation.lastRunAt
                      ? new Date(automation.lastRunAt * 1000).toLocaleString()
                      : "never"}
                  </Fact>
                  <Fact label="Missed-run grace">{automation.missedRunGraceMinutes} min</Fact>
                  <Fact label="Precheck">
                    {automation.precheck ? (
                      <code className="font-mono text-[11px]">{automation.precheck}</code>
                    ) : (
                      "none"
                    )}
                  </Fact>
                  <Fact label="Runs go to">
                    {[
                      automation.reuseSession
                        ? "one task, every run continues it"
                        : "a new task each run",
                      automation.worktree ? "isolated worktree" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Fact>
                </dl>

                <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Prompt
                </h3>
                <pre className="mt-1.5 whitespace-pre-wrap rounded-md border border-border/70 bg-secondary/25 px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {automation.prompt}
                </pre>

                <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Run history
                </h3>
                {runs.length === 0 ? (
                  <p className="mt-1.5 text-xs text-muted-foreground/80">
                    No runs yet. “Run now” starts one without touching the schedule.
                  </p>
                ) : (
                  <ul className="mt-1.5 divide-y divide-border/60 rounded-md border border-border/70">
                    {runs.map((run) => (
                      <RunRow
                        key={run.id}
                        run={run}
                        onOpenRun={() => onOpenRun(run)}
                        onOpenTask={onOpenTask}
                      />
                    ))}
                  </ul>
                )}
              </div>

              <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => onRunNow(automation)}
                  title="Run once now; the next scheduled occurrence is unchanged."
                >
                  {running ? (
                    <Loader2 aria-hidden className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Play aria-hidden className="mr-1 size-3.5" />
                  )}
                  Run now
                </Button>
                <Button type="button" size="sm" onClick={() => onEdit(automation)}>
                  <Pencil aria-hidden className="mr-1 size-3.5" />
                  Edit
                </Button>
                <span className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 aria-hidden className="mr-1 size-3.5" />
                  Delete
                </Button>
              </footer>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmingDelete && automation !== null}
        title={`Delete ${automation?.name ?? "automation"}?`}
        description="The schedule and its run history go away. Tasks the runs created stay."
        confirmLabel="Delete"
        busyLabel="Deleting…"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          if (!automation) return;
          await onDelete(automation);
          setConfirmingDelete(false);
        }}
      />
    </>
  );
}

function Fact({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground">{children}</dd>
    </div>
  );
}

function RunRow({
  onOpenRun,
  onOpenTask,
  run,
}: {
  onOpenRun: () => void;
  onOpenTask: (taskId: string) => void;
  run: AutomationRun;
}) {
  const meta = RUN_STATUS_META[run.status];
  return (
    <li className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
      <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} aria-hidden />
      <button
        type="button"
        onClick={onOpenRun}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={meta.hint}
      >
        <span className="tnum shrink-0 text-muted-foreground">#{run.runNumber}</span>
        <span className="shrink-0">{meta.label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
          {run.error ?? run.output ?? (run.trigger === "manual" ? "manual" : "scheduled")}
        </span>
        <span className="shrink-0 text-muted-foreground/70">
          {new Date(run.startedAt * 1000).toLocaleString()}
        </span>
      </button>
      {run.taskId && (
        <button
          type="button"
          onClick={() => onOpenTask(run.taskId!)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Task
        </button>
      )}
    </li>
  );
}
