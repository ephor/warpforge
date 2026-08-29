import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  FolderTree,
  Inbox,
  LayoutGrid,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";

import { SidebarTaskRow } from "@/components/SidebarTaskRow";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateBanner } from "@/components/UpdateBanner";
import UpdateControl from "@/components/UpdateControl";
import { buildAttentionQueue } from "@/lib/attentionRail";
import { buildTaskGroupIndex, isTaskGroupPinned, setTaskGroupPinned } from "@/lib/taskGroups";
import { cn } from "@/lib/utils";

import type { ConnectionState, DaemonState } from "../daemon";
import { useUi } from "../store/ui";
import type { View } from "../store/ui";
import {
  ancestorIds,
  buildSidebarRows,
  isSettledTask,
  needsHuman,
  projectNames,
  resolveTaskState,
  rowHeight,
  sortProjectsByActivity,
  type SidebarRow,
} from "./Sidebar.logic";

/**
 * The application sidebar: brand, New task, view nav, then the workspace tree
 * of projects → root tasks → subtasks, and Settings in the footer.
 *
 * The tree is the only structure — there is no "Needs you" block and no
 * "Workspace" heading above it. Both were noise: the first collected every
 * finished task awaiting review (dozens of rows, so the word stopped meaning
 * anything) and the second labelled the one thing on screen. What a row needs
 * from the user is said inline instead, by the rare glyph `Sidebar.logic.ts`
 * allows it.
 *
 * Row content follows one rhythm (`gap-2`, 13px titles, `tnum` for every
 * number) and every secondary affordance stays hidden until hover or focus.
 *
 * Rows are flattened into one virtualized list by `Sidebar.logic.ts`; nesting is
 * a per-row `depth` rather than nested DOM containers.
 */

const NAV: { id: View; label: string; icon: typeof LayoutGrid }[] = [
  { icon: LayoutGrid, id: "control", label: "Mission Control" },
  { icon: FolderTree, id: "projects", label: "Projects" },
];

/**
 * Closes a project group with the history it hides: "12 done". Settled work is
 * archive material, but archive you cannot open is just deletion, so the row
 * stays one click from the tasks — quiet enough to skip, present enough to find.
 */
function ShelfRow({
  row,
  onToggle,
}: {
  row: Extract<SidebarRow, { kind: "shelf" }>;
  onToggle: (project: string) => void;
}) {
  return (
    <button
      type="button"
      data-shelf={row.project}
      aria-expanded={row.expanded}
      aria-label={`${row.expanded ? "Hide" : "Show"} ${row.count} done task${
        row.count === 1 ? "" : "s"
      } in ${row.project}`}
      onClick={() => onToggle(row.project)}
      className="flex h-6 w-full items-center gap-1.5 rounded-md pl-2 pr-2 text-left text-[11px] text-muted-foreground/45 transition-colors hover:bg-accent/50 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ChevronRight
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", row.expanded && "rotate-90")}
      />
      <span className="tnum">{row.count}</span>
      <span className="min-w-0 truncate">done</span>
    </button>
  );
}

function EmptyRow({ row }: { row: Extract<SidebarRow, { kind: "empty" }> }) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground/50">
      <Inbox aria-hidden className="mt-px size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0">
        {row.label}
        {row.hint && <span className="mt-0.5 block text-muted-foreground/40">{row.hint}</span>}
      </span>
    </div>
  );
}

