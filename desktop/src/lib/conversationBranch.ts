import type { SessionUpdate, TaskInfo } from "@/protocol";

/** Longest tool output kept per call — one result can be a whole file. */
const TOOL_CONTENT_LIMIT = 400;

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Flatten a conversation up to `throughIndex` into text.
 *
 * Keeps tool calls and edits, not only the messages: which command failed and
 * which files were touched is the "where did work stop" detail that a
 * messages-only dump loses, and it is what the next session needs most.
 */
export function renderTranscript(updates: SessionUpdate[], throughIndex: number): string {
  const entries: string[] = [];
  // Clamp rather than trust the caller: a dialog can outlive the transcript it
  // was opened over — archiving the task empties it — and reading past the end
  // would throw on `update.kind`.
  const last = Math.min(throughIndex, updates.length - 1);
  for (let index = 0; index <= last; index += 1) {
    const update = updates[index];
    if (update.kind === "user_message" && update.text.trim()) {
      entries.push(`## Developer\n${update.text.trim()}`);
    }
    if (update.kind === "agent_text" && update.text.trim()) {
      entries.push(`## Agent\n${update.text.trim()}`);
    }
    if (update.kind === "tool_call") {
      const content = update.content?.trim();
      const detail = content ? `\n    ${clamp(content, TOOL_CONTENT_LIMIT)}` : "";
      entries.push(`- tool [${update.status}] ${update.title}${detail}`);
    }
    if (update.kind === "file_edit") {
      const counts =
        update.additions != null && update.deletions != null
          ? ` (+${update.additions} -${update.deletions})`
          : "";
      entries.push(`- edit ${update.path}${counts}`);
    }
  }
  return entries.join("\n\n");
}

/** Files the source session edited up to `throughIndex`. */
function filesTouched(updates: SessionUpdate[], throughIndex: number): string[] {
  const paths = new Set<string>();
  const last = Math.min(throughIndex, updates.length - 1);
  for (let index = 0; index <= last; index += 1) {
    const update = updates[index];
    if (update.kind === "file_edit") paths.add(update.path);
  }
  return [...paths].sort();
}

/** Build the portable context handed to a new harness for a conversation fork. */
export function buildConversationBranchPrompt(
  task: TaskInfo,
  updates: SessionUpdate[],
  throughIndex: number,
): string {
  if (throughIndex < 0 || throughIndex >= updates.length) return "";
  const transcript = renderTranscript(updates, throughIndex);

  const workspace = task.worktree
    ? `The source task uses this worktree: ${task.worktree}`
    : `The source task uses the main ${task.project} project checkout.`;

  const paths = filesTouched(updates, throughIndex);
  const files =
    paths.length > 0
      ? [`Files touched in the source session:`, ...paths.map((path) => `- ${path}`)].join("\n")
      : "";

  return [
    `Continue a branched conversation from Warpforge task ${task.id}.`,
    `Original task: ${task.prompt}`,
    workspace,
    ...(files ? [files] : []),
    "The transcript intentionally ends at the message where the branch was created. The original conversation remains active. Inspect the current repository state before making changes, then continue from this point.",
    "--- Branched conversation ---",
    transcript || "(No user or assistant text was available before this branch point.)",
    "--- End branched conversation ---",
  ].join("\n\n");
}
