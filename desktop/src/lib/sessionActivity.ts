import { SessionUpdate, TaskInfo } from "../protocol";
import { pendingPermission } from "./sessionPermissions";

export type SessionActivity = {
  label: string;
  detail: string;
  tone: "thinking" | "working" | "writing";
};

export function sessionActivity(
  task: Pick<TaskInfo, "status">,
  updates: SessionUpdate[],
): SessionActivity | null {
  if (task.status !== "running" && task.status !== "queued") return null;
  if (pendingPermission(updates)) return null;

  const visible = updates.filter(
    (u) => u.kind !== "available_commands" && u.kind !== "permission_resolved",
  );
  const last = visible[visible.length - 1];
  if (last?.kind === "turn_ended") return null;

  const activeTool = [...updates]
    .reverse()
    .find(
      (u): u is Extract<SessionUpdate, { kind: "tool_call" }> =>
        u.kind === "tool_call" && (u.status === "pending" || u.status === "in_progress"),
    );
  if (activeTool) {
    return {
      label: activeTool.tool_kind === "execute" ? "forging" : "working",
      detail: activeTool.title,
      tone: "working",
    };
  }

  if (!last) {
    return { label: "warming up", detail: "starting the agent session", tone: "thinking" };
  }

  switch (last.kind) {
    case "user_message":
      return { label: "thinking", detail: "reading your instruction", tone: "thinking" };
    case "agent_thought":
      return { label: "thinking", detail: "planning the next move", tone: "thinking" };
    case "agent_text":
      return { label: "writing", detail: "streaming a response", tone: "writing" };
    case "tool_call":
      return {
        label: last.status === "failed" ? "recovering" : "warping",
        detail: last.status === "failed" ? "checking the failed tool call" : "checking tool output",
        tone: "working",
      };
    case "file_edit":
      return {
        label: "forging",
        detail: `updated ${last.path.split("/").pop() || last.path}`,
        tone: "working",
      };
    case "plan":
      return { label: "mapping", detail: "updating the plan", tone: "thinking" };
    case "permission_request":
      return null;
    default:
      return { label: "working", detail: "waiting for the next update", tone: "working" };
  }
}
