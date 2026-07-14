import type { SessionUpdate, TaskInfo } from "../protocol";
import { pendingPermission } from "./sessionPermissions";

export interface SessionActivity {
  label: string;
  detail: string;
  tone: "thinking" | "working" | "writing";
}

export function sessionActivity(
  task: Pick<TaskInfo, "status">,
  updates: SessionUpdate[],
): SessionActivity | null {
  if (task.status !== "running" && task.status !== "queued") {
    return null;
  }
  if (pendingPermission(updates)) {
    return null;
  }

  const visible = updates.filter(
    (u) => u.kind !== "available_commands" && u.kind !== "permission_resolved",
  );
  const last = visible[visible.length - 1];
  if (last?.kind === "turn_ended") {
    return null;
  }

  const activeTool = [...updates]
    .reverse()
    .find(
      (u): u is Extract<SessionUpdate, { kind: "tool_call" }> =>
        u.kind === "tool_call" && (u.status === "pending" || u.status === "in_progress"),
    );
  if (activeTool) {
    return {
      detail: activeTool.title,
      label: activeTool.tool_kind === "execute" ? "forging" : "working",
      tone: "working",
    };
  }

  if (!last) {
    return { detail: "starting the agent session", label: "warming up", tone: "thinking" };
  }

  switch (last.kind) {
    case "user_message":
      return { detail: "reading your instruction", label: "thinking", tone: "thinking" };
    case "agent_thought":
      return { detail: "planning the next move", label: "thinking", tone: "thinking" };
    case "agent_text":
      return { detail: "streaming a response", label: "writing", tone: "writing" };
    case "tool_call":
      return {
        detail: last.status === "failed" ? "checking the failed tool call" : "checking tool output",
        label: last.status === "failed" ? "recovering" : "warping",
        tone: "working",
      };
    case "file_edit":
      return {
        detail: `updated ${last.path.split("/").pop() || last.path}`,
        label: "forging",
        tone: "working",
      };
    case "plan":
      return { detail: "updating the plan", label: "mapping", tone: "thinking" };
    case "permission_request":
      return null;
    default:
      return { detail: "waiting for the next update", label: "working", tone: "working" };
  }
}
