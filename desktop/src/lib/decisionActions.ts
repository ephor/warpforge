import type { AttentionItem } from "@/lib/attentionRail";

export type DecisionActionKind =
  | "permission" // approve/reject from item.permission.options
  | "question" // free-text reply via workflowReply
  | "limit"; // workflowDecide "extend"/"finish" quick actions

/**
 * Inline actions a decision-queue row supports, derived purely from the item.
 * Blocked/interrupted/paused rows get none — their only affordance is opening
 * the task.
 */
export function decisionActionKinds(item: AttentionItem): DecisionActionKind[] {
  if (item.permission) return ["permission"];
  const kind = item.task.workflowRun?.waiting?.kind;
  if (kind === "question") return ["question"];
  if (kind === "limit") return ["limit"];
  return [];
}

/** Best option to treat as "approve": the explicit allow spellings first. */
export function permissionApproveOption(options: readonly string[]): string | undefined {
  for (const preferred of ["allow_once", "allow", "allow_always"]) {
    if (options.includes(preferred)) return preferred;
  }
  return options.find((option) => option.includes("allow"));
}
