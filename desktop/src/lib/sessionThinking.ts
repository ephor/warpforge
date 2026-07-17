import type { SessionUpdate, TaskStatus } from "../protocol";

/**
 * Return the thought block receiving the current reasoning stream. Thinking
 * is a phase, not a whole turn: a tool, answer, permission request, or turn
 * boundary completes it. Transport metadata does not.
 */
export function activeThinkingIndex(
  updates: SessionUpdate[],
  taskStatus: TaskStatus,
): number | null {
  // A queued retry can still carry a trailing thought from its previous run.
  // Wait for the daemon to mark it running and emit fresh session activity.
  if (taskStatus !== "running") {
    return null;
  }

  for (let index = updates.length - 1; index >= 0; index--) {
    const update = updates[index];
    if (
      update.kind === "available_commands" ||
      update.kind === "prompt_capabilities" ||
      update.kind === "permission_resolved"
    ) {
      continue;
    }
    return update.kind === "agent_thought" ? index : null;
  }

  return null;
}
