import type { CommandInfo, SessionUpdate } from "../protocol";

export function latestCommands(updates: SessionUpdate[]): CommandInfo[] {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const update = updates[i];
    if (update.kind === "available_commands") {
      return update.commands;
    }
  }
  return [];
}

export function summarizeTools(updates: SessionUpdate[]): {
  total: number;
  active: number;
  failed: number;
} {
  const tools = updates.filter(
    (u): u is Extract<SessionUpdate, { kind: "tool_call" }> => u.kind === "tool_call",
  );
  return {
    active: tools.filter((t) => t.status === "pending" || t.status === "in_progress").length,
    failed: tools.filter((t) => t.status === "failed").length,
    total: tools.length,
  };
}

export function summarizeFiles(updates: SessionUpdate[]): string[] {
  const seen = new Set<string>();
  for (const update of updates) {
    if (update.kind === "file_edit") {
      seen.add(update.path.split("/").pop() || update.path);
    }
  }
  return Array.from(seen);
}
