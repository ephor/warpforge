import { useEffect } from "react";

import { daemon } from "@/daemon";

/**
 * Loads a task's full conversation the first time it is opened. The connection
 * snapshot carries only a recent tail per task, so a connect stays fast on
 * large databases; this backfills the transcript for the open task once.
 */
export function useSessionHistory(taskId: string) {
  useEffect(() => {
    void daemon.loadSessionHistory(taskId);
  }, [taskId]);
}
