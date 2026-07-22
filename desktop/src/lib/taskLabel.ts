import type { TaskInfo } from "../protocol";

/**
 * What to show as a task's name. `title` is empty until the daemon derives one
 * from the prompt (and later until an agent rewrites it), so every surface
 * falls back to the raw prompt rather than rendering a blank row.
 */
export function taskLabel(task: Pick<TaskInfo, "title" | "prompt">): string {
  return task.title.trim() || task.prompt;
}
