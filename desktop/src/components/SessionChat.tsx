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
  type MouseEvent,
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
import { showContextMenu, useNativeContextMenu } from "../hooks/useNativeContextMenu";
import { useWorkflowSend } from "../hooks/useWorkflowSend";
import type {
  AgentConfig,
  CommandInfo,
  EditHunk,
  ProjectFile,
  PromptSubmission,
  SessionUpdate,
  TaskInfo,
} from "../protocol";
import { useUi } from "../store/ui";
import { StreamLine } from "../views/mission-control/StreamLine";
import { AgentActivityIndicator } from "./AgentActivityIndicator";
import { AgentConfigBar } from "./AgentConfigBar";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";
import { MessageActions } from "./MessageActions";
import { WorkflowControls } from "./WorkflowControls";

const CHAT_DRAW_DISTANCE_PX = 250;
const CHAT_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const;
/**
 * The follow zone, as a fraction of the viewport. One number for both the
 * `following` flag and the list's own end-pinning threshold: if they differ,
 * the band between them is a window where we believe we are following but the
 * list has stopped pinning, and nothing stabilises the scroll position.
 */
const CHAT_FOLLOW_THRESHOLD = 0.2;
/**
 * `size` stabilisation stays on in both modes. Unmeasured rows are sized from a
 * running per-type average, so every measurement shifts the total content size
 * by the drift times the unmeasured row count — thousands of pixels in a long
 * transcript. Without it the view silently slides into old messages.
 */
