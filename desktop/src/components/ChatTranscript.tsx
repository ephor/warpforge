import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ArrowDown, ChevronDown } from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { FileLinkResolver } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildConversationBranchPrompt } from "@/lib/conversationBranch";
import type { SessionActivity } from "@/lib/sessionActivity";
import { resolvedPermissions } from "@/lib/sessionPermissions";
import {
  deriveTranscriptRows,
  type TranscriptEntry,
  type TranscriptListRow,
  transcriptRowsAreEqual,
} from "@/lib/sessionStream";
import { activeThinkingIndex } from "@/lib/sessionThinking";
import { latestContextUsage } from "@/lib/sessionUsage";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type {
  AgentConfig,
  CommandInfo,
  EditHunk,
  ProjectFile,
  SessionUpdate,
  TaskInfo,
} from "../protocol";
import { useUi } from "../store/ui";
import { StreamLine } from "../views/MissionControl";
import { AgentActivityIndicator } from "./AgentActivityIndicator";
import { ChatComposer } from "./ChatComposer";
import type { ComposerHandle } from "./Composer";
import { MessageActions } from "./MessageActions";

const CHAT_DRAW_DISTANCE_PX = 600;
const CHAT_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const;
const CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: true } as const;
const CHAT_LIST_HEADER = <div className="h-4" />;
const CHAT_LIST_FOOTER = <div className="h-14" />;
const CHAT_LIST_EMPTY = <p className="px-2 py-4 text-muted-foreground">No session activity yet.</p>;

interface TranscriptRowContextValue {
  agents: AgentConfig[];
  getBranchPrompt: (throughIndex: number) => string;
  onOpenFile: (path: string) => void;
  onOpenFileDiff: (path: string, hunks?: EditHunk[]) => void;
  onOpenTask: (id: string) => void;
  onToggleWorkGroup: (id: string) => void;
  project: string;
  resolveFilePath: FileLinkResolver;
  resolved: Record<string, string>;
  sourceTaskId: string;
  taskId: string;
}

const TranscriptRowContext = createContext<TranscriptRowContextValue | null>(null);

/**
 * Keep a stable `resolved` map reference while its contents are unchanged, so
 * memoized rows don't re-render on every streaming delta (which produces a new
 * `updates` array but no new permission outcomes).
 */
function useStableResolved(updates: SessionUpdate[]): Record<string, string> {
  const ref = useRef<Record<string, string>>({});
  const result = useMemo(() => {
    const next = resolvedPermissions(updates);
    const prev = ref.current;
    const prevKeys = Object.keys(prev);
    const same =
      prevKeys.length === Object.keys(next).length &&
      prevKeys.every((key) => prev[key] === next[key]);
    if (same) {
      return prev;
    }
    return next;
  }, [updates]);

  useEffect(() => {
    ref.current = result;
  }, [result]);

  return result;
}

const TranscriptRow = memo(function TranscriptRow({
  update,
  thinkingActive,
  textStreaming,
  taskId,
  resolved,
  resolveFilePath,
  onOpenFile,
  onOpenFileDiff,
  agents,
  branchIndex,
  getBranchPrompt,
  onOpenTask,
  project,
  sourceTaskId,
}: {
  update: SessionUpdate;
  thinkingActive: boolean;
  textStreaming: boolean;
  taskId: string;
  resolved: Record<string, string>;
  resolveFilePath: FileLinkResolver;
  onOpenFile: (path: string) => void;
  onOpenFileDiff: (path: string, hunks?: EditHunk[]) => void;
  agents: AgentConfig[];
  branchIndex: number;
  getBranchPrompt: (throughIndex: number) => string;
  onOpenTask: (id: string) => void;
  project: string;
  sourceTaskId: string;
}) {
  const continueConversation = async (agent: string) => {
    const branchPrompt = getBranchPrompt(branchIndex);
    if (!branchPrompt) return;
    const result = await daemon.request("task.create", {
      agent,
      attachments: [],
      config_overrides: {},
      include_runtime_context: true,
      project,
      prompt: branchPrompt,
      tags: ["conversation-branch", `branched-from:${sourceTaskId}`],
      worktree: true,
    });
    const createdTaskId = (result as { taskId?: string })?.taskId;
    if (!createdTaskId) throw new Error("Warpforge did not return the new task id");
    // Auto-generate title if enabled.
    const {
      autoNameTasks: autoName,
      textGenAgentId: genAgent,
      textGenModel: genModel,
    } = useUi.getState();
    if (autoName && genAgent) {
      void (async () => {
        try {
          const generated = await daemon.generateText(
            createdTaskId,
            genAgent,
            "task_title",
            genModel ?? undefined,
          );
          if (generated?.trim()) {
            await daemon.setTaskTitle(createdTaskId, generated.trim().slice(0, 80));
          }
        } catch {
          // Silent.
        }
      })();
    }
    onOpenTask(createdTaskId);
  };
  const messageText =
    update.kind === "user_message" || update.kind === "agent_text" ? update.text : null;

  return (
    <div className="group/message relative">
      <StreamLine
        update={update}
        thinkingActive={thinkingActive}
        textStreaming={textStreaming}
        taskId={taskId}
        resolved={resolved}
        resolveFilePath={resolveFilePath}
        onOpenFile={onOpenFile}
        onOpenFileDiff={onOpenFileDiff}
        project={project}
      />
      {messageText && (
        <div className="absolute right-0 bottom-0 z-10">
          <MessageActions agents={agents} text={messageText} onContinue={continueConversation} />
        </div>
      )}
    </div>
  );
});

