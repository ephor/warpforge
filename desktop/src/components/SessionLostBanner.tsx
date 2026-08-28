import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import { ContinueSessionDialog } from "@/components/ContinueSessionDialog";
import { Button } from "@/components/ui/button";
import { useTaskSessionUpdates } from "@/hooks/useTaskSessionUpdates";
import { agentDisplayName } from "@/lib/agentNames";
import type { TaskInfo } from "@/protocol";

/**
 * Offer a way forward when an agent has forgotten a task's session.
 *
 * The agent's own history is gone and no retry will bring it back, so resume is
 * off the table — but Warpforge keeps its own transcript, so the work is not
 * lost, only the agent's memory of it. Without this the task sat blocked with a
 * protocol error and no next step.
 */
export function SessionLostBanner({
  task,
  onOpenTask,
}: {
  task: TaskInfo;
  onOpenTask: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const updates = useTaskSessionUpdates(task.id);

  if (task.blockedKind !== "session_lost") return null;

  return (
    <div className="flex items-start gap-2 border-b border-border/80 bg-warn/10 px-4 py-2 text-xs">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {agentDisplayName(task.agent)} no longer has this session
        </p>
        <p className="mt-0.5 text-muted-foreground">
          Its own history was deleted or expired, so it cannot be resumed. The conversation
          Warpforge recorded is intact and can seed a fresh session.
        </p>
      </div>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setOpen(true)}>
        Continue…
      </Button>
      {open && (
        <ContinueSessionDialog
          open={open}
          onOpenChange={setOpen}
          task={task}
          updates={updates}
          throughIndex={updates.length - 1}
          targetAgent={task.agent}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  );
}
