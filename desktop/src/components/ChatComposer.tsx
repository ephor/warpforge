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
    const onSend = useCallback(
      async (submission: PromptSubmission) => {
        onBeforeSend();
        await daemon.request("session.prompt", { task_id: task.id, ...submission });
      },
      [onBeforeSend, task.id],
    );

    return (
      <Composer
        ref={ref}
        commands={commands}
        contextUsage={contextUsage}
        files={files}
        filesLoading={filesLoading}
        imageSupported={imageSupported}
        disabled={task.status === "done"}
        onSend={onSend}
        toolbar={
          task.configOptions && task.configOptions.length > 0 ? (
            <AgentConfigBar taskId={task.id} options={task.configOptions} />
          ) : undefined
        }
      />
    );
  }),
);
