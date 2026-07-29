import type { WorkflowRunInfo } from "@/protocol";

export function workflowStageLabel(stage: WorkflowRunInfo["stage"]): string {
  switch (stage) {
    case "plan":
      return "planning";
    case "implement":
      return "implementing";
    case "review":
      return "reviewing";
    case "fix":
      return "fixing";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      // A newer daemon may report a stage this build does not know; show the
      // raw value rather than silently rendering nothing.
      return stage;
  }
}