const TranscriptListItem = memo(
  function TranscriptListItem({ row }: { row: TranscriptListRow }) {
    const shared = useContext(TranscriptRowContext);
    if (!shared) throw new Error("Transcript row rendered outside its context");

    const renderEntry = (
      entry: TranscriptEntry,
      thinkingActive: boolean,
      textStreaming: boolean,
    ) => (
      <TranscriptRow
        update={entry.update}
        thinkingActive={thinkingActive}
        textStreaming={textStreaming}
        taskId={shared.taskId}
        resolved={shared.resolved}
        resolveFilePath={shared.resolveFilePath}
        onOpenFile={shared.onOpenFile}
        onOpenFileDiff={shared.onOpenFileDiff}
        agents={shared.agents}
        branchIndex={entry.mergedIndex}
        getBranchPrompt={shared.getBranchPrompt}
        onOpenTask={shared.onOpenTask}
        project={shared.project}
        sourceTaskId={shared.sourceTaskId}
      />
    );

    if (row.kind === "update") {
      return renderEntry(row.entry, row.thinkingActive, row.textStreaming);
    }

    const noun = row.hiddenCount === 1 ? "work update" : "work updates";
    return (
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={() => shared.onToggleWorkGroup(row.groupId)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-xs leading-5 text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
              row.expanded && "rotate-180",
            )}
          />
        </span>
        {row.expanded ? (
          <span className="font-medium text-foreground/80">Show fewer work updates</span>
        ) : (
          <span className="font-medium text-foreground/80">
            +{row.hiddenCount} previous {noun}
          </span>
        )}
      </button>
    );
  },
  (previous, next) => transcriptRowsAreEqual(previous.row, next.row),
);

function renderTranscriptItem({ item }: { item: TranscriptListRow }) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip pb-3">
      <TranscriptListItem row={item} />
    </div>
  );
}

function transcriptRowKey(row: TranscriptListRow) {
  return row.id;
}

function transcriptRowType(row: TranscriptListRow) {
  return row.kind === "update" ? `update:${row.entry.update.kind}` : row.kind;
}

interface Props {
  activity: SessionActivity | null;
  active: boolean;
  commands: CommandInfo[];
  composerRef: React.Ref<ComposerHandle>;
  files: ProjectFile[];
  filesLoading: boolean;
  imageSupported: boolean;
  onOpenFile: (path: string) => void;
  onOpenFileDiff: (path: string, hunks?: EditHunk[]) => void;
  resolveFilePath: (value: string) => string | null;
  task: TaskInfo;
  updates: SessionUpdate[];
  agents: AgentConfig[];
  onOpenTask: (id: string) => void;
}

