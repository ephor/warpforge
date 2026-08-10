import { useCallback, useSyncExternalStore } from "react";

import { daemon } from "@/daemon";
import type { SessionUpdate } from "@/protocol";

const EMPTY_SESSION_UPDATES: SessionUpdate[] = [];

/**
 * Shared by the conversation transcript and the task-header status pill —
 * both need the same live stream to derive activity, so there is exactly one
 * subscription per task, not one per consumer.
 */
export function useTaskSessionUpdates(taskId: string) {
  const getUpdates = useCallback(
    () => daemon.getState().sessionUpdates[taskId] ?? EMPTY_SESSION_UPDATES,
    [taskId],
  );
  return useSyncExternalStore(daemon.subscribe, getUpdates, getUpdates);
}
