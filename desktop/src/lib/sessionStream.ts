import type { EditHunk, SessionUpdate, ToolCallStatus } from "../protocol";
import { preferToolTitle } from "./toolDisplay";

export const MAX_SESSION_UPDATES = 2000;
const TOOL_CONTENT_HEAD = 2048;
const TOOL_CONTENT_TAIL = 2048;
const TOOL_CONTENT_TRUNCATE_MARKER = "\n\n… truncated …\n\n";
const AGENT_TEXT_MAX = 20_000;
const AGENT_TEXT_KEEP_HEAD = 12_000;
const AGENT_TEXT_KEEP_TAIL = 6_000;

function isTerminalToolStatus(status: ToolCallStatus): boolean {
  return status === "completed" || status === "failed";
}

export function truncateToolContent(update: SessionUpdate): SessionUpdate {
  if (update.kind !== "tool_call" || !update.content) return update;
  if (!isTerminalToolStatus(update.status)) return update;
  const total = TOOL_CONTENT_HEAD + TOOL_CONTENT_TAIL + TOOL_CONTENT_TRUNCATE_MARKER.length;
  if (update.content.length <= total) return update;
  return {
    ...update,
    content:
      update.content.slice(0, TOOL_CONTENT_HEAD) +
      TOOL_CONTENT_TRUNCATE_MARKER +
      update.content.slice(-TOOL_CONTENT_TAIL),
  };
}

function truncateAgentText(text: string): string {
  if (text.length <= AGENT_TEXT_MAX) return text;
  return (
    text.slice(0, AGENT_TEXT_KEEP_HEAD) +
    TOOL_CONTENT_TRUNCATE_MARKER +
    text.slice(-AGENT_TEXT_KEEP_TAIL)
  );
}

export function capSessionUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  if (updates.length <= MAX_SESSION_UPDATES) return updates;
  return updates.slice(updates.length - MAX_SESSION_UPDATES);
}

/** Stable keys preserve row-local state while streamed blocks are coalesced. */
export function sessionUpdateKey(update: SessionUpdate, index: number): string {
  if (update.kind === "tool_call") return `tool:${update.tool_call_id}`;
  if (update.kind === "file_edit" && update.tool_call_id) return `edit:${update.tool_call_id}`;
  if (update.kind === "permission_request") return `perm:${update.request_id}`;
  if (update.kind === "permission_resolved") return `res:${update.request_id}`;
  return `i:${index}`;
}

export const RECONNECTING_TEXT = "Reconnecting to the saved agent session…";

export function isRenderableTranscriptUpdate(update: SessionUpdate): boolean {
  if (update.kind === "turn_ended") return false;
  if (update.kind === "agent_text" && update.text === RECONNECTING_TEXT) return false;
  return !["available_commands", "permission_resolved", "prompt_capabilities", "usage"].includes(
    update.kind,
  );
}

