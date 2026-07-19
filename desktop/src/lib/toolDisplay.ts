import type { SessionUpdate } from "../protocol";

type ToolCall = Extract<SessionUpdate, { kind: "tool_call" }>;

export function fallbackToolTitle(kind: string): string {
  switch (kind) {
    case "execute":
      return "Run command";
    case "read":
      return "Read file";
    case "edit":
      return "Edit file";
    case "delete":
      return "Delete file";
    case "move":
      return "Move file";
    case "search":
      return "Search workspace";
    case "fetch":
      return "Fetch resource";
    case "think":
      return "Think";
    default:
      return "Use tool";
  }
}

export function isPlaceholderToolTitle(title: string, id: string, kind: string): boolean {
  const normalized = title.trim();
  return !normalized || normalized === id || normalized === fallbackToolTitle(kind);
}

export function toolDisplayTitle(update: ToolCall): string {
  return isPlaceholderToolTitle(update.title, update.tool_call_id, update.tool_kind)
    ? fallbackToolTitle(update.tool_kind)
    : update.title;
}

export function preferToolTitle(existing: ToolCall, incoming: ToolCall): string {
  if (isPlaceholderToolTitle(incoming.title, incoming.tool_call_id, incoming.tool_kind)) {
    return existing.title;
  }
  return incoming.title;
}
