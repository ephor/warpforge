import type { SessionUpdate } from "../protocol";
import { preferToolTitle } from "./toolDisplay";

/** Stable keys preserve row-local state while streamed blocks are coalesced. */
export function sessionUpdateKey(update: SessionUpdate, index: number): string {
  if (update.kind === "tool_call") return `tool:${update.tool_call_id}`;
  if (update.kind === "file_edit" && update.tool_call_id) return `edit:${update.tool_call_id}`;
  if (update.kind === "permission_request") return `perm:${update.request_id}`;
  if (update.kind === "permission_resolved") return `res:${update.request_id}`;
  return `i:${index}`;
}

export function isRenderableTranscriptUpdate(update: SessionUpdate): boolean {
  return !["available_commands", "permission_resolved", "prompt_capabilities", "usage"].includes(
    update.kind,
  );
}

export interface TranscriptEntry {
  mergedIndex: number;
  update: SessionUpdate;
}

export type TranscriptListRow =
  | {
      kind: "update";
      id: string;
      entry: TranscriptEntry;
      thinkingActive: boolean;
      textStreaming: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
    };

function isWorkUpdate(update: SessionUpdate): boolean {
  return ["agent_thought", "file_edit", "plan", "tool_call"].includes(update.kind);
}

function workEntryIsActive(entry: TranscriptEntry, thinkingIndex: number | null): boolean {
  if (entry.mergedIndex === thinkingIndex) return true;
  return (
    entry.update.kind === "tool_call" &&
    (entry.update.status === "pending" || entry.update.status === "in_progress")
  );
}

export function deriveTranscriptRows(
  updates: SessionUpdate[],
  expandedWorkGroups: ReadonlySet<string>,
  thinkingIndex: number | null,
  streamingTextIndex: number | null,
): TranscriptListRow[] {
  const rows: TranscriptListRow[] = [];
  let workEntries: TranscriptEntry[] = [];

  const pushUpdate = (entry: TranscriptEntry) => {
    rows.push({
      kind: "update",
      id: `update:${sessionUpdateKey(entry.update, entry.mergedIndex)}`,
      entry,
      thinkingActive: entry.mergedIndex === thinkingIndex,
      textStreaming: entry.mergedIndex === streamingTextIndex,
    });
  };

  const flushWork = () => {
    if (workEntries.length === 0) return;
    if (workEntries.length === 1) {
      pushUpdate(workEntries[0]);
      workEntries = [];
      return;
    }

    const groupId = `work:${sessionUpdateKey(workEntries[0].update, workEntries[0].mergedIndex)}`;
    const active = workEntries.some((entry) => workEntryIsActive(entry, thinkingIndex));
    const expanded = active || expandedWorkGroups.has(groupId);
    const visibleEntries = expanded ? workEntries : workEntries.slice(-1);
    for (const entry of visibleEntries) pushUpdate(entry);
    if (!active) {
      rows.push({
        kind: "work-toggle",
        id: `work-toggle:${groupId}`,
        groupId,
        hiddenCount: workEntries.length - 1,
        expanded,
      });
    }
    workEntries = [];
  };

  for (let mergedIndex = 0; mergedIndex < updates.length; mergedIndex += 1) {
    const update = updates[mergedIndex];
    if (!isRenderableTranscriptUpdate(update)) continue;
    const entry = { mergedIndex, update };
    if (isWorkUpdate(update)) {
      workEntries.push(entry);
    } else {
      flushWork();
      pushUpdate(entry);
    }
  }
  flushWork();
  return rows;
}

export function transcriptRowsAreEqual(
  previous: TranscriptListRow,
  next: TranscriptListRow,
): boolean {
  if (previous.kind !== next.kind || previous.id !== next.id) return false;
  if (previous.kind === "update" && next.kind === "update") {
    return (
      previous.entry.update === next.entry.update &&
      previous.entry.mergedIndex === next.entry.mergedIndex &&
      previous.thinkingActive === next.thinkingActive &&
      previous.textStreaming === next.textStreaming
    );
  }
  if (previous.kind === "work-toggle" && next.kind === "work-toggle") {
    return (
      previous.expanded === next.expanded &&
      previous.groupId === next.groupId &&
      previous.hiddenCount === next.hiddenCount
    );
  }
  return false;
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
        title: preferToolTitle(existing, update),
        tool_kind: update.tool_kind || existing.tool_kind,
      };
    } else {
      toolIndexes.set(update.tool_call_id, output.length);
      output.push(update);
    }
  } else if (update.kind === "file_edit" && update.tool_call_id) {
    const key = `edit:${update.tool_call_id}`;
    const index = toolIndexes.get(key);
    const existing = index !== undefined ? output[index] : undefined;
    if (existing?.kind === "file_edit") {
      output[index!] = {
        ...existing,
        path: update.path || existing.path,
        additions: update.additions ?? existing.additions,
        deletions: update.deletions ?? existing.deletions,
        hunks: update.hunks?.length ? update.hunks : existing.hunks,
      };
    } else {
      toolIndexes.set(key, output.length);
      output.push(update);
    }
  } else {
    output.push(update);
  }
}

/** Merge streaming chunks and repeated tool frames into semantic transcript rows. */
export function coalesceUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  const output: SessionUpdate[] = [];
  const toolIndexes = new Map<string, number>();
  for (const update of updates) appendCoalesced(output, toolIndexes, update);
  return output;
}

/** Append one live daemon update without retaining the raw streaming frame. */
export function appendCoalescedUpdate(
  existing: SessionUpdate[],
  update: SessionUpdate,
): SessionUpdate[] {
  const output = existing.slice();
  const indexes = new Map<string, number>();
  if (update.kind === "tool_call") {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const candidate = output[index];
      if (candidate.kind === "tool_call" && candidate.tool_call_id === update.tool_call_id) {
        indexes.set(update.tool_call_id, index);
        break;
      }
    }
  } else if (update.kind === "file_edit" && update.tool_call_id) {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const candidate = output[index];
      if (candidate.kind === "file_edit" && candidate.tool_call_id === update.tool_call_id) {
        indexes.set(`edit:${update.tool_call_id}`, index);
        break;
      }
    }
  }
  appendCoalesced(output, indexes, update);
  return output;
}