const CHAT_MVCP = { data: true, size: true } as const;
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

  const requestId = useRef(`message-${crypto.randomUUID()}`).current;
  const copyHandler = useMemo(
    () =>
      messageText
        ? new Map([["copy", () => void navigator.clipboard.writeText(messageText)]])
        : new Map<string, () => void>(),
    [messageText],
  );
  useNativeContextMenu(requestId, copyHandler);

  const onRowContextMenu = (e: MouseEvent) => {
    if (!messageText) return;
    e.preventDefault();
    e.stopPropagation();
    void showContextMenu({
      requestId,
      items: [{ type: "item", id: "copy", label: "Copy Message" }],
    });
  };

  return (
    <div className="group/message relative" onContextMenu={onRowContextMenu}>
      <StreamLine
        update={update}
        thinkingActive={thinkingActive}
        textStreaming={textStreaming}
        taskId={taskId}
        resolved={resolved}
        resolveFilePath={resolveFilePath}
        onOpenFile={onOpenFile}
        onOpenFileDiff={onOpenFileDiff}
        onOpenTask={onOpenTask}
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
    <div key={item.id} className="mx-auto w-full min-w-0 overflow-x-clip pb-3">
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

export interface SessionChatProps {
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
  /**
   * Render the transcript without the composer. Used where a *different*
   * task's session is on show — the Pipeline surface watching a child agent —
   * so the reader can see what it is doing without being offered a reply box
   * that would steer a session they are not in.
   */
  readOnly?: boolean;
}

export function SessionChat({
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
  readOnly = false,
}: SessionChatProps) {
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
  const disclosureAnchorKey = useRef<string | null>(null);
  const [disclosureSettling, setDisclosureSettling] = useState(false);
  const disclosureFrames = useRef<number[]>([]);
  const suspendForDisclosure = useCallback((anchorKey: string) => {
    disclosureAnchorKey.current = anchorKey;
    setDisclosureSettling(true);
    // Cancel any in-flight settle from a prior rapid toggle before starting a
    // new one; otherwise an old frame's clear wins and the new toggle settles
    // early, re-enabling end-pin while content is still resizing.
    disclosureFrames.current.forEach(cancelAnimationFrame);
    disclosureFrames.current = [
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          disclosureAnchorKey.current = null;
          setDisclosureSettling(false);
          disclosureFrames.current = [];
        });
      }),
    ];
  }, []);
  useEffect(() => {
    return () => disclosureFrames.current.forEach(cancelAnimationFrame);
  }, []);
  const toggleWorkGroup = useCallback(
    (id: string) => {
      // Anchor compensation to the toggled row's own id so the trigger stays
      // under the pointer instead of the viewport chasing the end. The toggle
      // row's id is `work-toggle:${groupId}` (sessionStream.ts:127), and
      // `shouldRestorePosition` compares against row.id.
      suspendForDisclosure(`work-toggle:${id}`);
      setExpandedWorkGroups((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [suspendForDisclosure],
  );
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
  const previousScrollRef = useRef(0);
  const [following, setFollowing] = useState(true);

  /**
   * Pin through the DOM node rather than `listRef.scrollToEnd()`. The
   * imperative method resolves an absolute target from per-type size
   * *estimates* and freezes those estimates for the duration of the scroll, so
   * in a long transcript it lands where the estimate claimed the end was —
   * possibly outside the follow zone, where nothing re-pins us. This is why
   * `maintainScrollAtEnd` scrolls the raw scroller instead.
   */
  const pinToLatest = useCallback(() => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    previousScrollRef.current = node.scrollTop;
  }, []);

  const onTranscriptScroll = useCallback(() => {
    const state = listRef.current?.getState();
    if (!state) return;
    const previousScroll = previousScrollRef.current;
    previousScrollRef.current = state.scroll;
    if (state.isWithinMaintainScrollAtEndThreshold) {
      setFollowing(true);
      return;
    }
    // Content growing above us does not move `scroll` — it only pushes the end
    // further away — so a drifting size estimate can no longer detach
    // following. Only a real upward move does.
    if (state.scroll < previousScroll - 1) setFollowing(false);
  }, []);

  const resumeLatest = useCallback(() => {
    setFollowing(true);
    pinToLatest();
  }, [pinToLatest]);

  // On a session switch (task.id change) while the transcript is the active
  // tab and the user is still following, re-pin to the live edge. Keyed on
  // `task.id` — not `transcriptRows` — so streaming deltas never re-enter
  // here to race maintainScrollAtEnd.
  useEffect(() => {
    if (!active || !following) return;
    const frame = requestAnimationFrame(pinToLatest);
    return () => cancelAnimationFrame(frame);
  }, [active, following, pinToLatest, task.id]);
  const cancelLiveFollow = useCallback(() => {
    setFollowing(false);
  }, []);
  const pauseFollowingOnNavigationKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (["ArrowUp", "Home", "PageUp"].includes(event.key)) cancelLiveFollow();
    },
    [cancelLiveFollow],
  );

  useEffect(() => {
    previousScrollRef.current = 0;
    let removeListeners: (() => void) | null = null;
    const frame = requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (!scrollNode) return;
      // Only an upward gesture detaches following. Scrolling *down* is not
      // navigation away from the latest message, and a click inside the
      // transcript — a file link, a work group, selecting text — is not a
      // scroll at all.
      let touchY: number | null = null;
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) cancelLiveFollow();
      };
      const onTouchStart = (event: TouchEvent) => {
        touchY = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const nextY = event.touches[0]?.clientY;
        if (nextY === undefined) return;
        if (touchY !== null && nextY > touchY + 1) cancelLiveFollow();
        touchY = nextY;
      };
      scrollNode.addEventListener("wheel", onWheel, { passive: true });
      scrollNode.addEventListener("touchstart", onTouchStart, { passive: true });
      scrollNode.addEventListener("touchmove", onTouchMove, { passive: true });
      removeListeners = () => {
        scrollNode.removeEventListener("wheel", onWheel);
        scrollNode.removeEventListener("touchstart", onTouchStart);
        scrollNode.removeEventListener("touchmove", onTouchMove);
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [cancelLiveFollow, task.id]);

  const workflow = useWorkflowSend(task);

  const onSend = useCallback(
    async (submission: PromptSubmission) => {
      resumeLatest();
      if (await workflow.send(submission)) return;
      await daemon.request("session.prompt", { task_id: task.id, ...submission });
    },
    [resumeLatest, task.id, workflow],
  );

  const onCancel = useCallback(async () => {
    await daemon.request("task.cancel", { task_id: task.id });
  }, [task.id]);

  const isRunning = task.status === "running" || task.status === "queued";

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
            recycleItems
            drawDistance={CHAT_DRAW_DISTANCE_PX}
            estimatedItemSize={90}
            initialScrollAtEnd
            maintainScrollAtEnd={
              following && !disclosureSettling ? CHAT_MAINTAIN_SCROLL_AT_END : false
            }
            maintainScrollAtEndThreshold={CHAT_FOLLOW_THRESHOLD}
            maintainVisibleContentPosition={useMemo(
              () => ({
                ...CHAT_MVCP,
                shouldRestorePosition: (row: TranscriptListRow) =>
                  disclosureAnchorKey.current === null || row.id === disclosureAnchorKey.current,
              }),
              // `disclosureSettling` flips when anchor is set/cleared; the callback
              // reads `.current` directly so this is the dependency that stabilizes
              // the MVCP object per the approved plan (useMemo + anchor-gated).
              // eslint-disable-next-line react-hooks/exhaustive-deps
              [disclosureSettling],
            )}
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
      {task.workflowRun && !readOnly && <WorkflowControls task={task} />}
      {!readOnly && (
        <div className="border-t border-border/80">
          <Composer
            ref={composerRef}
            commands={commands}
            contextUsage={contextUsage}
            files={files}
            filesLoading={filesLoading}
            imageSupported={imageSupported}
            disabled={task.status === "done" || workflow.disabled}
            onSend={onSend}
            onCancel={isRunning && !workflow.isWorkflow ? onCancel : undefined}
            placeholder={workflow.placeholder ?? "Steer this session..."}
            toolbar={
              task.configOptions && task.configOptions.length > 0 ? (
                <AgentConfigBar taskId={task.id} options={task.configOptions} />
              ) : undefined
            }
          />
        </div>
      )}
    </>
  );
}
