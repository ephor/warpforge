import type { SessionUpdate } from "../protocol";

export function stampSessionUpdateStart(
  existing: SessionUpdate[],
  update: SessionUpdate,
  now: () => number = Date.now,
): SessionUpdate {
  if (update.kind !== "tool_call" || update.started_at !== undefined) return update;
  let previous: Extract<SessionUpdate, { kind: "tool_call" }> | undefined;
  for (let index = existing.length - 1; index >= 0; index--) {
    const item = existing[index];
    if (item.kind === "tool_call" && item.tool_call_id === update.tool_call_id) {
      previous = item;
      break;
    }
  }
  return {
    ...update,
    started_at: previous?.kind === "tool_call" ? (previous.started_at ?? now()) : now(),
  };
}

export function stampSessionHistoryStartTimes(updates: SessionUpdate[]) {
  // Historical rows from older daemons have no trustworthy start epoch. Do
  // not invent one at hydration time: that would reset elapsed on every open.
  return updates;
}
