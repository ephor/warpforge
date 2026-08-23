import type { SessionUpdate, TaskInfo } from "../protocol";
import { latestPendingPermission } from "./sessionPermissions";
import { latestSessionPreview } from "./sessionPreview";
import { sessionActivity, type SessionActivity } from "./sessionActivity";
import { coalesceTailUpdates } from "./sessionStream";

export interface LiveStripItem {
  taskId: string;
  title: string;
  label: string;
  detail: string;
  tone: SessionActivity["tone"];
  previewText: string | null;
  startedAt: number | null;
  toolCount: number;
}

export function buildLiveStripItems(
  tasks: TaskInfo[],
  updatesByTaskId: Record<string, SessionUpdate[]>,
  excludeTaskIds: ReadonlySet<string>,
): LiveStripItem[] {
  const items: LiveStripItem[] = [];
  for (const task of tasks) {
    if (excludeTaskIds.has(task.id)) continue;
    if (task.status !== "running") continue;
    const updates = updatesByTaskId[task.id] ?? [];
    // Don't show permission-blocked tasks in Live — they belong in Needs you
    if (latestPendingPermission(task.id, updates)) continue;
    const tail = coalesceTailUpdates(updates, 300);
    const activity = sessionActivity(task, tail);
    if (!activity) {
      const isTurnEnded = tail.length > 0 && tail[tail.length - 1]?.kind === "turn_ended";
      if (isTurnEnded) continue;
    }
    const preview = latestSessionPreview(updates, { active: true });
    const toolCount = tail.filter((u) => u.kind === "tool_call").length;
    items.push({
      detail: activity?.detail ?? "",
      label: activity?.label ?? "working",
      previewText: preview?.text ?? null,
      startedAt: activity?.startedAt ?? null,
      taskId: task.id,
      title: task.title,
      tone: activity?.tone ?? "working",
      toolCount,
    });
  }
  items.sort((a, b) => {
    const aTime = a.startedAt ?? Infinity;
    const bTime = b.startedAt ?? Infinity;
    if (aTime !== bTime) return aTime - bTime;
    return a.taskId.localeCompare(b.taskId);
  });
  return items;
}

export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - startedAtMs);
  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}


