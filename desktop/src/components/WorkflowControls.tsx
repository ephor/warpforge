import { AlertTriangle, CircleCheckBig, Loader2, Pause, Play, Plus, Square } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { workflowStageLabel } from "@/lib/workflow";

import { daemon } from "../daemon";
import type { TaskInfo, WorkflowRunInfo } from "../protocol";

/**
 * Pipeline status strip + controls for a workflow parent task.
 *
 * A workflow parent has no agent session of its own — the daemon drives its
 * stages — so this bar (not the composer) is where the pipeline is steered.
 * The composer takes over only when a stage asks a question; see
 * `ChatComposer`.
 */
export const WorkflowControls = memo(function WorkflowControls({ task }: { task: TaskInfo }) {
  const run = task.workflowRun;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  if (!run) return null;

  const waiting = run.waiting ?? null;
  const finished = run.stage === "done" || run.stage === "failed";
  const busy = busyAction !== null;

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusyAction(label);
    try {
      await fn();
    } catch (e) {
      toast.error(`Could not ${label}`, { description: String(e) });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="shrink-0 border-t border-border/70 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StageIndicator run={run} />
        <span className="ml-auto flex items-center gap-1.5">
          {!finished && waiting?.kind !== "limit" && (
            <>
              {waiting?.kind === "paused" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6 gap-1 px-2 text-xs"
                  disabled={busy}
                  onClick={() => void act("resume", () => daemon.workflowResume(task.id))}
                >
                  {busyAction === "resume" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  {busyAction === "resume" ? "Resuming…" : "Resume"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-xs"
                  disabled={busy}
                  title="Let the running stage finish, then hold before the next one"
                  onClick={() => void act("pause", () => daemon.workflowPause(task.id))}
                >
                  {busyAction === "pause" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Pause className="size-3" />
                  )}
                  {busyAction === "pause" ? "Pausing…" : "Pause"}
                </Button>
              )}
            </>
          )}
          {!finished && waiting?.kind !== "limit" && (
            <Button
              size="sm"
              variant="destructive"
              className="h-6 gap-1 px-2 text-xs"
              disabled={busy}
              onClick={() =>
                void act("stop the workflow", async () => {
                  await daemon.request("task.cancel", { task_id: task.id });
                })
              }
            >
              {busyAction === "stop the workflow" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
              {busyAction === "stop the workflow" ? "Stopping…" : "Stop"}
            </Button>
          )}
        </span>
      </div>

      {waiting?.kind === "limit" && (
        <LimitDecision
          task={task}
          summary={waiting.question ?? ""}
          busyAction={busyAction}
          act={act}
        />
      )}

      {waiting?.kind === "paused" && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Paused before the {workflowStageLabel(run.stage)} stage. Type a message to resume with it
          as guidance, or press Resume.
        </p>
      )}
    </div>
  );
});

/** Buttons shown when review rounds ran out with findings still open. */
function LimitDecision({
  task,
  summary,
  busyAction,
  act,
}: {
  task: TaskInfo;
  summary: string;
  busyAction: string | null;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const busy = busyAction !== null;
  return (
    <section
      aria-label="Review limit reached"
      className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/[0.07] p-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Review limit reached</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Reviewers still request changes{summary ? ` — ${summary}` : ""}.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Continue the fix → review loop, finish with the current changes, or stop the workflow.
          </p>
        </div>
      </div>

      <div aria-live="polite" className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1 px-2.5"
          disabled={busy}
          title="Run one more fix → review cycle"
          onClick={() =>
            void act("add one review round", () =>
              daemon.workflowDecide(task.id, "extend", { rounds: 1 }),
            )
          }
        >
          {busyAction === "add one review round" ? <Loader2 className="animate-spin" /> : <Plus />}
          {busyAction === "add one review round" ? "Continuing…" : "1 more round"}
        </Button>
        <Button
          size="sm"
          className="gap-1 px-2.5"
          disabled={busy}
          title="Run two more fix → review cycles"
          onClick={() =>
            void act("add two review rounds", () =>
              daemon.workflowDecide(task.id, "extend", { rounds: 2 }),
            )
          }
        >
          {busyAction === "add two review rounds" ? <Loader2 className="animate-spin" /> : <Plus />}
          {busyAction === "add two review rounds" ? "Continuing…" : "2 more rounds"}
        </Button>
        <Button
          size="sm"
          className="gap-1 px-2.5"
          disabled={busy}
          title="Stop the pipeline and send the current changes to human review"
          onClick={() =>
            void act("finish the workflow", () => daemon.workflowDecide(task.id, "finish"))
          }
        >
          {busyAction === "finish the workflow" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <CircleCheckBig />
          )}
          {busyAction === "finish the workflow" ? "Finishing…" : "Finish for review"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="gap-1 px-2.5"
          disabled={busy}
          title="Stop immediately and mark the workflow as interrupted"
          onClick={() =>
            void act("stop the workflow", () => daemon.workflowDecide(task.id, "stop"))
          }
        >
          {busyAction === "stop the workflow" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Square className="fill-current" />
          )}
          {busyAction === "stop the workflow" ? "Stopping…" : "Stop"}
        </Button>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Guidance typed below is used only when you continue with another round.
      </p>
    </section>
  );
}

function StageIndicator({ run }: { run: WorkflowRunInfo }) {
  const waiting = run.waiting ?? null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="truncate font-medium text-foreground">{run.workflowName}</span>
      <span className="text-border">·</span>
      <span className="text-muted-foreground">
        {waiting?.kind === "paused"
          ? `paused before ${workflowStageLabel(run.stage)}`
          : workflowStageLabel(run.stage)}
      </span>
      {run.round > 0 && run.stage !== "done" && run.stage !== "failed" && (
        <span className="tnum text-muted-foreground">
          round {run.round}/{run.maxRounds}
        </span>
      )}
      {run.verdict && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            run.verdict === "approve"
              ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/12 text-amber-600 dark:text-amber-400",
          )}
        >
          {run.verdict === "approve" ? "approved" : "changes requested"}
        </span>
      )}
    </span>
  );
}
