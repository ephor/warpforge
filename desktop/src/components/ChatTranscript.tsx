import { ArrowDown } from "lucide-react";
import { memo, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatFollow } from "@/hooks/useChatFollow";
import type { SessionActivity } from "@/lib/sessionActivity";
import { resolvedPermissions } from "@/lib/sessionPermissions";
import { activeThinkingIndex } from "@/lib/sessionThinking";

import type { CommandInfo, ProjectFile, SessionUpdate, TaskInfo } from "../protocol";
import { StreamLine, coalesceUpdates, streamKey } from "../views/MissionControl";
import { AgentActivityIndicator } from "./AgentActivityIndicator";
import { ChatComposer } from "./ChatComposer";
import type { ComposerHandle } from "./Composer";

interface Props {
  activity: SessionActivity | null;
  active: boolean;
  commands: CommandInfo[];
  composerRef: React.Ref<ComposerHandle>;
  files: ProjectFile[];
  filesLoading: boolean;
  imageSupported: boolean;
  onOpenFile: (path: string) => void;
  resolveFilePath: (value: string) => string | null;
  task: TaskInfo;
  updates: SessionUpdate[];
}

/** Native-flow transcript boundary; future virtualization belongs here at turn granularity. */
export const ChatTranscript = memo(function ChatTranscript({
  activity,
  active,
  commands,
  composerRef,
  files,
  filesLoading,
  imageSupported,
  onOpenFile,
  resolveFilePath,
  task,
  updates,
}: Props) {
  const merged = useMemo(() => coalesceUpdates(updates), [updates]);
  const thinkingIndex = useMemo(() => {
    if (activeThinkingIndex(updates, task.status) === null) return null;
    for (let index = merged.length - 1; index >= 0; index--) {
      if (merged[index].kind === "agent_thought") return index;
    }
    return null;
  }, [merged, task.status, updates]);
  const resolved = useMemo(() => resolvedPermissions(updates), [updates]);
  const { contentRef, following, resume, scrollHandlers, scrollRef } = useChatFollow(
    active,
    task.id,
  );

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          {...scrollHandlers}
          tabIndex={0}
          className="h-full min-w-0 overflow-y-auto px-4 py-4 pb-14 text-sm [overflow-anchor:none]"
        >
          <div ref={contentRef}>
            {merged.length === 0 ? (
              <p className="text-muted-foreground">No session activity yet.</p>
            ) : (
              <div className="w-full">
                {merged.map((update, index) => (
                  <div key={streamKey(update, index)} className="pb-3">
                    <StreamLine
                      update={update}
                      thinkingActive={index === thinkingIndex}
                      taskId={task.id}
                      resolved={resolved}
                      resolveFilePath={resolveFilePath}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                ))}
              </div>
            )}
            {activity && (
              <div className="pt-3">
                <AgentActivityIndicator activity={activity} />
              </div>
            )}
          </div>
        </div>
        {!following && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="absolute bottom-3 right-4 z-20 size-9 rounded-full bg-background text-muted-foreground shadow-sm hover:text-foreground"
                aria-label="Scroll to latest message"
                onClick={resume}
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Latest message</TooltipContent>
          </Tooltip>
        )}
      </div>
      <ChatComposer
        ref={composerRef}
        commands={commands}
        files={files}
        filesLoading={filesLoading}
        imageSupported={imageSupported}
        onBeforeSend={resume}
        task={task}
      />
    </>
  );
});