function ProjectRow({
  row,
  onToggle,
  onOpenProject,
  onSettle,
  onSettleHover,
}: {
  row: Extract<SidebarRow, { kind: "project" }>;
  onToggle: (name: string) => void;
  onOpenProject: (name: string) => void;
  onSettle: (ids: string[]) => void;
  /** True while the pointer (or focus) is on the bulk-settle button, so the
   *  tree can highlight exactly the rows it would settle. */
  onSettleHover?: (hovering: boolean) => void;
}) {
  const settle = row.settleIds.length > 0;
  const preview = row.settlePreview.some(Boolean)
    ? ` — ${row.settlePreview.join(", ")}`
    : "";
  const settleTitle = `Settle ${row.settleIds.length} finished turn${
    row.settleIds.length === 1 ? "" : "s"
  } with no changes (reversible per task)${preview}`;
  return (
    <div className="group/proj relative mt-1">
      <button
        type="button"
        data-project={row.name}
        aria-expanded={row.expanded}
        aria-label={`${row.expanded ? "Collapse" : "Expand"} project ${row.name}`}
        onClick={() => onToggle(row.name)}
        className="flex h-7 w-full items-center gap-2 rounded-md pl-1 pr-2 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 transition-transform",
            row.expanded && "rotate-90",
          )}
        />
        <span
          aria-hidden
          className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-primary/15 text-[10px] font-bold uppercase leading-none text-primary"
        >
          {row.name.slice(0, 1)}
        </span>
        <strong
          className={cn(
            "min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight",
            row.selected ? "text-foreground" : "text-foreground/70",
          )}
        >
          {row.name}
        </strong>
        {row.attentionCount > 0 && (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-warn transition-opacity group-hover/proj:opacity-0"
          />
        )}
        <span
          title={`${row.count} active task${row.count === 1 ? "" : "s"}`}
          className="tnum shrink-0 text-[11px] text-muted-foreground/45 transition-opacity group-hover/proj:opacity-0"
        >
          {row.count}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Open ${row.name} in Projects`}
        title="Open in Projects"
        onClick={() => onOpenProject(row.name)}
        className="pointer-events-none absolute right-1 top-1/2 grid size-[22px] -translate-y-1/2 place-items-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/proj:pointer-events-auto group-hover/proj:opacity-100"
      >
        <ArrowUpRight className="size-3.5" />
      </button>
      {settle && (
        <button
          type="button"
          aria-label={settleTitle}
          title={settleTitle}
          onClick={() => onSettle(row.settleIds)}
          onMouseEnter={() => onSettleHover?.(true)}
          onMouseLeave={() => onSettleHover?.(false)}
          onFocus={() => onSettleHover?.(true)}
          onBlur={() => onSettleHover?.(false)}
          className="pointer-events-none absolute right-[30px] top-1/2 grid size-[22px] -translate-y-1/2 place-items-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/proj:pointer-events-auto group-hover/proj:opacity-100"
        >
          <CheckCheck className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function RailButton({
  label,
  active,
  count,
  hot,
  icon: Icon,
  onClick,
  ariaExpanded,
}: {
  label: string;
  active?: boolean;
  count?: number;
  hot?: boolean;
  icon: typeof LayoutGrid;
  onClick: () => void;
  ariaExpanded?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-expanded={ariaExpanded}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative grid size-9 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <Icon className={cn("size-4", active && "text-primary")} />
          {count !== undefined && count > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute right-1 top-1 size-1.5 rounded-full",
                hot ? "bg-warn" : "bg-muted-foreground/50",
              )}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
        {count !== undefined && count > 0 && <span className="tnum text-warn"> {count}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Daemon connection, reduced to the one thing that actually needs a glance:
 * is it there. The state name and any error used to sit in the topbar as
 * text ("daemon" / "connecting" / a raw error message) — permanent chrome for
 * a condition that's true almost all the time. Now it's a dot, and the detail
 * moves to a tooltip so a long error can't push or wrap the header layout.
 */
function ConnectionDot({
  connection,
  connectionError,
}: {
  connection: ConnectionState;
  connectionError: string | null;
}) {
  const connected = connection === "connected";
  const label =
    (connected ? "Daemon connected" : connectionError) ||
    `Daemon ${connection === "connecting" ? "connecting…" : "disconnected"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            connected ? "bg-ok" : "bg-warn animate-pulse",
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

interface SidebarProps {
  state: DaemonState;
  view: View;
  openTaskId: string | null;
  collapsed: boolean;
  /** Default to "looks fine" rather than forcing every caller (mainly tests)
      to pass connection state that has nothing to do with what they check. */
  connection?: ConnectionState;
  connectionError?: string | null;
  onToggleCollapsed: () => void;
  onSelectView: (view: View) => void;
  onOpenTask: (id: string) => void;
  onNewTask: () => void;
  onOpenProject: (name: string) => void;
  onOpenSettings: () => void;
  /** Bulk-settle every diff-less finished turn (the same reversible settle
   *  as the per-row check button). */
  onSettleFinishedTurns?: (ids: string[]) => void;
}

function Sidebar({
  state,
  view,
  openTaskId,
  collapsed,
  connection = "connected",
  connectionError = null,
  onToggleCollapsed,
  onSelectView,
  onOpenTask,
  onNewTask,
  onOpenProject,
  onOpenSettings,
  onSettleFinishedTurns,
}: SidebarProps) {
  const pinned = useUi((store) => store.pinnedTaskIds);
  const setPinnedTaskIds = useUi((store) => store.setPinnedTaskIds);
  const attentionTargetId = useUi((store) => store.attentionTargetId);
  const attentionTargetNonce = useUi((store) => store.attentionTargetNonce);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [expandedShelves, setExpandedShelves] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledTargetNonce = useRef<number | null>(null);

  const tasks = state.snapshot.tasks;
  const nowSec = Math.floor(Date.now() / 1000);

  // While the pointer rests on a project's bulk-settle button, the tree dims
  // exactly the rows that button would settle — the preview IS the list.
  const [settlingProject, setSettlingProject] = useState<string | null>(null);

  const queue = useMemo(
    () => buildAttentionQueue(tasks, state.sessionUpdates),
    [state.sessionUpdates, tasks],
  );
  const taskGroupIndex = useMemo(() => buildTaskGroupIndex(tasks), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  // Recomputed on task-set changes only — deliberately not on `nowSec`, so the
  // order cannot shift under the pointer on a clock tick.
  const names = useMemo(() => {
    const known = projectNames({ projects: state.snapshot.projects });
    return sortProjectsByActivity(known, tasks);
  }, [state.snapshot.projects, tasks]);
  const openProject = openTaskId ? (taskById.get(openTaskId)?.project ?? null) : null;

  const forceVisibleTaskIds = useMemo(
    () => new Set([openTaskId, attentionTargetId].filter((id): id is string => id !== null)),
    [attentionTargetId, openTaskId],
  );

  /**
   * The badge counts what genuinely wants a human right now, not the whole
   * attention queue: that queue also holds every finished task awaiting review,
   * so it reads in the dozens and a permanent "23" is not a signal.
   */
  const blockingCount = useMemo(() => {
    const attentionIds = new Set(queue.map((item) => item.task.id));
    return tasks.filter(
      (task) =>
        !isSettledTask(task) &&
        needsHuman(resolveTaskState(task, { attention: attentionIds.has(task.id), nowSec })),
    ).length;
  }, [nowSec, queue, tasks]);

  // A task the user was sent to (toast, wizard) must be reachable even when its
  // parent group or project is collapsed.
  useEffect(() => {
    const target = attentionTargetId ?? openTaskId;
    const parents = [
      ...ancestorIds(taskById, attentionTargetId),
      ...ancestorIds(taskById, openTaskId),
    ];
    if (parents.length > 0) {
      setExpandedTaskIds((current) => {
        if (parents.every((id) => current.has(id))) return current;
        const next = new Set(current);
        for (const id of parents) next.add(id);
        return next;
      });
    }
    const project = target ? (taskById.get(target)?.project ?? null) : null;
    if (project === null) return;
    setCollapsedProjects((current) => {
      if (!current.has(project)) return current;
      const next = new Set(current);
      next.delete(project);
      return next;
    });
  }, [attentionTargetId, attentionTargetNonce, openTaskId, taskById]);

  const rows = useMemo(
    () =>
      buildSidebarRows({
        collapsedProjects,
        expandedShelves,
        expandedTaskIds,
        forceVisibleTaskIds,
        forest: taskGroupIndex.forest,
        nowSec,
        openProject,
        projectOrder: names,
        queue,
        tasks,
      }),
    [
      collapsedProjects,
      expandedShelves,
      expandedTaskIds,
      forceVisibleTaskIds,
      names,
      nowSec,
      openProject,
      queue,
      taskGroupIndex.forest,
      tasks,
    ],
  );

  const settleMarkedIds = useMemo(() => {
    if (!settlingProject) return null;
    for (const row of rows) {
      if (row.kind === "project" && row.name === settlingProject) {
        return new Set(row.settleIds);
      }
    }
    return null;
  }, [rows, settlingProject]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? rowHeight(row) : 34;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
  });

  useEffect(() => {
    if (!attentionTargetId || handledTargetNonce.current === attentionTargetNonce) return;
    const index = rows.findIndex((row) => row.kind === "task" && row.task.id === attentionTargetId);
    if (index < 0) return;
    handledTargetNonce.current = attentionTargetNonce;
    virtualizer.scrollToIndex(index, { align: "center" });
    const frame = window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(attentionTargetId)}"]`)
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attentionTargetId, attentionTargetNonce, rows, virtualizer]);

  const toggleTask = useCallback((taskId: string) => {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleProject = useCallback((name: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleShelf = useCallback((name: string) => {
    setExpandedShelves((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handlePin = useCallback(
    (taskId: string) => {
      setPinnedTaskIds(
        setTaskGroupPinned(
          taskGroupIndex,
          pinned,
          taskId,
          !isTaskGroupPinned(taskGroupIndex, pinned, taskId),
        ),
      );
    },
    [pinned, setPinnedTaskIds, taskGroupIndex],
  );

  const handleOpenProjects = useCallback((name: string) => onOpenProject(name), [onOpenProject]);
  const navCount = useCallback(
    (id: View) => (id === "control" ? blockingCount : id === "projects" ? names.length : 0),
    [blockingCount, names.length],
  );

  if (collapsed) {
    return (
      <TooltipProvider delayDuration={300}>
        <aside
          data-testid="sidebar"
          data-collapsed
          className="flex h-full min-h-0 min-w-0 flex-col items-center gap-1 border-r border-border bg-card py-2"
        >
          <div className="flex h-10 shrink-0 items-center">
            <RailButton
              icon={PanelLeft}
              label="Expand sidebar"
              onClick={onToggleCollapsed}
              ariaExpanded={false}
            />
          </div>
          <ConnectionDot connection={connection} connectionError={connectionError} />
          <RailButton icon={Plus} label="New task" onClick={onNewTask} />
          <span aria-hidden className="my-1 h-px w-6 bg-border" />
          {NAV.map((item) => (
            <RailButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={view === item.id && !openTaskId}
              count={navCount(item.id)}
              hot={item.id === "control"}
              onClick={() => onSelectView(item.id)}
            />
          ))}
          <span className="flex-1" />
          <UpdateControl daemonConnected={connection === "connected"} />
          <RailButton icon={Settings} label="Settings" onClick={onOpenSettings} />
        </aside>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <aside
        data-testid="sidebar"
        className="flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-card"
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3.5">
          <div className="flex items-center gap-1.5">
            <strong className="select-none text-[11px] font-bold uppercase tracking-[0.2em] text-foreground">
              WARP<span className="text-primary">FORGE</span>
            </strong>
            <ConnectionDot connection={connection} connectionError={connectionError} />
          </div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            aria-expanded
            className="grid size-6 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        <div className="shrink-0 px-2 pb-2 pt-2.5">
          <button
            type="button"
            onClick={onNewTask}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-primary/40 bg-primary/15 px-2.5 text-left text-[13px] font-semibold text-primary transition-colors hover:border-primary/60 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">New task</span>
            <kbd className="tnum shrink-0 font-sans text-[10px] font-medium text-primary/60">
              ⌘N
            </kbd>
          </button>
        </div>

        <nav className="flex shrink-0 flex-col gap-px border-b border-border px-2 pb-2.5">
          {NAV.map((item) => {
            const active = view === item.id && !openTaskId;
            const count = navCount(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  active
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4 shrink-0",
                    active ? "text-primary" : "text-muted-foreground/60",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      "tnum shrink-0 text-[11px]",
                      item.id === "control"
                        ? "font-semibold text-warn"
                        : "text-muted-foreground/50",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-3 [scrollbar-gutter:stable]"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full [content-visibility:auto]"
                  style={{
                    containIntrinsicSize: `auto ${virtualRow.size}px`,
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.kind === "empty" ? (
                    <EmptyRow row={row} />
                  ) : row.kind === "project" ? (
                    <ProjectRow
                      row={row}
                      onToggle={toggleProject}
                      onOpenProject={handleOpenProjects}
                      onSettle={onSettleFinishedTurns ?? (() => {})}
                      onSettleHover={
                        onSettleFinishedTurns
                          ? (hovering) => setSettlingProject(hovering ? row.name : null)
                          : undefined
                      }
                    />
                  ) : row.kind === "shelf" ? (
                    <ShelfRow row={row} onToggle={toggleShelf} />
                  ) : (
                    <div
                      className={cn(
                        "transition-opacity",
                        settleMarkedIds?.has(row.task.id) && "opacity-40",
                      )}
                    >
                      <SidebarTaskRow
                        task={row.task}
                        state={row.state}
                        depth={row.depth}
                        active={openTaskId === row.task.id}
                        childCount={row.childCount}
                        expanded={row.expanded}
                        pinned={isTaskGroupPinned(taskGroupIndex, pinned, row.task.id)}
                        nowSec={nowSec}
                        onOpen={onOpenTask}
                        onToggle={toggleTask}
                        onPin={handlePin}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <footer className="flex shrink-0 flex-col gap-1.5 border-t border-border px-2 py-2">
          <UpdateBanner />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex h-8 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Settings className="size-4 shrink-0 text-muted-foreground/60" />
              Settings
            </button>
            {/* Update lives beside Settings, not buried inside it — the "new
                version" dot needs to stay visible the way it did in the topbar,
                just relocated rather than lost. */}
            <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
            <UpdateControl daemonConnected={connection === "connected"} />
          </div>
        </footer>
      </aside>
    </TooltipProvider>
  );
}

export default memo(Sidebar);
