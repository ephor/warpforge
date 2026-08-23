import { useQuery } from "@tanstack/react-query";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import {
  Activity,
  ChevronRight,
  ExternalLink,
  FilePen,
  FileText,
  ListTodo,
  MoreHorizontal,
  PinOff,
  Plus,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import type { EventCallback, LayoutItem } from "react-grid-layout";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { withOccurrenceKeys } from "@/lib/renderKeys";
import { attentionAction, attentionStatus } from "@/lib/attentionLabels";
import { sessionActivity } from "@/lib/sessionActivity";
import { latestPendingPermission } from "@/lib/sessionPermissions";
import { elapsed } from "@/lib/status";
import {
  buildTaskGroupIndex,
  flattenTaskTree,
  isSettledTask,
  resolvePinnedTaskGroups,
  resolveGroupTaskId,
  setTaskGroupPinned,
  taskGroupStatus,
  type TaskGroupStatus,
  type TaskTree,
} from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { toolDisplayTitle } from "@/lib/toolDisplay";
import { cn } from "@/lib/utils";

import { AgentAvatarGroup } from "../components/AgentAvatar";
import type { FileLinkResolver } from "../components/Markdown";
import { BufferedMarkdown, CollapsibleMarkdown, Markdown } from "../components/Markdown";
import { SessionChat } from "../components/SessionChat";
import { StatusBadge, type TaskBadgeStatus } from "../components/StatusBadge";
import { TaskAgentSwitcher } from "../components/TaskAgentSwitcher";
import { ThinkingBlock } from "../components/ThinkingBlock";
import { WorkflowEventLine } from "../components/WorkflowEventLine";
import type { DaemonState } from "../daemon";
import { daemon } from "../daemon";
import { buildAttentionQueue, type AttentionItem } from "../lib/attentionRail";
import type {
  AgentConfig,
  CommandInfo,
  EditHunk,
  ProjectFile,
  SessionUpdate,
  TaskInfo,
} from "../protocol";
import { daemonQuery } from "../query";
import { useUi } from "../store/ui";
import { coalesceTailUpdates } from "./missionControlStream";

/**
 * Mission Control — the default, attention-driven operating view.
 * Attention rail (blocked-on-a-human, triaged) + live session wall + a
 * pinnable focus row where sessions can be steered inline. See UI_CONCEPT.md.
 */

interface Props {
  state: DaemonState;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string) => void;
}

const FOCUS_PANE_RAW_TAIL = 300;
const GRID_SCROLL_EDGE = 48;
const GRID_SCROLL_STEP = 24;
const GRID_SCROLL_GAP = 8;

function pointerClientY(event: Event): number | null {
  if ("clientY" in event && typeof event.clientY === "number") {
    return event.clientY;
  }

  const touchEvent = event as TouchEvent;
  const touch = touchEvent.touches[0] ?? touchEvent.changedTouches[0];
  return touch?.clientY ?? null;
}

