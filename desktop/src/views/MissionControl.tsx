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
import { buildLiveStripItems } from "../lib/liveStrip";
import { buildFailureList } from "../lib/taskFailures";
import { useUi } from "../store/ui";
import { DecisionQueue } from "./mission-control/DecisionQueue";
import { FailedSection } from "./mission-control/FailedSection";
import { FocusGroupPane } from "./mission-control/FocusPane";
import { LiveStrip } from "./mission-control/LiveStrip";
const TAB_LABEL: Record<string, string> = { live: "Live", needs: "Needs you", failed: "Failed", pinned: "Pinned" };

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
  const { width, containerRef } = useContainerWidth();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [boardHeight, setBoardHeight] = useState(0);
  const [pinnedWidth, setPinnedWidth] = useState(0);

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
  const liveStripItems = useMemo(
    () => buildLiveStripItems(live, state.sessionUpdates, new Set()),
    [live, state.sessionUpdates],
  );
  const attentionQueue = useMemo(
    () => buildAttentionQueue(state.snapshot.tasks, state.sessionUpdates),
    [state.sessionUpdates, state.snapshot.tasks],
  );
  const failures = useMemo(
    () => buildFailureList(state.snapshot.tasks, state.sessionUpdates),
    [state.snapshot.tasks, state.sessionUpdates],
  );
  const decisionItems = useMemo(
    () => attentionQueue.filter((item) => item.task.status !== "interrupted"),
    [attentionQueue],
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
  const activeTab = useUi((s) => s.missionControlTab);
  const setActiveTab = useUi((s) => s.setMissionControlTab);

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

  // Pinned grid's container mounts only when tab active — measure directly,
  // rAF loop covers the case where containerRef + width hook lag one frame.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTab !== "pinned") return;
    let raf = 0;
    const tick = () => {
      const w = containerRef.current?.clientWidth ?? 0;
      if (w > 0) setPinnedWidth(w);
      window.dispatchEvent(new Event("resize"));
      if (w === 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(() => {
      const w = containerRef.current?.clientWidth ?? 0;
      if (w > 0) setPinnedWidth(w);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [activeTab, width]);

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

        <div role="tablist" className="flex gap-2 border-b border-border">
          {(["live", "needs", "failed", "pinned"] as const).map((tab) => {
            const count =
              tab === "live"
                ? runningCount
                : tab === "needs"
                  ? decisionItems.length
                  : tab === "failed"
                    ? failures.length
                    : pinnedGroups.length;
            const active = activeTab === tab;
            return (
              <button
                key={tab}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {TAB_LABEL[tab]} <span className={`ml-1 rounded-full px-1.5 py-0.5 text-xs ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{count}</span>
              </button>
            );
          })}
        </div>

        {activeTab === "live" && (
          <section className="min-w-0">
            {liveStripItems.length > 0 ? (
              <LiveStrip items={liveStripItems} onOpenTask={onOpenTask} />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing running — start a task.</p>
            )}
          </section>
        )}
        {activeTab === "needs" && (
          <section className="min-w-0">
            <DecisionQueue items={decisionItems} onOpenTask={onOpenTask} hideHeader />
          </section>
        )}
        {activeTab === "failed" && (
          <section className="min-w-0">
            <FailedSection failures={failures} onOpenTask={onOpenTask} hideHeader />
          </section>
        )}
        {activeTab === "pinned" && (
          <section aria-labelledby="pinned-work-heading" className="min-w-0">
          <div ref={containerRef} className="min-w-0 w-full">
              {pinnedGroups.length > 0 ? (
                  <ReactGridLayout
                    key={pinnedWidth || width}
                    className="layout"
                    layout={layout}
                    width={pinnedWidth || width || 800}
                    gridConfig={{ cols: 4, rowHeight, margin: [8, 0], containerPadding: [0, 0] }}
                    dragConfig={{ enabled: true }}
                    resizeConfig={{ enabled: true, handles: ["se", "sw", "ne", "nw", "n", "s", "e", "w"] }}
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
                ) : (
                <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-muted-foreground">
                  <p className="text-sm text-foreground">No pinned sessions.</p>
                  <p className="max-w-md text-xs">Pin sessions from the sidebar when you want them on the Mission Control board.</p>
                </div>
              )}
            </div>
          </section>
        )}

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
