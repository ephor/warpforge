import { ArrowDown } from "lucide-react";
import { memo, useCallback, useMemo, useRef } from "react";

import type { FileLinkResolver } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatFollow } from "@/hooks/useChatFollow";
import { buildConversationBranchPrompts } from "@/lib/conversationBranch";
import type { SessionActivity } from "@/lib/sessionActivity";
import { resolvedPermissions } from "@/lib/sessionPermissions";
import { activeThinkingIndex } from "@/lib/sessionThinking";

import { daemon } from "../daemon";
import type { AgentConfig, CommandInfo, ProjectFile, SessionUpdate, TaskInfo } from "../protocol";
import { StreamLine } from "../views/MissionControl";
import { appendCoalesced, coalesceUpdates, streamKey } from "../views/missionControlStream";
import { AgentActivityIndicator } from "./AgentActivityIndicator";
import { ChatComposer } from "./ChatComposer";
import type { ComposerHandle } from "./Composer";
import { MessageActions } from "./MessageActions";

/**
 * Coalesce an append-only update stream incrementally. The daemon only ever
 * appends to a task's history, so on a subword delta we fold just the new tail
 * onto the previous merged result instead of rebuilding (and re-concatenating
 * every historical message) from scratch — O(new deltas) instead of O(history)
 * per token. Unchanged blocks keep their object identity so their memoized rows
 * skip re-rendering.
 */
function useCoalesced(updates: SessionUpdate[]): SessionUpdate[] {
  const cache = useRef<{
    src: SessionUpdate[];
    merged: SessionUpdate[];
    toolAt: Map<string, number>;
  } | null>(null);

  return useMemo(() => {
    const prev = cache.current;
    const isAppend =
      prev !== null &&
      updates.length >= prev.src.length &&
      (prev.src.length === 0 || updates[prev.src.length - 1] === prev.src[prev.src.length - 1]);

    if (isAppend && prev) {
      if (updates.length === prev.src.length) {
        return prev.merged;
      }
      const merged = prev.merged.slice();
      const toolAt = new Map(prev.toolAt);
      for (let i = prev.src.length; i < updates.length; i += 1) {
        appendCoalesced(merged, toolAt, updates[i]);
      }
      cache.current = { merged, src: updates, toolAt };
      return merged;
    }

    const merged = coalesceUpdates(updates);
    const toolAt = new Map<string, number>();
    for (let i = 0; i < merged.length; i += 1) {
      const u = merged[i];
      if (u.kind === "tool_call") toolAt.set(u.tool_call_id, i);
    }
    cache.current = { merged, src: updates, toolAt };
    return merged;
  }, [updates]);
}

/**
 * Keep a stable `resolved` map reference while its contents are unchanged, so
 * memoized rows don't re-render on every streaming delta (which produces a new
 * `updates` array but no new permission outcomes).
 */
function useStableResolved(updates: SessionUpdate[]): Record<string, string> {
  const ref = useRef<Record<string, string>>({});
  return useMemo(() => {
    const next = resolvedPermissions(updates);
    const prev = ref.current;
    const prevKeys = Object.keys(prev);
    const same =
      prevKeys.length === Object.keys(next).length &&
      prevKeys.every((key) => prev[key] === next[key]);
    if (same) {
      return prev;
    }
    ref.current = next;
    return next;
  }, [updates]);
}

/**
 * One transcript row. Memoized so that during streaming only the block whose
 * object identity changed (the growing text/thought run, or a tool card taking
 * a new frame) re-renders — historical rows keep their identity and skip the
 * expensive Markdown re-parse entirely.
 */
const TranscriptRow = memo(function TranscriptRow({
  update,
  thinkingActive,
  taskId,
  resolved,
  resolveFilePath,
  onOpenFile,
  agents,
  branchPrompt,
  onOpenTask,
  project,
  sourceTaskId,
}: {
  update: SessionUpdate;
  thinkingActive: boolean;
  taskId: string;
  resolved: Record<string, string>;
  resolveFilePath: FileLinkResolver;
  onOpenFile: (path: string) => void;
  agents: AgentConfig[];
  branchPrompt?: string;
  onOpenTask: (id: string) => void;
  project: string;
  sourceTaskId: string;
}) {
  const continueConversation = useCallback(
    async (agent: string) => {
      if (!branchPrompt) return;
      const result = await daemon.request("task.create", {
        agent,
        attachments: [],
        include_runtime_context: true,
        project,
        prompt: branchPrompt,
        tags: ["conversation-branch", `branched-from:${sourceTaskId}`],
        worktree: true,
      });
      const taskId = (result as { taskId?: string })?.taskId;
      if (!taskId) throw new Error("Warpforge did not return the new task id");
      onOpenTask(taskId);
    },
    [branchPrompt, onOpenTask, project, sourceTaskId],
  );
  const messageText =
    update.kind === "user_message" || update.kind === "agent_text" ? update.text : null;

  return (
    <div className="group/message relative">
      <StreamLine
        update={update}
        thinkingActive={thinkingActive}
        taskId={taskId}
        resolved={resolved}
        resolveFilePath={resolveFilePath}
        onOpenFile={onOpenFile}
      />
      {messageText && (
        <div className="absolute right-0 bottom-0 z-10">
          <MessageActions agents={agents} text={messageText} onContinue={continueConversation} />
        </div>
      )}
    </div>
  );
});

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
  agents: AgentConfig[];
  onOpenTask: (id: string) => void;
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
  agents,
  onOpenTask,
}: Props) {
  const merged = useCoalesced(updates);
  const thinkingIndex = useMemo(() => {
    if (activeThinkingIndex(updates, task.status) === null) return null;
    for (let index = merged.length - 1; index >= 0; index--) {
      if (merged[index].kind === "agent_thought") return index;
    }
    return null;
  }, [merged, task.status, updates]);
  const resolved = useStableResolved(updates);
  const branchPrompts = useMemo(() => buildConversationBranchPrompts(task, merged), [merged, task]);
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
                    <TranscriptRow
                      update={update}
                      thinkingActive={index === thinkingIndex}
                      taskId={task.id}
                      resolved={resolved}
                      resolveFilePath={resolveFilePath}
                      onOpenFile={onOpenFile}
                      agents={agents}
                      branchPrompt={branchPrompts[index]}
                      onOpenTask={onOpenTask}
                      project={task.project}
                      sourceTaskId={task.id}
                    />
                  </div>
                ))}
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
      {activity && (
        <div className="shrink-0 px-4 py-1.5">
          <AgentActivityIndicator activity={activity} compact />
        </div>
      )}
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