export default function MissionControl({ state, onOpenTask, onNewTask }: Props) {
  const pinned = useUi((s) => s.pinnedTaskIds);
  const pinnedLayout = useUi((s) => s.pinnedLayout);
  const setPinnedTaskIds = useUi((s) => s.setPinnedTaskIds);
  const setPinnedLayout = useUi((s) => s.setPinnedLayout);
  const attentionTargetId = useUi((s) => s.attentionTargetId);
  const attentionTargetNonce = useUi((s) => s.attentionTargetNonce);
  const { width, containerRef, mounted } = useContainerWidth();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [boardHeight, setBoardHeight] = useState(0);

  const beginGridInteraction = useCallback(() => {
    document.body.classList.add("wf-dragging");
  }, []);
  const endGridInteraction = useCallback(() => {
    document.body.classList.remove("wf-dragging");
  }, []);
  const scrollDuringResize = useCallback((event: Event) => {
    const pointerY = pointerClientY(event);
    if (pointerY === null) return;

    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;

    const bounds = viewport.getBoundingClientRect();
    let delta = 0;
    if (pointerY > bounds.bottom - GRID_SCROLL_EDGE) {
      delta = Math.min(GRID_SCROLL_STEP, pointerY - (bounds.bottom - GRID_SCROLL_EDGE));
    } else if (pointerY < bounds.top + GRID_SCROLL_EDGE) {
      delta = -Math.min(GRID_SCROLL_STEP, bounds.top + GRID_SCROLL_EDGE - pointerY);
    }
    if (delta !== 0) viewport.scrollTop += delta;
  }, []);
  const beginResizeInteraction = useCallback<EventCallback>(
    (_layout, _oldItem, _newItem, _placeholder, event) => {
      beginGridInteraction();
      scrollDuringResize(event);
    },
    [beginGridInteraction, scrollDuringResize],
  );
  const handleResize = useCallback<EventCallback>(
    (_layout, _oldItem, _newItem, _placeholder, event) => {
      scrollDuringResize(event);
    },
    [scrollDuringResize],
  );
  const revealResizedCard = useCallback<EventCallback>(
    (_newLayout, _oldItem, _newItem, _placeholder, _event, element) => {
      endGridInteraction();
      if (!element) return;

      window.requestAnimationFrame(() => {
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
          "[data-radix-scroll-area-viewport]",
        );
        if (!viewport) {
          element.scrollIntoView({ block: "end", inline: "nearest" });
          return;
        }

        const bounds = viewport.getBoundingClientRect();
        const card = element.getBoundingClientRect();
        const bottomOverflow = card.bottom - (bounds.bottom - GRID_SCROLL_GAP);
        const topOverflow = card.top - bounds.top;
        if (bottomOverflow > 0) {
          viewport.scrollTop += bottomOverflow;
        } else if (topOverflow < 0) {
          viewport.scrollTop += topOverflow;
        }
      });
    },
    [endGridInteraction],
  );

  useEffect(() => () => document.body.classList.remove("wf-dragging"), []);

  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;

    const measure = () => setBoardHeight(Math.round(viewport.getBoundingClientRect().height));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // `isSettledTask`, not `status !== "done"`: a task the user marked handled is
  // finished too. Counting only the daemon's `done` made this number disagree
  // with the sidebar, which hides both — same tasks, two different totals.
  const live = useMemo(
    () => state.snapshot.tasks.filter((task) => !isSettledTask(task)),
    [state.snapshot.tasks],
  );
  const attentionQueue = useMemo(
    () => buildAttentionQueue(state.snapshot.tasks, state.sessionUpdates),
    [state.sessionUpdates, state.snapshot.tasks],
  );
  const groupIndex = useMemo(
    () => buildTaskGroupIndex(state.snapshot.tasks),
    [state.snapshot.tasks],
  );
  const pinnedGroups = useMemo(
    () => resolvePinnedTaskGroups(groupIndex, pinned),
    [groupIndex, pinned],
  );
  const runningCount = useMemo(
    () => live.filter((task) => task.status === "running" || task.status === "queued").length,
    [live],
  );

  const layout = useMemo<LayoutItem[]>(() => {
    return pinned.map((id) => {
      const stored = pinnedLayout[id];
      return {
        i: id,
        x: stored?.x ?? 0,
        y: stored?.y ?? 0,
        w: stored?.w ?? 2,
        h: stored?.h ?? 2,
        minW: 1,
        minH: 1,
        maxW: 4,
      };
    });
  }, [pinned, pinnedLayout]);

  const handleLayoutChange = useCallback(
    (newLayout: readonly LayoutItem[]) => {
      for (const item of newLayout) {
        const current = pinnedLayout[item.i];
        if (
          !current ||
          current.x !== item.x ||
          current.y !== item.y ||
          current.w !== item.w ||
          current.h !== item.h
        ) {
          setPinnedLayout(item.i, {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          });
        }
      }
    },
    [pinnedLayout, setPinnedLayout],
  );

  const handleUnpin = useCallback(
    (tree: TaskTree) => {
      setPinnedTaskIds(setTaskGroupPinned(groupIndex, pinned, tree.task.id, false));
    },
    [groupIndex, pinned, setPinnedTaskIds],
  );

  const rowHeight =
    boardHeight > 0
      ? Math.min(260, Math.max(160, Math.floor((boardHeight - GRID_SCROLL_GAP) / 2)))
      : 260;

  return (
    <ScrollArea ref={scrollAreaRef} className="h-full min-h-0">
      {/* `px-1`, matching Projects: `main` in App.tsx already pads the view,
          so the responsive `px-4 sm:px-6 lg:px-8` this used to carry indented
          Mission Control well past every other screen. */}
      <div className="min-w-0 space-y-4 px-1 pb-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
              Operations / all projects
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              Mission Control
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Decisions first. Live work stays visible.
            </p>
          </div>
          <Button size="sm" onClick={() => onNewTask()}>
            <Plus className="size-4" />
            New task
          </Button>
        </header>

        {/* Two numbers that mean what they say. "Workstreams" went: it counted
            root task trees under a word used nowhere else in the product, and
            "Live work" used to headline `running` while its own caption
            counted everything unfinished — the number contradicted its label. */}
        <section aria-label="Workspace summary" className="grid gap-2 sm:grid-cols-2">
          <OverviewMetric
            label="Needs you"
            value={attentionQueue.length}
            detail="permissions, questions, and blocked work"
            tone="warn"
          />
          <OverviewMetric
            label="Running now"
            value={runningCount}
            detail={`${live.length} unfinished task${live.length === 1 ? "" : "s"}`}
          />
        </section>

        {/* Full width, and alone: the per-project task list that used to sit
            beside it was the sidebar's tree redrawn flat, truncated and
            without its hierarchy — worse than the thing already on screen. */}
        <section className="min-w-0">
          <DecisionQueue items={attentionQueue} onOpenTask={onOpenTask} />
        </section>

        <section aria-labelledby="pinned-work-heading" className="min-w-0">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <h2 id="pinned-work-heading" className="text-sm font-semibold text-foreground">
                Pinned work
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Live sessions you chose to keep visible.
              </p>
            </div>
            {pinnedGroups.length > 0 && (
              <span className="tnum text-xs text-muted-foreground">
                {pinnedGroups.length} session{pinnedGroups.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <div ref={containerRef} className="min-w-0 w-full">
            {pinnedGroups.length > 0 ? (
              mounted && width > 0 ? (
                <ReactGridLayout
                  className="layout"
                  layout={layout}
                  width={width}
                  gridConfig={{
                    cols: 4,
                    rowHeight,
                    margin: [8, 0],
                    containerPadding: [0, 0],
                  }}
                  dragConfig={{ enabled: true }}
                  resizeConfig={{
                    enabled: true,
                    handles: ["se", "sw", "ne", "nw", "n", "s", "e", "w"],
                  }}
                  onDragStart={beginGridInteraction}
                  onDragStop={endGridInteraction}
                  onResizeStart={beginResizeInteraction}
                  onResize={handleResize}
                  onResizeStop={revealResizedCard}
                  onLayoutChange={handleLayoutChange}
                >
                  {pinnedGroups.map((tree) => (
                    <div key={tree.task.id} className="h-full min-h-0">
                      <FocusGroupPane
                        tree={tree}
                        updatesByTaskId={state.sessionUpdates}
                        attentionTargetId={attentionTargetId}
                        attentionTargetNonce={attentionTargetNonce}
                        onUnpin={handleUnpin}
                        onOpen={onOpenTask}
                        agents={(state.snapshot.agents ?? []).filter((a) => a.enabled)}
                      />
                    </div>
                  ))}
                </ReactGridLayout>
              ) : null
            ) : live.length > 0 ? (
              <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-muted-foreground">
                <p className="text-sm text-foreground">No pinned sessions.</p>
                <p className="max-w-md text-xs">
                  Pin sessions from the sidebar when you want them on the Mission Control board.
                </p>
              </div>
            ) : null}
          </div>
        </section>

        {live.length === 0 && attentionQueue.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border/70 px-4 py-10 text-center text-muted-foreground">
            <p>No live sessions.</p>
            <Button variant="outline" onClick={() => onNewTask()}>
              <Plus className="size-4" />
              Start a task
            </Button>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function OverviewMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <Card
      className={cn(
        "min-w-0 rounded-md border-border/70 bg-card/35 px-3 py-2.5 shadow-none",
        tone === "warn" && "border-warn/40 bg-warn/[0.06]",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("tnum text-xl font-semibold", tone === "warn" && "text-warn")}>
          {value}
        </span>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground/80">{detail}</p>
    </Card>
  );
}

function DecisionQueue({
  items,
  onOpenTask,
}: {
  items: AttentionItem[];
  onOpenTask: (id: string) => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden rounded-md border-border/70 bg-card/35 shadow-none">
      <div className="flex items-start gap-3 border-b border-border/60 px-3 py-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Decision queue</h2>
            <span className="tnum rounded-full bg-warn/10 px-1.5 py-px text-[11px] text-warn">
              {items.length}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Only work blocked on human input.</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing is waiting for you.
        </div>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          {items.map((item) => (
            <button
              key={item.task.id}
              type="button"
              onClick={() => onOpenTask(item.task.id)}
              aria-label={`Open ${taskLabel(item.task)}`}
              className="group flex w-full min-w-0 flex-col gap-1.5 border-b border-border/55 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-secondary/35 focus-visible:bg-secondary/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge status={attentionStatus(item)} size="xs" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {taskLabel(item.task)}
                </span>
                <span className="shrink-0 text-[11px] font-medium text-primary">
                  {attentionAction(item)}
                </span>
              </div>
              <p className="truncate pl-1 text-xs text-muted-foreground" title={item.reason}>
                {item.reason}
              </p>
              <div className="flex min-w-0 items-center gap-2 pl-1 text-[11px] text-muted-foreground/80">
                <span className="truncate">{item.task.project}</span>
                <span
                  aria-hidden
                  className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40"
                />
                <AgentAvatarGroup agentId={item.task.agent} />
                <span className="tnum ml-auto shrink-0">{elapsed(item.task.updatedAt)} ago</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

interface FocusGroupPaneProps {
  tree: TaskTree;
  updatesByTaskId: DaemonState["sessionUpdates"];
  attentionTargetId: string | null;
  attentionTargetNonce: number;
  onUnpin: (tree: TaskTree) => void;
  onOpen: (id: string) => void;
  agents: AgentConfig[];
}

const FocusGroupPane = memo(function FocusGroupPane({
  tree,
  updatesByTaskId,
  attentionTargetId,
  attentionTargetNonce,
  onUnpin,
  onOpen,
  agents,
}: FocusGroupPaneProps) {
  const members = useMemo(() => flattenTaskTree(tree), [tree]);
  const childAgents = useMemo(
    () => [...new Set(tree.children.map((c) => c.task.agent))],
    [tree.children],
  );
  const [selectedId, setSelectedId] = useState(() =>
    resolveGroupTaskId(tree, null, attentionTargetId),
  );

  useEffect(() => {
    setSelectedId((current) => resolveGroupTaskId(tree, current, attentionTargetId));
  }, [attentionTargetId, attentionTargetNonce, tree]);

  const selectedTask = members.find((task) => task.id === selectedId) ?? tree.task;
  const permissionTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of members) {
      if (latestPendingPermission(task.id, updatesByTaskId[task.id])) ids.add(task.id);
    }
    return ids;
  }, [members, updatesByTaskId]);
  const status = taskGroupStatus(tree, permissionTaskIds);

  const handleUnpin = useCallback(() => onUnpin(tree), [onUnpin, tree]);
  const handleOpen = useCallback(() => onOpen(selectedTask.id), [onOpen, selectedTask.id]);
  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  return (
    <FocusPane
      task={selectedTask}
      updates={updatesByTaskId[selectedTask.id] ?? []}
      tree={tree}
      selectedId={selectedTask.id}
      groupStatus={status}
      childAgents={childAgents}
      agents={agents}
      onSelect={handleSelect}
      onUnpin={handleUnpin}
      onOpen={handleOpen}
    />
  );
}, focusGroupPaneEqual);

function focusGroupPaneEqual(previous: FocusGroupPaneProps, next: FocusGroupPaneProps) {
  if (
    previous.tree !== next.tree ||
    previous.attentionTargetId !== next.attentionTargetId ||
    previous.attentionTargetNonce !== next.attentionTargetNonce ||
    previous.onOpen !== next.onOpen ||
    previous.onUnpin !== next.onUnpin
  ) {
    return false;
  }
  return flattenTaskTree(next.tree).every(
    (task) => previous.updatesByTaskId[task.id] === next.updatesByTaskId[task.id],
  );
}

/**
 * Collapse a group status onto the StatusBadge vocabulary. "review" is a
 * rollup, not a task status — the underlying tasks are `waiting` with a diff.
 */
function groupStatusKind(status: TaskGroupStatus): TaskBadgeStatus {
  return status === "review" ? "waiting" : status;
}

function FocusPane({
  task,
  updates,
  tree,
  selectedId,
  groupStatus,
  childAgents,
  agents,
  onSelect,
  onUnpin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  tree: TaskTree;
  selectedId: string;
  groupStatus: TaskGroupStatus;
  childAgents?: string[];
  agents: AgentConfig[];
  onSelect: (id: string) => void;
  onUnpin: () => void;
  onOpen: () => void;
}) {
  const stream = useMemo(() => coalesceTailUpdates(updates, FOCUS_PANE_RAW_TAIL), [updates]);
  const tools = useMemo(() => summarizeTools(updates), [updates]);
  const files = useMemo(() => summarizeFiles(updates), [updates]);
  const commands = useMemo(() => latestCommands(updates), [updates]);
  const fileListQuery = useQuery({
    queryFn: daemonQuery<ProjectFile[]>("file.list", { task_id: task.id }),
    queryKey: ["fileList", task.id, "tracked"],
  });
  const projectFiles = useMemo(
    () => (Array.isArray(fileListQuery.data) ? fileListQuery.data : []),
    [fileListQuery.data],
  );
  const capability = [...updates].reverse().find((update) => update.kind === "prompt_capabilities");
  const imageSupported = capability?.kind === "prompt_capabilities" ? capability.image : false;
  const activity = sessionActivity(task, stream);
  const openTask = useUi((s) => s.openTask);
  const openTaskWithNav = useUi((s) => s.openTaskWithNav);
  const composerRef = useRef<import("../components/Composer").ComposerHandle>(null);
  const knownFilePaths = useMemo(
    () => new Set(projectFiles.map((file) => file.path)),
    [projectFiles],
  );
  const resolvePinnedFilePath = useCallback(
    (value: string): string | null => {
      let path = value.trim().replace(/^['"`]+|['"`]+$/g, "");
      path = path.replace(/:\d+(?::\d+)?$/, "");
      path = path.replace(/[),;]+$/, "");
      path = path.replace(/^\.\/+/, "");
      return knownFilePaths.has(path) ? path : null;
    },
    [knownFilePaths],
  );
  const openFile = useCallback(
    (path: string) => openTaskWithNav(task.id, { surface: "files", path }),
    [openTaskWithNav, task.id],
  );
  const openFileDiff = useCallback(
    (path: string, hunks?: EditHunk[]) =>
      openTaskWithNav(task.id, { surface: "diff", path, hunks }),
    [openTaskWithNav, task.id],
  );

  return (
    <Card
      className={cn(
        "group flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/80 bg-card shadow-none",
      )}
    >
      <div className="border-b border-border/80 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 truncate text-left text-[15px] font-semibold leading-5 text-foreground hover:text-primary"
            title={task.prompt}
          >
            {taskLabel(task)}
          </button>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label="Open task details"
              className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={onOpen}
              title="Open task details"
            >
              <ExternalLink className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Unpin from Mission Control"
              className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={onUnpin}
              title="Unpin from Mission Control"
            >
              <PinOff className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          <StatusBadge status={groupStatusKind(groupStatus)} activity={activity} size="xs" />
          <span className="min-w-0 truncate font-semibold text-foreground/90">{task.project}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <AgentAvatarGroup agentId={task.agent} childAgents={childAgents} />
            <span aria-hidden className="h-1 w-1 rounded-full bg-muted-foreground/40" />
            <span className="tnum">{elapsed(task.updatedAt)}</span>
          </span>
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center border-b border-border/80 px-3">
        <span className="text-xs font-semibold text-foreground">Conversation</span>
        <div className="ml-auto flex items-center gap-1">
          <TaskAgentSwitcher currentTaskId={selectedId} tree={tree} onOpenTask={onSelect} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Conversation activity"
                className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Activity"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 p-2">
              <div className="flex flex-wrap gap-1">
                <ActivityChip icon={<Activity />} label={`${stream.length} events`} />
                {tools.total > 0 && (
                  <ActivityChip
                    icon={<Wrench />}
                    label={`${tools.total} tools`}
                    tone={tools.active > 0 ? "warn" : "muted"}
                    detail={tools.failed > 0 ? `${tools.failed} failed` : undefined}
                  />
                )}
                {files.length > 0 && (
                  <ActivityChip
                    icon={<FileText />}
                    label={`${files.length} files`}
                    detail={files.slice(0, 2).join(", ")}
                  />
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <SessionChat
        activity={activity}
        active
        commands={commands}
        composerRef={composerRef}
        files={projectFiles}
        filesLoading={fileListQuery.isLoading}
        imageSupported={imageSupported}
        onOpenFile={openFile}
        onOpenFileDiff={openFileDiff}
        resolveFilePath={resolvePinnedFilePath}
        task={task}
        updates={updates}
        agents={agents}
        onOpenTask={openTask}
      />
    </Card>
  );
}

function latestCommands(updates: SessionUpdate[]): CommandInfo[] {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const update = updates[i];
    if (update.kind === "available_commands") {
      return update.commands;
    }
  }
  return [];
}

function summarizeTools(updates: SessionUpdate[]): {
  total: number;
  active: number;
  failed: number;
} {
  const tools = updates.filter(
    (u): u is Extract<SessionUpdate, { kind: "tool_call" }> => u.kind === "tool_call",
  );
  return {
    active: tools.filter((t) => t.status === "pending" || t.status === "in_progress").length,
    failed: tools.filter((t) => t.status === "failed").length,
    total: tools.length,
  };
}

function summarizeFiles(updates: SessionUpdate[]): string[] {
  const seen = new Set<string>();
  for (const update of updates) {
    if (update.kind === "file_edit") {
      seen.add(update.path.split("/").pop() || update.path);
    }
  }
  return Array.from(seen);
}

function ActivityChip({
  icon,
  label,
  detail,
  tone = "muted",
}: {
  icon: React.ReactElement;
  label: string;
  detail?: string;
  tone?: "muted" | "warn";
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs [&_svg]:size-3 [&_svg]:shrink-0",
        tone === "muted" && "bg-background/25 text-muted-foreground",
        tone === "warn" && "bg-warn/10 text-warn",
      )}
      title={detail || label}
    >
      {icon}
      <span className="shrink-0">{label}</span>
      {detail && <span className="min-w-0 truncate opacity-70">{detail}</span>}
    </span>
  );
}

/** A tool-call card whose output can be expanded/collapsed. Collapsed by default. */
function ToolCallLine({
  update,
  dot,
}: {
  update: Extract<SessionUpdate, { kind: "tool_call" }>;
  dot: string;
}) {
  const [open, setOpen] = useState(false);
  const hasContent = Boolean(update.content);
  const title = toolDisplayTitle(update);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-secondary/30">
      <button
        type="button"
        disabled={!hasContent}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          hasContent && "hover:bg-secondary/50",
        )}
      >
        {hasContent ? (
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
        ) : (
          <Wrench className={cn("size-3.5 shrink-0", dot)} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
        </span>
        {update.tool_kind && update.tool_kind !== "other" && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {update.tool_kind}
          </span>
        )}
        <span className={cn("shrink-0 text-xs", dot)}>{update.status.replace("_", " ")}</span>
      </button>
      {open && hasContent && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {update.content}
        </pre>
      )}
    </div>
  );
}

/**
 * A permission prompt with allow/deny buttons. Once answered it collapses to a
 * muted "responded" row — the update itself lingers in the stream, so we track
 * the answer locally to stop showing live buttons.
 */
function PermissionLine({
  update,
  taskId,
  resolvedOutcome,
}: {
  update: Extract<SessionUpdate, { kind: "permission_request" }>;
  taskId?: string;
  /** Outcome recorded in the stream — persists across reopen/restart. */
  resolvedOutcome?: string;
}) {
  const [clicked, setClicked] = useState<string | null>(null);
  const answered = clicked ?? resolvedOutcome ?? null;
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-md border px-2.5 py-2",
        answered ? "border-border bg-secondary/20" : "border-warn/40 bg-warn/5",
      )}
    >
      <p
        className={cn(
          "flex min-w-0 items-start gap-1.5",
          answered ? "text-muted-foreground" : "mb-2 text-warn",
        )}
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{update.title}</span>
        {answered && (
          <span className="shrink-0 whitespace-nowrap text-xs">✓ {answered.replace("_", " ")}</span>
        )}
      </p>
      {!answered &&
        (taskId ? (
          <div className="flex flex-wrap gap-1.5">
            {update.options.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={opt === "deny" ? "destructive" : "default"}
                onClick={() => {
                  setClicked(opt);
                  void daemon.request("session.permission", {
                    outcome: opt,
                    request_id: update.request_id,
                    task_id: taskId,
                  });
                }}
              >
                {opt.replace("_", " ")}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open the task to respond.</p>
        ))}
    </div>
  );
}

export function StreamLine({
  update,
  compact,
  taskId,
  resolved,
  resolveFilePath,
  onOpenFile,
  onOpenFileDiff,
  onOpenTask,
  project,
  thinkingActive,
  textStreaming,
}: {
  update: SessionUpdate;
  compact?: boolean;
  /** When set, permission requests render inline allow/deny buttons. */
  taskId?: string;
  /** Request_id → recorded outcome, from persisted permission_resolved updates. */
  resolved?: Record<string, string>;
  resolveFilePath?: FileLinkResolver;
  onOpenFile?: (path: string) => void;
  onOpenFileDiff?: (path: string, hunks?: EditHunk[]) => void;
  /** Opens a workflow stage/reviewer child from an inline timeline card. */
  onOpenTask?: (id: string) => void;
  /** Project root label retained after stripping the machine-specific prefix. */
  project?: string;
  /** True only for the thought block currently receiving streamed deltas. */
  thinkingActive?: boolean;
  /** True only for the assistant text block currently receiving deltas. */
  textStreaming?: boolean;
}) {
  switch (update.kind) {
    case "user_message":
      return (
        <div
          className={cn(
            "rounded-md border border-primary/15 bg-primary/[0.07] px-2.5 py-1.5 text-foreground",
            compact && "text-xs",
          )}
        >
          {compact ? (
            <Markdown
              className="text-current"
              resolveFilePath={resolveFilePath}
              onOpenFile={onOpenFile}
            >
              {`› ${update.text}`}
            </Markdown>
          ) : (
            <CollapsibleMarkdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
              {update.text}
            </CollapsibleMarkdown>
          )}
          {!!update.attachments?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {withOccurrenceKeys(update.attachments, (attachment) =>
                attachment.type === "file" ? `file:${attachment.path}` : `image:${attachment.name}`,
              ).map(({ item: attachment, key }) => (
                <span
                  key={key}
                  className="rounded border border-primary/20 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {attachment.type === "file" ? `@${attachment.path}` : `image: ${attachment.name}`}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "agent_text":
      return compact ? (
        <Markdown
          className="text-current"
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        >
          {update.text}
        </Markdown>
      ) : textStreaming ? (
        <BufferedMarkdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
          {update.text}
        </BufferedMarkdown>
      ) : (
        <Markdown resolveFilePath={resolveFilePath} onOpenFile={onOpenFile}>
          {update.text}
        </Markdown>
      );
    case "workflow_event":
      return <WorkflowEventLine update={update} compact={compact} onOpenTask={onOpenTask} />;
    case "agent_thought":
      return compact ? (
        <Markdown
          className="italic text-muted-foreground"
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        >
          {update.text}
        </Markdown>
      ) : (
        <ThinkingBlock
          text={update.text}
          streaming={Boolean(thinkingActive)}
          resolveFilePath={resolveFilePath}
          onOpenFile={onOpenFile}
        />
      );
    case "tool_call": {
      const title = toolDisplayTitle(update);
      const dot =
        update.status === "completed"
          ? "text-ok"
          : update.status === "failed"
            ? "text-destructive"
            : "text-warn";
      if (compact) {
        return (
          <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Wrench className={cn("size-3.5 shrink-0", dot)} />
            <span className="min-w-0 truncate text-foreground" title={title}>
              {title}
            </span>
          </p>
        );
      }
      return <ToolCallLine update={update} dot={dot} />;
    }
    case "file_edit":
      const filePath = resolveFilePath?.(update.path) ?? null;
      const displayPath = filePath
        ? project && filePath !== project && !filePath.startsWith(`${project}/`)
          ? `${project}/${filePath}`
          : filePath
        : update.path;
      const hasLineCounts = update.additions !== undefined || update.deletions !== undefined;
      return (
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <FilePen className="size-3.5 shrink-0 text-primary" />
          {filePath && onOpenFile ? (
            <button
              type="button"
              onClick={() => onOpenFile(filePath)}
              className="min-w-0 flex-1 truncate text-left text-primary hover:underline"
              title={`Open ${filePath}`}
            >
              {displayPath}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate" title={displayPath}>
              {displayPath}
            </span>
          )}
          {hasLineCounts && filePath && onOpenFileDiff ? (
            <button
              type="button"
              onClick={() => onOpenFileDiff(filePath, update.hunks)}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 tabular-nums hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Open diff for ${filePath}: ${update.additions ?? 0} lines added, ${update.deletions ?? 0} lines deleted`}
              title={`Open diff for ${filePath}`}
            >
              <span className="text-ok">+{update.additions ?? 0}</span>
              <span className="text-destructive">−{update.deletions ?? 0}</span>
            </button>
          ) : hasLineCounts ? (
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums"
              aria-label={`${update.additions ?? 0} lines added, ${update.deletions ?? 0} lines deleted`}
            >
              <span className="text-ok">+{update.additions ?? 0}</span>
              <span className="text-destructive">−{update.deletions ?? 0}</span>
            </span>
          ) : null}
        </p>
      );
    case "permission_request":
      return (
        <PermissionLine
          update={update}
          taskId={taskId}
          resolvedOutcome={resolved?.[update.request_id]}
        />
      );
    case "permission_resolved":
      // Metadata only — folded into the permission_request row above.
      return null;
    case "plan":
      if (compact) {
        const done = update.entries.filter((e) => e.status === "completed").length;
        return (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <ListTodo className="size-3.5 shrink-0" />
            plan · {done}/{update.entries.length}
          </p>
        );
      }
      return (
        <div className="rounded-md border bg-secondary/30 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ListTodo className="size-3.5" /> Plan
          </div>
          <ul className="space-y-1 text-sm">
            {update.entries.map((e) => (
              <li
                key={`${e.status}:${e.priority ?? ""}:${e.content}`}
                className="flex items-start gap-2"
              >
                <span
                  className={cn(
                    "mt-0.5",
                    e.status === "completed"
                      ? "text-ok"
                      : e.status === "in_progress"
                        ? "text-warn"
                        : "text-muted-foreground",
                  )}
                >
                  {e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : "○"}
                </span>
                <span
                  className={cn(e.status === "completed" && "text-muted-foreground line-through")}
                >
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "available_commands":
    case "prompt_capabilities":
    case "usage":
      // Metadata for the composer's slash menu — not shown inline.
      return null;
    case "turn_ended":
      if (compact) {
        return null;
      }
      return (
        <p className="text-center text-xs text-muted-foreground">
          Agent is waiting for the next instruction.
        </p>
      );
  }
}
