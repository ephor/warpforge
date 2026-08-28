import { Info } from "lucide-react";

import type { TaskInfo } from "@/protocol";

/**
 * Tell the user the session is not on the model they asked for.
 *
 * The session itself is alive and usable, so this is an informational notice,
 * not an error: it neither blocks input nor implies anything is broken. The
 * condition clears by itself once the requested model is applied.
 */
export function ModelMismatchBanner({ task }: { task: TaskInfo }) {
  if (task.blockedKind !== "model_mismatch") return null;

  return (
    <div className="flex items-start gap-2 border-b border-border/80 bg-muted/50 px-4 py-2 text-xs">
      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          This session is not running on the requested model
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {task.blockedReason ?? "The requested model was not applied."} The session works, but it
          is running on a different model.
        </p>
      </div>
    </div>
  );
}
