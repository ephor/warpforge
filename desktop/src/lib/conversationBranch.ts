import type { SessionUpdate, TaskInfo } from "@/protocol";

/** Build the portable context handed to a new harness for a conversation fork. */
export function buildConversationBranchPrompt(
  task: TaskInfo,
  updates: SessionUpdate[],
  throughIndex: number,
): string {
  if (throughIndex < 0 || throughIndex >= updates.length) return "";
  const messages: string[] = [];
  for (let index = 0; index <= throughIndex; index += 1) {
    const update = updates[index];
    if (update.kind === "user_message") messages.push(`User:\n${update.text}`);
    if (update.kind === "agent_text") messages.push(`Assistant (${task.agent}):\n${update.text}`);
  }

  const workspace = task.worktree
    ? `The source task uses this worktree: ${task.worktree}`
    : `The source task uses the main ${task.project} project checkout.`;
  return [
    `Continue a branched conversation from Warpforge task ${task.id}.`,
    `Original task: ${task.prompt}`,
    workspace,
    "The transcript intentionally ends at the message where the branch was created. The original conversation remains active. Inspect the current repository state before making changes, then continue from this point.",
    "--- Branched conversation ---",
    messages.join("\n\n") || "(No user or assistant text was available before this branch point.)",
    "--- End branched conversation ---",
  ].join("\n\n");
}
