import type { SessionUpdate, TaskInfo } from "../protocol";
import { pendingPermission } from "./sessionPermissions";
import { toolDisplayTitle } from "./toolDisplay";

export interface SessionActivity {
  label: string;
  detail: string;
  tone: "thinking" | "working" | "writing";
  toolCallId?: string;
  startedAt?: number;
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

  // Only the newest chronological phase may drive activity. Looking backwards
  // for any pending frame resurrects old calls after a newer completion.
  const activeTool =
    last?.kind === "tool_call" && (last.status === "pending" || last.status === "in_progress")
      ? last
      : null;
  if (activeTool) {
    return {
      detail: toolDisplayTitle(activeTool),
      label: activeTool.tool_kind === "execute" ? "forging" : "working",
      startedAt: activeTool.started_at,
      tone: "working",
      toolCallId: activeTool.tool_call_id,
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
