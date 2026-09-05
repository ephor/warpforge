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

import { ContinueSessionDialog } from "@/components/ContinueSessionDialog";
import type { FileLinkResolver } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionHistory } from "@/hooks/useSessionHistory";
import { transcriptRestoreMode } from "@/lib/chatScroll";
import type { SessionActivity } from "@/lib/sessionActivity";
import { resolvedPermissions } from "@/lib/sessionPermissions";
import {
  deriveTranscriptRows,
  hasReconnectingTransient,
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
import { StreamLine } from "../views/mission-control/StreamLine";
import { AgentActivityIndicator } from "./AgentActivityIndicator";
import { AgentConfigBar } from "./AgentConfigBar";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";
import { MessageActions } from "./MessageActions";
import { WorkflowControls } from "./WorkflowControls";

const CHAT_DRAW_DISTANCE_PX = 250;
/**
 * Measured mean row height. Only mounted rows are measured, so this decides
 * almost the whole content height — and an estimate that is wrong in one
 * direction makes the height drift that way as rows do measure, dragging the
 * scroll with it. Sampled live: median 26, mean 66, max 591.
 */
const CHAT_ESTIMATED_ROW_PX = 65;
const CHAT_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const;
const CHAT_FOLLOW_REARM_PX = 16;
/** How long a pointer press keeps counting as the cause of a scroll. */
const GESTURE_WINDOW_MS = 300;
const CHAT_LIST_FOOTER_HEIGHT = 56;
/** Anchor rows only while reading, never while following — see `docs/adr/0005`. */
const CHAT_MVCP_ANCHOR = { data: true, size: true } as const;
/**
 * The list stops pinning once `distanceFromEnd > threshold * viewport`. One
 * agent message can add several viewports at once, which outruns a tight band
 * and leaves the pin disengaged while we still believe we are following —
 * measured at ~2000px adrift. `following` is the real authority for when to
 * stop, so this only has to be wider than any single burst.
 */
const CHAT_MAINTAIN_SCROLL_AT_END_THRESHOLD = 3;
const CHAT_LIST_HEADER = <div className="h-4" />;
const CHAT_LIST_FOOTER = <div className="h-14" />;
const CHAT_LIST_EMPTY = <p className="px-2 py-4 text-muted-foreground">No session activity yet.</p>;

interface TranscriptRowContextValue {
  agents: AgentConfig[];
  onOpenFile: (path: string) => void;
  onOpenFileDiff: (path: string, hunks?: EditHunk[]) => void;
  onOpenTask: (id: string) => void;
  onRequestBranch: (agent: string, throughIndex: number) => void;
  onToggleWorkGroup: (id: string) => void;
  project: string;
  resolveFilePath: FileLinkResolver;
  resolved: Record<string, string>;
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
  onOpenTask,
  onRequestBranch,
  project,
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
  onOpenTask: (id: string) => void;
  onRequestBranch: (agent: string, throughIndex: number) => void;
  project: string;
}) {
  const continueConversation = async (agent: string) => {
    onRequestBranch(agent, branchIndex);
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
        onOpenTask={shared.onOpenTask}
        onRequestBranch={shared.onRequestBranch}
        project={shared.project}
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
  const isUser = item.kind === "update" && item.entry.update.kind === "user_message";
  return (
    <div
      key={item.id}
      className={cn(
        "min-w-0 overflow-x-clip pb-3",
        isUser ? "ml-auto max-w-[90%] w-full" : "mx-auto w-full",
      )}
    >
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
  // The transcript is fetched per task on open and the list mounts only once
  // it has resolved in full — a mounted transcript is only ever appended to
  // (docs/adr/0005).
  const historyResolved = useSessionHistory(task.id);
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
  // Which message the developer asked to continue from, and with what. The
  // dialog it opens decides how much of the conversation travels.
  const [branchRequest, setBranchRequest] = useState<{
    agent: string;
    throughIndex: number;
  } | null>(null);
  const requestBranch = useCallback((agent: string, throughIndex: number) => {
    setBranchRequest({ agent, throughIndex });
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
      onOpenFile,
      onOpenFileDiff,
      onOpenTask,
      onRequestBranch: requestBranch,
      onToggleWorkGroup: toggleWorkGroup,
      project: task.project,
      resolveFilePath,
      resolved,
      taskId: task.id,
    }),
    [
      agents,
      requestBranch,
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
  // Mirrors for the scroll tracer: its listener outlives any one render, so it
  // needs the value at event time rather than the one captured at attach.
  const lastPointerRef = useRef(0);
  const followingRef = useRef(true);
  const disclosureSettlingRef = useRef(false);
  followingRef.current = following;
  disclosureSettlingRef.current = disclosureSettling;

  // Hoisted out of the JSX: a hook in a prop expression works only for as long
  // as nothing wraps that element in a condition, and breaks silently when
  // something does.
  const maintainVisibleContentPosition = useMemo(() => {
    const mode = transcriptRestoreMode(following, disclosureSettling, disclosureAnchorKey.current);
    if (mode === "none") return undefined;
    return {
      ...CHAT_MVCP_ANCHOR,
      shouldRestorePosition: (row: TranscriptListRow) =>
        mode === "anchor" ? row.id === disclosureAnchorKey.current : true,
    };
    // `disclosureSettling` flips when the anchor is set/cleared; the callback
    // reads `.current` directly, so these are the deps that stabilize it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disclosureSettling, following]);

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
    const prev = previousScrollRef.current;
    previousScrollRef.current = state.scroll;
    const distanceFromEnd =
      state.contentLength - state.scroll - state.scrollLength - CHAT_LIST_FOOTER_HEIGHT;
    if (state.isAtEnd || distanceFromEnd <= CHAT_FOLLOW_REARM_PX) {
      setFollowing(true);
      return;
    }
    // Only a scroll the user actually drove detaches following. The list moves
    // the scroller downward on its own while rows measure — thousands of pixels
    // on a cold start — and reading that as "scrolled up" cancelled following
    // without a gesture, which turned one measurement burst into a chat stuck
    // far from the live edge. Wheel and touch cancel directly; this branch is
    // for the scrollbar drag, which produces no such event.
    const draggedRecently = performance.now() - lastPointerRef.current < GESTURE_WINDOW_MS;
    if (draggedRecently && state.scroll < prev - 1) setFollowing(false);
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
      const onPointerDown = () => {
        lastPointerRef.current = performance.now();
      };
      scrollNode.addEventListener("pointerdown", onPointerDown, { passive: true });
      scrollNode.addEventListener("wheel", onWheel, { passive: true });
      scrollNode.addEventListener("touchstart", onTouchStart, { passive: true });
      scrollNode.addEventListener("touchmove", onTouchMove, { passive: true });
      // The list sizes unmeasured rows from a running average, so a handful of
      // tall rows measuring can move the estimated total by tens of thousands
      // of pixels at once — past any sane end-pin band, which then lets go of
      // the end. Re-assert it here instead: a ResizeObserver runs before paint,
      // so the corrected position is the first one drawn and the growth is
      // never visible as a jump. This is deliberately on *size*, not on data —
      // the two imperative pins removed before fought `maintainScrollAtEnd`
      // over the same data change; this one covers the case it cannot.
      const keepAtEnd = new ResizeObserver(() => {
        if (!followingRef.current || disclosureSettlingRef.current) return;
        scrollNode.scrollTop = scrollNode.scrollHeight;
        previousScrollRef.current = scrollNode.scrollTop;
      });
      // Both boxes move the end. The content grows as rows measure; the
      // scroller itself grows when the composer collapses back to one line on
      // send — same distance from the end, different cause, and watching only
      // the content missed the second one entirely.
      keepAtEnd.observe(scrollNode);
      const content = scrollNode.firstElementChild;
      if (content) keepAtEnd.observe(content);
      removeListeners = () => {
        keepAtEnd?.disconnect();
        scrollNode.removeEventListener("pointerdown", onPointerDown);
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
      {branchRequest && (
        <ContinueSessionDialog
          open
          onOpenChange={(next) => {
            if (!next) setBranchRequest(null);
          }}
          task={task}
          updates={merged}
          throughIndex={branchRequest.throughIndex}
          targetAgent={branchRequest.agent}
          onOpenTask={onOpenTask}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <TranscriptRowContext.Provider value={rowContext}>
          {historyResolved ? (
            <LegendList<TranscriptListRow>
              ref={listRef}
              data={transcriptRows}
              keyExtractor={transcriptRowKey}
              getItemType={transcriptRowType}
              itemsAreEqual={transcriptRowsAreEqual}
              renderItem={renderTranscriptItem}
              recycleItems
              drawDistance={CHAT_DRAW_DISTANCE_PX}
              estimatedItemSize={CHAT_ESTIMATED_ROW_PX}
              initialScrollAtEnd
              maintainScrollAtEnd={
                following && !disclosureSettling ? CHAT_MAINTAIN_SCROLL_AT_END : false
              }
              maintainScrollAtEndThreshold={CHAT_MAINTAIN_SCROLL_AT_END_THRESHOLD}
              maintainVisibleContentPosition={maintainVisibleContentPosition}
              onScroll={onTranscriptScroll}
              onKeyDown={pauseFollowingOnNavigationKey}
              tabIndex={0}
              className="scrollbar-gutter-both h-full min-w-0 overflow-x-hidden overscroll-y-contain px-2 text-sm [overflow-anchor:none]"
              ListHeaderComponent={CHAT_LIST_HEADER}
              ListFooterComponent={CHAT_LIST_FOOTER}
              ListEmptyComponent={CHAT_LIST_EMPTY}
            />
          ) : (
            <div
              role="status"
              aria-label="Loading conversation"
              className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <span className="size-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
              Loading conversation…
            </div>
          )}
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
      {hasReconnectingTransient(updates) && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span className="size-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
          Reconnecting to the saved agent session…
        </div>
      )}
      {/* No bottom padding on the activity line: the composer's own `py-2` is
          the gap. Stacking both put 14px between the status line and the box
          it describes. */}
      {activity && (
        <div className="shrink-0 px-2 pb-0 pt-1.5">
          <AgentActivityIndicator activity={activity} compact />
        </div>
      )}
      {task.workflowRun && !readOnly && <WorkflowControls task={task} />}
      {!readOnly && (
        <div>
          <Composer
            // One left edge down the whole column: the header title, every
            // message and the composer all start at px-3. With no frame around
            // the conversation, three different insets is what read as slop.
            className="px-2"
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
