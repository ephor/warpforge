import { useEffect, useState } from "react";

import { daemon } from "@/daemon";

/**
 * Fetches a task's full conversation the first time a chat showing it mounts.
 * The connection snapshot carries no transcripts, so a connect stays fast on
 * large databases; the chat renders a brief placeholder until this resolves.
 *
 * The list mounts only after the fetch has settled — successfully or not — so
 * nothing can appear above the viewport of a mounted transcript (ADR 0005).
 * A failed fetch resolves too and the chat degrades to an empty transcript
 * that refills from live events.
 */
export function useSessionHistory(taskId: string): boolean {
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResolved(false);
    void daemon
      .loadSessionHistory(taskId)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return resolved;
}
