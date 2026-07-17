import type { SessionUpdate } from "../protocol";

export interface SessionPreview {
  kind: "message" | "thought" | "tool" | "file" | "plan";
  label: string;
  text: string;
  truncated: boolean;
}

export interface SessionPreviewOptions {
  active: boolean;
  expanded?: boolean;
}

// About 5–6 lines at the rail width. Expansion remains deliberately bounded.
const COLLAPSED_CHARS = 288;
const EXPANDED_CHARS = 900;
const ACTIVE_SCAN_LIMIT = 512;

function cleanText(text: string): string {
  return text
    .replace(/```[\w-]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)(?:#{1,6}|>|[-+*])\s+/gm, "$1")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedText(
  text: string,
  direction: "start" | "tail",
  maxChars: number,
  knownPrefixTruncated = false,
): { text: string; truncated: boolean } {
  const cleaned = cleanText(text);
  const truncated = knownPrefixTruncated || cleaned.length > maxChars;
  if (!truncated) return { text: cleaned, truncated: false };

  if (direction === "start") {
    const prefix = cleaned.slice(0, maxChars);
    const lastSpace = prefix.lastIndexOf(" ");
    return { text: `${prefix.slice(0, lastSpace > 0 ? lastSpace : maxChars)}…`, truncated: true };
  }

  const suffix = cleaned.slice(-maxChars);
  const sentenceStart = suffix.search(/[.!?]\s+[A-ZА-ЯІЇЄҐ0-9]/u);
  if (sentenceStart >= 0 && sentenceStart < 100) {
    return { text: `…${suffix.slice(sentenceStart + 2)}`, truncated: true };
  }
  const firstSpace = suffix.indexOf(" ");
  return {
    text: `…${suffix.slice(firstSpace >= 0 ? firstSpace + 1 : 0)}`,
    truncated: true,
  };
}

function textPreview(
  updates: SessionUpdate[],
  index: number,
  kind: "agent_text" | "agent_thought",
  active: boolean,
  maxChars: number,
): SessionPreview | null {
  let combined = "";
  let truncatedBeforeScan = false;

  if (active) {
    const lowerBound = Math.max(0, index - ACTIVE_SCAN_LIMIT + 1);
    for (let cursor = index; cursor >= lowerBound; cursor -= 1) {
      const chunk = updates[cursor];
      if (chunk.kind !== kind) break;
      combined = chunk.text + combined;
      if (combined.length >= maxChars * 2) {
        truncatedBeforeScan = cursor > 0 && updates[cursor - 1]?.kind === kind;
        break;
      }
      if (cursor === lowerBound && cursor > 0 && updates[cursor - 1]?.kind === kind) {
        truncatedBeforeScan = true;
      }
    }
  } else {
    // Completion is a low-frequency transition, so find the beginning of only
    // the final contiguous assistant message, then read a bounded prefix.
    let start = index;
    while (start > 0 && updates[start - 1]?.kind === kind) start -= 1;
    for (let cursor = start; cursor <= index; cursor += 1) {
      const chunk = updates[cursor];
      if (chunk.kind !== kind) break;
      combined += chunk.text;
      if (combined.length >= maxChars * 2) break;
    }
  }

  const bounded = boundedText(combined, active ? "tail" : "start", maxChars, truncatedBeforeScan);
  if (!bounded.text) return null;
  return {
    kind: kind === "agent_text" ? "message" : "thought",
    label: kind === "agent_text" ? "Latest response" : "Latest thought",
    ...bounded,
  };
}

/**
 * Active sessions read only a bounded stream tail per token. Completed/idle
 * sessions find the start of the final assistant message once, without
 * coalescing history or rendering Markdown.
 */
export function latestSessionPreview(
  updates: SessionUpdate[] | undefined,
  { active, expanded = false }: SessionPreviewOptions,
): SessionPreview | null {
  if (!updates?.length) return null;
  const maxChars = expanded ? EXPANDED_CHARS : COLLAPSED_CHARS;
  const lowerBound = active ? Math.max(0, updates.length - ACTIVE_SCAN_LIMIT) : 0;

  for (let index = updates.length - 1; index >= lowerBound; index -= 1) {
    const update = updates[index];
    if (
      update.kind === "available_commands" ||
      update.kind === "permission_request" ||
      update.kind === "permission_resolved" ||
      update.kind === "prompt_capabilities" ||
      update.kind === "turn_ended"
    ) {
      continue;
    }

    if (update.kind === "agent_text" || update.kind === "agent_thought") {
      const preview = textPreview(updates, index, update.kind, active, maxChars);
      if (preview) return preview;
      continue;
    }
    if (update.kind === "user_message") {
      const bounded = boundedText(update.text, active ? "tail" : "start", maxChars);
      if (bounded.text) {
        return { kind: "message", label: "Latest message", ...bounded };
      }
      continue;
    }
    if (update.kind === "tool_call") {
      return {
        kind: "tool",
        label: "Latest tool",
        text: `${update.title} · ${update.status.replaceAll("_", " ")}`,
        truncated: false,
      };
    }
    if (update.kind === "file_edit") {
      return { kind: "file", label: "Latest edit", text: update.path, truncated: false };
    }
    if (update.kind === "plan") {
      const done = update.entries.filter((entry) => entry.status === "completed").length;
      return {
        kind: "plan",
        label: "Latest plan",
        text: `${done}/${update.entries.length} complete`,
        truncated: false,
      };
    }
  }
  return null;
}
