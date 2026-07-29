import { CircleCheckBig, Pause, Play, Plus, Square } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const [busy, setBusy] = useState(false);
  if (!run) return null;

  const waiting = run.waiting ?? null;
  const finished = run.stage === "done" || run.stage === "failed";

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(`Could not ${label}`, { description: String(e) });
    } finally {
      setBusy(false);
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
                  <Play className="size-3" /> Resume
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
                  <Pause className="size-3" /> Pause
                </Button>
              )}
            </>
          )}
        </span>
      </div>

      {waiting?.kind === "limit" && (
        <LimitDecision task={task} summary={waiting.question ?? ""} busy={busy} act={act} />
      )}

      {waiting?.kind === "paused" && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Paused before the {stageLabel(run.stage)} stage. Type a message to resume with it as
          guidance, or press Resume.
        </p>
      )}
    </div>
  );
});

/** Buttons shown when review rounds ran out with findings still open. */
function LimitDecision({
  task,
  summary,
  busy,
  act,
}: {
  task: TaskInfo;
  summary: string;
  busy: boolean;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  return (
    <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
      <p className="text-xs text-foreground">
        Review rounds are used up{summary ? ` — ${summary}` : ""}. What next?
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        A message you type below is passed to the next fix attempt as guidance.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() =>
            void act("extend the rounds", () =>
              daemon.workflowDecide(task.id, "extend", { rounds: 2 }),
            )
          }
        >
          <Plus className="size-3" /> 2 more rounds
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() =>
            void act("extend the rounds", () =>
              daemon.workflowDecide(task.id, "extend", { rounds: 1 }),
            )
          }
        >
          <Plus className="size-3" /> 1 more round
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy}
          title="Finish now and review the changes yourself"
          onClick={() =>
            void act("finish the workflow", () => daemon.workflowDecide(task.id, "finish"))
          }
        >
          <CircleCheckBig className="size-3" /> Finish as is
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() =>
            void act("stop the workflow", () => daemon.workflowDecide(task.id, "stop"))
          }
        >
          <Square className="size-3" /> Stop
        </Button>
      </div>
    </div>
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
          ? `paused before ${stageLabel(run.stage)}`
          : stageLabel(run.stage)}
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

export function stageLabel(stage: WorkflowRunInfo["stage"]): string {
  switch (stage) {
    case "plan":
      return "planning";
    case "implement":
      return "implementing";
    case "review":
      return "reviewing";
    case "fix":
      return "fixing";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}
