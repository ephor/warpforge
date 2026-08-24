import type { TaskBadgeStatus } from "../components/StatusBadge";
import { type AttentionItem } from "./attentionRail";
import { awaitsReview } from "./taskGroups";

export function attentionStatus(item: AttentionItem): TaskBadgeStatus {
  if (item.permission) return "permission";
  if (item.task.workflowRun?.waiting) return "blocked";
  return item.task.status;
}

export function attentionAction(item: AttentionItem): string {
  if (item.permission) return "Permission";
  if (item.task.workflowRun?.waiting?.kind === "question") return "Answer";
  if (item.task.workflowRun?.waiting?.kind === "limit") return "Choose next step";
  if (awaitsReview(item.task)) return "Review";
  return "Unblock";
}