/** Variable-height transcript backed by the same list primitive used by t3code. */
export function ChatTranscript({
  activity,
  active,
  commands,
  composerRef,
  files,
  filesLoading,
  imageSupported,
  onOpenFile,
  onOpenFileDiff,
  resolveFilePath,
  task,
  updates,
  agents,
  onOpenTask,
}: Props) {
  const merged = updates;
  const contextUsage = useMemo(() => latestContextUsage(updates), [updates]);
  const thinkingIndex = useMemo(() => {
    if (activeThinkingIndex(updates, task.status) === null) return null;
    for (let index = merged.length - 1; index >= 0; index--) {
      if (merged[index].kind === "agent_thought") return index;
    }
    return null;
  }, [merged, task.status, updates]);
  const streamingTextIndex = useMemo(() => {
    if (task.status !== "running") return null;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const kind = merged[index].kind;
      if (kind === "usage" || kind === "available_commands" || kind === "prompt_capabilities") {
        continue;
      }
      return kind === "agent_text" ? index : null;
    }
    return null;
  }, [merged, task.status]);
  const resolved = useStableResolved(updates);
  const branchSourceRef = useRef({ merged, task });
  useEffect(() => {
    branchSourceRef.current = { merged, task };
  }, [merged, task]);
  const getBranchPrompt = useCallback((throughIndex: number) => {
    const source = branchSourceRef.current;
    return buildConversationBranchPrompt(source.task, source.merged, throughIndex);
  }, []);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleWorkGroup = useCallback((id: string) => {
    setExpandedWorkGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const transcriptRows = useMemo(
    () => deriveTranscriptRows(merged, expandedWorkGroups, thinkingIndex, streamingTextIndex),
    [expandedWorkGroups, merged, streamingTextIndex, thinkingIndex],
  );
  const rowContext = useMemo<TranscriptRowContextValue>(
    () => ({
      agents,
      getBranchPrompt,
      onOpenFile,
      onOpenFileDiff,
      onOpenTask,
      onToggleWorkGroup: toggleWorkGroup,
      project: task.project,
      resolveFilePath,
      resolved,
      sourceTaskId: task.id,
      taskId: task.id,
    }),
    [
      agents,
      getBranchPrompt,
      onOpenFile,
      onOpenFileDiff,
      onOpenTask,
      resolveFilePath,
      resolved,
      task.id,
      task.project,
      toggleWorkGroup,
    ],
  );
  const listRef = useRef<LegendListRef | null>(null);
  const manualNavigationRef = useRef(false);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!active || !following) return;
    const frame = requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, following]);

  const onTranscriptScroll = useCallback(() => {
    const state = listRef.current?.getState();
    if (manualNavigationRef.current) {
      if (state?.isAtEnd === true) {
        manualNavigationRef.current = false;
        setFollowing(true);
      } else {
        setFollowing(false);
      }
      return;
    }
    const atEnd = state?.isNearEnd ?? state?.isAtEnd;
    if (typeof atEnd === "boolean") setFollowing(atEnd);
  }, []);

  const resumeLatest = useCallback(() => {
    manualNavigationRef.current = false;
    setFollowing(true);
    void listRef.current?.scrollToEnd({ animated: false });
  }, []);
  const cancelLiveFollow = useCallback(() => {
    manualNavigationRef.current = true;
    setFollowing(false);
  }, []);
  const pauseFollowingOnNavigationKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (["ArrowUp", "Home", "PageUp"].includes(event.key)) cancelLiveFollow();
    },
    [cancelLiveFollow],
  );

  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    const frame = requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (!scrollNode) return;
      scrollNode.addEventListener("wheel", cancelLiveFollow, { passive: true });
      scrollNode.addEventListener("touchmove", cancelLiveFollow, { passive: true });
      scrollNode.addEventListener("pointerdown", cancelLiveFollow, { passive: true });
      removeListeners = () => {
        scrollNode.removeEventListener("wheel", cancelLiveFollow);
        scrollNode.removeEventListener("touchmove", cancelLiveFollow);
        scrollNode.removeEventListener("pointerdown", cancelLiveFollow);
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [cancelLiveFollow, task.id]);

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <TranscriptRowContext.Provider value={rowContext}>
          <LegendList<TranscriptListRow>
            ref={listRef}
            data={transcriptRows}
            keyExtractor={transcriptRowKey}
            getItemType={transcriptRowType}
            itemsAreEqual={transcriptRowsAreEqual}
            renderItem={renderTranscriptItem}
            drawDistance={CHAT_DRAW_DISTANCE_PX}
            estimatedItemSize={90}
            initialScrollAtEnd
            maintainScrollAtEnd={following ? CHAT_MAINTAIN_SCROLL_AT_END : false}
            maintainVisibleContentPosition={CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION}
            onScroll={onTranscriptScroll}
            onKeyDown={pauseFollowingOnNavigationKey}
            tabIndex={0}
            className="scrollbar-gutter-both h-full min-w-0 overflow-x-hidden overscroll-y-contain px-2 text-sm [overflow-anchor:none]"
            ListHeaderComponent={CHAT_LIST_HEADER}
            ListFooterComponent={CHAT_LIST_FOOTER}
            ListEmptyComponent={CHAT_LIST_EMPTY}
          />
        </TranscriptRowContext.Provider>
        {!following && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="absolute bottom-3 right-2 z-20 size-9 rounded-full bg-background text-muted-foreground shadow-sm hover:text-foreground"
                aria-label="Scroll to latest message"
                onClick={resumeLatest}
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Latest message</TooltipContent>
          </Tooltip>
        )}
      </div>
      {activity && (
        <div className="shrink-0 px-2 py-1.5">
          <AgentActivityIndicator activity={activity} compact />
        </div>
      )}
      <ChatComposer
        ref={composerRef}
        commands={commands}
        contextUsage={contextUsage}
        files={files}
        filesLoading={filesLoading}
        imageSupported={imageSupported}
        onBeforeSend={resumeLatest}
        task={task}
      />
    </>
  );
}