export function hasReconnectingTransient(updates: SessionUpdate[]): boolean {
  // Proper long-term fix would be a dedicated status update kind in the protocol.
  // For now the daemon sends this as agent_text; treat it as transient status.
  if (updates.length === 0) return false;
  const last = updates[updates.length - 1];
  return last.kind === "agent_text" && last.text === RECONNECTING_TEXT;
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

function hunksEqual(a?: EditHunk[], b?: EditHunk[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((hunk, i) => {
    const other = b[i];
    return (
      hunk.oldStart === other.oldStart &&
      hunk.oldLines === other.oldLines &&
      hunk.newStart === other.newStart &&
      hunk.newLines === other.newLines &&
      hunk.lines.length === other.lines.length &&
      hunk.lines.every((line, j) => line === other.lines[j])
    );
  });
}

function sessionUpdatesSemanticallyEqual(a: SessionUpdate, b: SessionUpdate): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  // Value-aware comparison for streaming-prone fields; avoids remount churn
  // when agent_text creates new object per token (previous.text + delta).
  switch (a.kind) {
    case "agent_text":
    case "agent_thought":
      return a.text === (b as typeof a).text;
    case "user_message":
      return a.text === (b as typeof a).text;
    case "tool_call":
      return (
        a.tool_call_id === (b as typeof a).tool_call_id &&
        a.status === (b as typeof a).status &&
        a.title === (b as typeof a).title &&
        a.content === (b as typeof a).content &&
        a.tool_kind === (b as typeof a).tool_kind &&
        a.started_at === (b as typeof a).started_at
      );
    case "file_edit":
      return (
        a.path === (b as typeof a).path &&
        a.additions === (b as typeof a).additions &&
        a.deletions === (b as typeof a).deletions &&
        a.tool_call_id === (b as typeof a).tool_call_id &&
        hunksEqual(a.hunks, (b as typeof a).hunks)
      );
    case "permission_request":
      return (
        a.request_id === (b as typeof a).request_id &&
        a.title === (b as typeof a).title &&
        a.options.length === (b as typeof a).options.length &&
        a.options.every((o, i) => o === (b as typeof a).options[i])
      );
    case "permission_resolved":
      return a.request_id === (b as typeof a).request_id && a.outcome === (b as typeof a).outcome;
    case "plan":
      return JSON.stringify(a.entries) === JSON.stringify((b as typeof a).entries);
    case "usage":
      return a.used === (b as typeof a).used && a.size === (b as typeof a).size;
    case "turn_ended":
      return a.stop_reason === (b as typeof a).stop_reason;
    case "workflow_event":
      return (
        a.event === (b as typeof a).event &&
        a.title === (b as typeof a).title &&
        a.detail === (b as typeof a).detail &&
        a.tone === (b as typeof a).tone
      );
    case "prompt_capabilities":
      return (
        a.image === (b as typeof a).image && a.embedded_context === (b as typeof a).embedded_context
      );
    case "available_commands":
      return a.commands === (b as typeof a).commands;
    default:
      // Reference equality for anything unforeseen; a new kind should be added
      // here rather than silently churning.
      return false;
  }
}

export function transcriptRowsAreEqual(
  previous: TranscriptListRow,
  next: TranscriptListRow,
): boolean {
  if (previous.kind !== next.kind || previous.id !== next.id) return false;
  if (previous.kind === "update" && next.kind === "update") {
    if (
      previous.entry.mergedIndex !== next.entry.mergedIndex ||
      previous.thinkingActive !== next.thinkingActive ||
      previous.textStreaming !== next.textStreaming
    )
      return false;
    if (previous.entry.update === next.entry.update) return true;
    return sessionUpdatesSemanticallyEqual(previous.entry.update, next.entry.update);
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
    output[output.length - 1] = {
      ...previous,
      text: truncateAgentText(previous.text + update.text),
    };
  } else if (update.kind === "tool_call") {
    const index = toolIndexes.get(update.tool_call_id);
    const existing = index !== undefined ? output[index] : undefined;
    if (existing?.kind === "tool_call") {
      const merged: SessionUpdate = {
        ...existing,
        content: update.content ?? existing.content,
        status: update.status,
        started_at: existing.started_at ?? update.started_at,
        title: preferToolTitle(existing, update),
        tool_kind: update.tool_kind || existing.tool_kind,
      };
      output[index!] = truncateToolContent(merged);
    } else {
      toolIndexes.set(update.tool_call_id, output.length);
      output.push(truncateToolContent(update));
    }
  } else if (update.kind === "permission_request") {
    // A request can be re-emitted (resume replay, a reconnect retry). Its row
    // key is the request id, so a second copy would collide in the transcript
    // list — fold it onto the first instead.
    const key = `perm:${update.request_id}`;
    const index = toolIndexes.get(key);
    if (index !== undefined && output[index].kind === "permission_request") {
      output[index] = update;
    } else {
      toolIndexes.set(key, output.length);
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
  return capSessionUpdates(output);
}

/** Append one live daemon update without retaining the raw streaming frame. */
export function appendCoalescedUpdate(
  existing: SessionUpdate[],
  update: SessionUpdate,
): SessionUpdate[] {
  const last = existing[existing.length - 1];

  if (
    (update.kind === "agent_text" || update.kind === "agent_thought") &&
    last?.kind === update.kind
  ) {
    const merged = { ...last, text: truncateAgentText(last.text + update.text) };
    const output = existing.slice(0, -1);
    output.push(merged);
    return output;
  }

  const output = existing.slice();
  const indexes = new Map<string, number>();
  if (update.kind === "permission_request") {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const candidate = output[index];
      if (candidate.kind === "permission_request" && candidate.request_id === update.request_id) {
        indexes.set(`perm:${update.request_id}`, index);
        break;
      }
    }
  } else if (update.kind === "tool_call") {
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
  return capSessionUpdates(output);
}

/**
 * Merge a task's freshly fetched full history with the live copy the
 * connection snapshot left behind.
 *
 * The snapshot tail is folded from a *raw row* window, so it is not a
 * positional suffix of the folded full history: a tool call whose first frames
 * fall before the window boundary folds into a later row in the tail than it
 * does in the full fold, which shifts every row after it. Aligning by position
 * therefore fails on real transcripts and stacks the whole tail a second time.
 * Walk the live copy forward through the fetch instead and keep only what
 * trails the last match — the updates that arrived while the fetch was in
 * flight.
 */
export function mergeSessionHistory(
  fetched: SessionUpdate[],
  live: SessionUpdate[],
): SessionUpdate[] {
  let cursor = 0;
  let lastMatched = -1;
  for (let index = 0; index < live.length; index += 1) {
    for (let candidate = cursor; candidate < fetched.length; candidate += 1) {
      if (sessionUpdatesSemanticallyEqual(live[index], fetched[candidate])) {
        cursor = candidate + 1;
        lastMatched = index;
        break;
      }
    }
  }
  return coalesceUpdates([...fetched, ...live.slice(lastMatched + 1)]);
}

/**
 * Coalesce only the tail of a session's raw updates. Used by Mission Control
 * tiles where the full history is not needed — only the last few renderable
 * items. A delta chain that starts before the window boundary is dropped
 * silently (acceptable: the tile shows a truncated tail, not a partial word).
 */
export function coalesceTailUpdates(updates: SessionUpdate[], tailSize: number): SessionUpdate[] {
  if (updates.length <= tailSize) return coalesceUpdates(updates);
  const start = updates.length - tailSize;
  const tail = updates.slice(start);
  const output: SessionUpdate[] = [];
  const toolIndexes = new Map<string, number>();
  for (const update of tail) appendCoalesced(output, toolIndexes, update);
  return output;
}
