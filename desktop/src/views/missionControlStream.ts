import type { SessionUpdate } from "../protocol";

/** Stable keys preserve row-local state while streamed blocks are coalesced. */
export function streamKey(update: SessionUpdate, index: number): string {
  if (update.kind === "tool_call") return `tool:${update.tool_call_id}`;
  if (update.kind === "permission_request") return `perm:${update.request_id}`;
  if (update.kind === "permission_resolved") return `res:${update.request_id}`;
  return `i:${index}`;
}

/** Fold one raw update into an in-progress coalesced stream. */
export function appendCoalesced(
  output: SessionUpdate[],
  toolIndexes: Map<string, number>,
  update: SessionUpdate,
): void {
  const previous = output[output.length - 1];
  if (
    (update.kind === "agent_text" || update.kind === "agent_thought") &&
    previous?.kind === update.kind
  ) {
    output[output.length - 1] = { ...previous, text: previous.text + update.text };
  } else if (update.kind === "tool_call") {
    const index = toolIndexes.get(update.tool_call_id);
    const existing = index !== undefined ? output[index] : undefined;
    if (existing?.kind === "tool_call") {
      output[index!] = {
        ...existing,
        content: update.content ?? existing.content,
        status: update.status,
        started_at: existing.started_at ?? update.started_at,
        title: update.title || existing.title,
        tool_kind: update.tool_kind || existing.tool_kind,
      };
    } else {
      toolIndexes.set(update.tool_call_id, output.length);
      output.push(update);
    }
  } else {
    output.push(update);
  }
}

/** Merge streaming text chunks and repeated tool frames into renderable rows. */
export function coalesceUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  const output: SessionUpdate[] = [];
  const toolIndexes = new Map<string, number>();
  for (const update of updates) appendCoalesced(output, toolIndexes, update);
  return output;
}
