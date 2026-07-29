import { forwardRef, memo, useCallback } from "react";

import { daemon } from "../daemon";
import type { ContextUsage } from "../lib/sessionUsage";
import type { CommandInfo, ProjectFile, PromptSubmission, TaskInfo } from "../protocol";
import { AgentConfigBar } from "./AgentConfigBar";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";

interface Props {
  commands: CommandInfo[];
  files: ProjectFile[];
  filesLoading: boolean;
  imageSupported: boolean;
  contextUsage?: ContextUsage;
  onBeforeSend: () => void;
  task: TaskInfo;
}

export const ChatComposer = memo(
  forwardRef<ComposerHandle, Props>(function ChatComposer(
    { commands, contextUsage, files, filesLoading, imageSupported, onBeforeSend, task },
    ref,
  ) {
    // A workflow parent has no agent session: its messages steer the pipeline
    // instead, and are only accepted at the points where the daemon is waiting
    // for a human (see WorkflowControls for the button-driven half).
    const run = task.workflowRun ?? null;
    const waiting = run?.waiting ?? null;

    const onSend = useCallback(
      async (submission: PromptSubmission) => {
        onBeforeSend();
        const text = submission.text.trim();
        if (waiting) {
          switch (waiting.kind) {
            case "question":
              await daemon.workflowReply(task.id, text);
              return;
            case "paused":
              await daemon.workflowResume(task.id, text || undefined);
              return;
            case "limit":
              // Typed guidance rides along with one more round of fixes.
              await daemon.workflowDecide(task.id, "extend", {
                note: text || undefined,
                rounds: 1,
              });
              return;
          }
        }
        await daemon.request("session.prompt", { task_id: task.id, ...submission });
      },
      [onBeforeSend, task.id, waiting],
    );

    // For a workflow parent the daemon maps task.cancel onto stopping the
    // whole pipeline, so the composer's stop button stays the terminal
    // "kill it" affordance next to WorkflowControls' soft pause.
    const onCancel = useCallback(
      () => void daemon.request("task.cancel", { task_id: task.id }),
      [task.id],
    );

    const isRunning = task.status === "running" || task.status === "queued";
    // While a pipeline runs unattended there is nobody to read a message —
    // intervene in a stage's own session (Subtasks) instead.
    const workflowBusy = !!run && !waiting && run.stage !== "done" && run.stage !== "failed";

    return (
      <Composer
        ref={ref}
        commands={commands}
        contextUsage={contextUsage}
        files={files}
        filesLoading={filesLoading}
        imageSupported={imageSupported}
        disabled={task.status === "done" || workflowBusy}
        onSend={onSend}
        onCancel={isRunning ? onCancel : undefined}
        placeholder={workflowPlaceholder(waiting?.kind, workflowBusy)}
        toolbar={
          task.configOptions && task.configOptions.length > 0 ? (
            <AgentConfigBar taskId={task.id} options={task.configOptions} />
          ) : undefined
        }
      />
    );
  }),
);

/** `undefined` keeps the Composer's own default for non-workflow tasks. */
function workflowPlaceholder(
  kind: "question" | "limit" | "paused" | undefined,
  busy: boolean,
): string | undefined {
  if (busy) return "The pipeline is running — open a stage under Subtasks to steer it.";
  switch (kind) {
    case "question":
      return "Answer the stage's question…";
    case "paused":
      return "Add guidance for the next stage, then send to resume…";
    case "limit":
      return "Add guidance for another fix round, or pick an option above…";
    default:
      return undefined;
  }
}
