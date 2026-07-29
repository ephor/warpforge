import { useCallback } from "react";

import { daemon } from "../daemon";
import type { PromptSubmission, TaskInfo } from "../protocol";

export interface WorkflowSend {
  /** True when this task is a workflow parent — it has no agent session. */
  isWorkflow: boolean;
  /** True while the pipeline runs unattended: a message has no addressee. */
  disabled: boolean;
  /** `undefined` keeps the composer's own default placeholder. */
  placeholder: string | undefined;
  /**
   * Deliver a composed message. Returns true when it was handled as pipeline
   * input, so callers must not also prompt the (nonexistent) parent session.
   */
  send: (submission: PromptSubmission) => Promise<boolean>;
}

/**
 * Routing for messages typed into a workflow parent's composer.
 *
 * The parent task has no ACP session of its own — the daemon drives its stages
 * — so `session.prompt` would be rejected. A message is only meaningful at the
 * barriers where the pipeline is waiting for a human, and each barrier has its
 * own RPC. Shared by every composer that can be pointed at a task, so no
 * surface can accidentally fall through to the raw prompt path.
 */
export function useWorkflowSend(task: TaskInfo): WorkflowSend {
  const run = task.workflowRun ?? null;
  const waiting = run?.waiting ?? null;
  const finished = run?.stage === "done" || run?.stage === "failed";
  const disabled = !!run && !waiting;

  const send = useCallback(
    async (submission: PromptSubmission): Promise<boolean> => {
      if (!run) return false;
      const text = submission.text.trim();
      switch (waiting?.kind) {
        case "question":
          await daemon.workflowReply(task.id, text);
          return true;
        case "paused":
          await daemon.workflowResume(task.id, text || undefined);
          return true;
        case "limit":
          // Typed guidance rides along with one more round of fixes.
          await daemon.workflowDecide(task.id, "extend", {
            note: text || undefined,
            rounds: 1,
          });
          return true;
        default:
          // Nothing is listening: swallow rather than prompting a parent that
          // has no session (which fails with a raw daemon error).
          return true;
      }
    },
    [run, task.id, waiting],
  );

  return {
    disabled,
    isWorkflow: !!run,
    placeholder: placeholderFor(waiting?.kind, !!run, finished),
    send,
  };
}

function placeholderFor(
  kind: "question" | "limit" | "paused" | undefined,
  isWorkflow: boolean,
  finished: boolean,
): string | undefined {
  switch (kind) {
    case "question":
      return "Answer the stage's question…";
    case "paused":
      return "Add guidance for the next stage, then send to resume…";
    case "limit":
      return "Add guidance for another fix round, or pick an option above…";
    default:
      if (!isWorkflow) return undefined;
      return finished
        ? "This pipeline has finished — open a stage above to continue with that agent, or start a new task."
        : "The pipeline is running — open a stage above to message that agent.";
  }
}
