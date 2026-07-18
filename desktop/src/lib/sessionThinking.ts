import type { SessionUpdate, TaskStatus } from "../protocol";

/**
 * Return the thought block receiving the current reasoning stream. Thinking
 * remains active as long as no final answer (`agent_text`) or new user turn
 * (`user_message`) has appeared after the latest thought — tool calls and
 * other metadata arriving between thought chunks do not end the phase.
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

  let lastThought: number | null = null;
  for (let index = updates.length - 1; index >= 0; index--) {
    if (updates[index].kind === "agent_thought") {
      lastThought = index;
      break;
    }
  }

  if (lastThought === null) {
    return null;
  }

  // A final answer or a new user turn after the last thought ends reasoning.
  for (let index = lastThought + 1; index < updates.length; index++) {
    const kind = updates[index].kind;
    if (kind === "agent_text" || kind === "user_message") {
      return null;
    }
  }

  return lastThought;
}
