import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AutomationRun } from "@/protocol";

import { RUN_STATUS_META } from "./labels";

interface Props {
  run: AutomationRun | null;
  /** Name of the automation the run belongs to, for the title. */
  automationName: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

function duration(run: AutomationRun): string {
  if (!run.finishedAt) return "still running";
  const seconds = Math.max(0, run.finishedAt - run.startedAt);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What one run did. The excerpt is all the daemon keeps here — the full
 *  transcript lives on the task, one click away. */
export function RunOutputDialog({ automationName, onClose, onOpenTask, run }: Props) {
  const meta = run ? RUN_STATUS_META[run.status] : null;
  return (
    <Dialog open={run !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(40rem,calc(100vw-3rem))] max-w-none">
        {run && meta && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="truncate">
                  {automationName} · run #{run.runNumber}
                </span>
                <Badge variant={meta.badge} className="shrink-0 py-0 text-[11px]">
                  {meta.label}
                </Badge>
              </DialogTitle>
              <DialogDescription>
                {run.trigger === "manual" ? "Started by hand" : "Scheduled run"} ·{" "}
                {new Date(run.startedAt * 1000).toLocaleString()} · {duration(run)}
              </DialogDescription>
            </DialogHeader>

            <p className="text-xs text-muted-foreground">{meta.hint}</p>

            {run.error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {run.error}
              </p>
            )}

            {run.output ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-secondary/25 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                {run.output}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground/80">No output recorded for this run.</p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              {run.taskId && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const taskId = run.taskId;
                    onClose();
                    if (taskId) onOpenTask(taskId);
                  }}
                >
                  Open task
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
