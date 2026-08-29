import { useEffect, useState } from "react";

import { daemon } from "@/daemon";

/**
 * Loads a task's full conversation the first time it is opened. The connection
 * snapshot carries only a recent tail per task, so a connect stays fast on
 * large databases; this backfills the transcript for the open task once.
 *
 * Returns true once the backfill has landed, so the transcript can re-pin: the
 * rest of the conversation arrives *above* what is on screen and every row it
 * prepends is unmeasured, which otherwise drags the view off the latest
 * message.
 */
export function useSessionHistory(taskId: string): boolean {
  const [backfilled, setBackfilled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBackfilled(false);
    void daemon.loadSessionHistory(taskId).then(() => {
      if (!cancelled) setBackfilled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return backfilled;
}
