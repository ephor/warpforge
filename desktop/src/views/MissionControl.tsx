import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import type { LayoutItem } from "react-grid-layout";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  buildTaskGroupIndex,
  isSettledTask,
  resolvePinnedTaskGroups,
  setTaskGroupPinned,
  type TaskTree,
} from "@/lib/taskGroups";

import type { DaemonState } from "../daemon";
import { buildAttentionQueue } from "../lib/attentionRail";
import { useUi } from "../store/ui";
import { DecisionQueue } from "./mission-control/DecisionQueue";
import { FocusGroupPane } from "./mission-control/FocusPane";
import { OverviewMetric } from "./mission-control/OverviewMetric";

export { StreamLine } from "./mission-control/StreamLine";
import { useGridAutoScroll } from "./mission-control/useGridAutoScroll";

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

  const {
    beginGridInteraction,
    endGridInteraction,
    beginResizeInteraction,
    handleResize,
    revealResizedCard,
  } = useGridAutoScroll(scrollAreaRef);

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

  const GRID_SCROLL_GAP = 8;
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
