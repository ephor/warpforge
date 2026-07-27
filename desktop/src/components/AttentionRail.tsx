import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, ChevronDown, ChevronRight, Info, Workflow } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  STATUS_LABEL,
  STATUS_RANK,
  buildAttentionQueue,
  partitionRailTasks,
  taskStatusRank,
  type AttentionItem,
  type RailPartition,
  type RailSortMode,
} from "@/lib/attentionRail";
import { type PermissionUpdate } from "@/lib/sessionPermissions";
import type { StatusKind } from "@/lib/statusMeta";
import {
  buildTaskGroupIndex,
  flattenTaskTree,
  isTaskGroupPinned,
  setTaskGroupPinned,
  taskGroupCounts,
  type TaskTree,
} from "@/lib/taskGroups";
import { cn } from "@/lib/utils";

import type { DaemonState } from "../daemon";
import type { TaskInfo } from "../protocol";
import { useUi } from "../store/ui";
import { AgentBadge } from "./AgentBadge";
import {
  RailFilterBar,
  type FilterMode,
  type GroupMode,
  type SortMode,
} from "./attention/RailFilterBar";
import SessionRailCard from "./SessionRailCard";
import { StatusBadge } from "./StatusBadge";

type ShelfId = "needs-you" | "working" | "snoozed" | "settled";

const SHELF_ORDER: ShelfId[] = ["working", "needs-you", "snoozed", "settled"];
const SHELF_LABEL: Record<ShelfId, string> = {
  "needs-you": "Needs you",
  working: "Working",
  snoozed: "Later",
  settled: "Handled",
};
const DEFAULT_COLLAPSED_SHELVES = new Set<ShelfId>(["snoozed", "settled"]);
const SETTLED_PAGE_SIZE = 20;

interface GroupInfo {
  key: string;
  label: string;
  rank: number;
}

type RailRow =
  | { key: string; kind: "shelf"; shelf: ShelfId; label: string; count: number }
  | { key: string; kind: "group"; shelf: "working"; group: GroupInfo; count: number }
  | { key: string; kind: "task"; task: TaskInfo; shelf: ShelfId }
  | { key: string; kind: "task-group"; unit: RailUnit }
  | { key: string; kind: "load-more"; shelf: "settled" };

interface RailUnit {
  key: string;
  representative: TaskInfo;
  shelf: ShelfId;
  tasks: TaskInfo[];
  tree: TaskTree;
}

const SHELF_PRIORITY: Record<ShelfId, number> = {
  "needs-you": 0,
  working: 1,
  snoozed: 2,
  settled: 3,
};

function statusGroup(task: TaskInfo, permission: PermissionUpdate | undefined): GroupInfo {
  if (permission) {
    return { key: "permission", label: "Permission", rank: 0 };
  }
  return {
    key: task.status,
    label: STATUS_LABEL[task.status],
    rank: STATUS_RANK[task.status],
  };
}

function groupInfo(
  task: TaskInfo,
  mode: Exclude<GroupMode, "none">,
  permission: PermissionUpdate | undefined,
): GroupInfo {
  if (mode === "status") {
    return statusGroup(task, permission);
  }
  const value = mode === "project" ? task.project : task.agent;
  return { key: value, label: value, rank: 0 };
}

function shelfSortComparator(
  a: TaskInfo,
  b: TaskInfo,
  sort: RailSortMode,
  attentionById: ReadonlyMap<string, AttentionItem>,
): number {
  if (sort === "created") {
    return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  }
  if (sort === "project") {
    return (
      a.project.localeCompare(b.project) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
    );
  }
  if (sort === "status") {
    const aRank = taskStatusRank(a, attentionById.get(a.id)?.permission);
    const bRank = taskStatusRank(b, attentionById.get(b.id)?.permission);
    return aRank - bRank || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  }
  return (
    b.updatedAt - a.updatedAt ||
    taskStatusRank(a, attentionById.get(a.id)?.permission) -
      taskStatusRank(b, attentionById.get(b.id)?.permission) ||
    a.id.localeCompare(b.id)
  );
}

function queryMatch(task: TaskInfo, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return (
    task.prompt.toLocaleLowerCase().includes(normalizedQuery) ||
    task.project.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function filterShelfTasks(
  tasks: TaskInfo[],
  normalizedQuery: string,
  sort: RailSortMode,
  attentionById: ReadonlyMap<string, AttentionItem>,
  runningOnly: boolean,
): TaskInfo[] {
  const filtered = tasks.filter((task) => {
    if (runningOnly && task.status !== "running") return false;
    return queryMatch(task, normalizedQuery);
  });
  return [...filtered].sort((a, b) => shelfSortComparator(a, b, sort, attentionById));
}

interface Props {
  state: DaemonState;
  onOpenTask: (id: string) => void;
}

function AttentionRail({ state, onOpenTask }: Props) {
  const pinned = useUi((store) => store.pinnedTaskIds);
  const setPinnedTaskIds = useUi((store) => store.setPinnedTaskIds);
  const attentionTargetId = useUi((store) => store.attentionTargetId);
  const attentionTargetNonce = useUi((store) => store.attentionTargetNonce);
  const [sort, setSort] = useState<SortMode>("updated");
  const [group, setGroup] = useState<GroupMode>("none");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [query, setQuery] = useState("");
  const [collapsedShelves, setCollapsedShelves] = useState<Set<ShelfId>>(DEFAULT_COLLAPSED_SHELVES);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [expandedTaskGroups, setExpandedTaskGroups] = useState<Set<string>>(() => new Set());
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [settledPageLimit, setSettledPageLimit] = useState(SETTLED_PAGE_SIZE);
  const [visitedWokeIds, setVisitedWokeIds] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledTargetNonce = useRef<number | null>(null);
  const skipSettledResetRef = useRef(false);

  const queue = useMemo(
    () => buildAttentionQueue(state.snapshot.tasks, state.sessionUpdates),
    [state.sessionUpdates, state.snapshot.tasks],
  );
  const attentionById = useMemo(() => new Map(queue.map((item) => [item.task.id, item])), [queue]);
  const taskGroupIndex = useMemo(
    () => buildTaskGroupIndex(state.snapshot.tasks),
    [state.snapshot.tasks],
  );
  const childAgentsByTaskId = useMemo(() => {
    const map = new Map<string, string[]>();
    const build = (tree: TaskTree) => {
      const children = tree.children;
      if (children.length > 0) {
        const agents = [...new Set(children.map((c) => c.task.agent))];
        map.set(tree.task.id, agents);
        for (const child of children) build(child);
      }
    };
    for (const tree of taskGroupIndex.forest) build(tree);
    return map;
  }, [taskGroupIndex]);
  const pinnedSet = useMemo(
    () =>
      new Set(
        pinned
          .map((id) => taskGroupIndex.rootByTaskId.get(id)?.task.id)
          .filter((id): id is string => Boolean(id)),
      ),
    [pinned, taskGroupIndex],
  );
  const effectiveGroup: GroupMode = sort === "status" || sort === "project" ? sort : group;

  const partition: RailPartition = useMemo(
    () => partitionRailTasks(state.snapshot.tasks, attentionById, nowSec),
    [state.snapshot.tasks, attentionById, nowSec],
  );

  useEffect(() => {
    const snoozedTasks = partition.snoozed;
    if (snoozedTasks.length === 0) return;
    let nextWake = Infinity;
    for (const task of snoozedTasks) {
      const until = task.snoozedUntil;
      if (typeof until === "number" && until > nowSec && until < nextWake) {
        nextWake = until;
      }
    }
    if (!Number.isFinite(nextWake)) return;
    const rawDelayMs = Math.max(0, (nextWake - nowSec) * 1000 + 50);
    const delayMs = Math.min(rawDelayMs, 2_147_483_647);
    const timer = window.setTimeout(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [partition.snoozed, nowSec]);

  const visibleShelves = useMemo((): ShelfId[] => {
    if (filter === "attention") return ["needs-you"];
    if (filter === "running") return ["working"];
    return SHELF_ORDER;
  }, [filter]);

  const activeWokeIds = useMemo(() => {
    const result = new Set<string>();
    for (const id of partition.wokeIds) {
      if (!visitedWokeIds.has(id)) result.add(id);
    }
    return result;
  }, [partition.wokeIds, visitedWokeIds]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const runningOnly = filter === "running";

  const taskShelfById = useMemo(() => {
    const map = new Map<string, ShelfId>();
    for (const task of partition.needsYou) map.set(task.id, "needs-you");
    for (const task of partition.working) map.set(task.id, "working");
    for (const task of partition.snoozed) map.set(task.id, "snoozed");
    for (const task of partition.settled) map.set(task.id, "settled");
    return map;
  }, [partition]);

  const unitMap = useMemo(() => {
    const map = new Map<ShelfId, RailUnit[]>(SHELF_ORDER.map((shelf) => [shelf, []]));

    for (const tree of taskGroupIndex.forest) {
      const rootId = tree.task.id;
      const activeTasks = flattenTaskTree(tree).filter((task) => taskShelfById.has(task.id));
      if (activeTasks.length === 0) continue;

      const visibleTasks = filterShelfTasks(
        activeTasks,
        normalizedQuery,
        sort,
        attentionById,
        runningOnly,
      );
      if (visibleTasks.length === 0) continue;

      const urgentShelf = activeTasks.reduce<ShelfId>((current, task) => {
        const candidate = taskShelfById.get(task.id) ?? "working";
        return SHELF_PRIORITY[candidate] < SHELF_PRIORITY[current] ? candidate : current;
      }, "settled");
      const hasWorkingMember = activeTasks.some((task) => taskShelfById.get(task.id) === "working");
      if (
        filter === "attention" &&
        !activeTasks.some((task) => taskShelfById.get(task.id) === "needs-you")
      ) {
        continue;
      }
      const shelf: ShelfId =
        filter === "attention"
          ? "needs-you"
          : runningOnly
            ? "working"
            : hasWorkingMember
              ? "working"
              : urgentShelf;
      const representative =
        visibleTasks.find((task) => task.id === rootId && taskShelfById.get(task.id) === shelf) ??
        visibleTasks.find((task) => taskShelfById.get(task.id) === shelf) ??
        visibleTasks.find((task) => task.id === rootId) ??
        visibleTasks[0];

      map.get(shelf)?.push({
        key: rootId,
        representative,
        shelf,
        tasks: visibleTasks,
        tree,
      });
    }

    for (const units of map.values()) {
      units.sort((a, b) =>
        shelfSortComparator(a.representative, b.representative, sort, attentionById),
      );
    }
    return map;
  }, [
    attentionById,
    filter,
    normalizedQuery,
    runningOnly,
    sort,
    taskGroupIndex.forest,
    taskShelfById,
  ]);

  const rows = useMemo(() => {
    const result: RailRow[] = [];

    for (const shelf of visibleShelves) {
      const units = unitMap.get(shelf) ?? [];
      const isCollapsed = collapsedShelves.has(shelf);
      const taskCount = units.reduce(
        (count, unit) =>
          count +
          unit.tasks.filter((task) => runningOnly || taskShelfById.get(task.id) === shelf).length,
        0,
      );

      result.push({
        key: `shelf:${shelf}`,
        kind: "shelf",
        shelf,
        label: SHELF_LABEL[shelf],
        count: taskCount,
      });

      if (isCollapsed) continue;

      if (shelf === "working" && effectiveGroup !== "none") {
        const grouped = new Map<string, { info: GroupInfo; units: RailUnit[] }>();
        for (const unit of units) {
          const task = unit.representative;
          const info = groupInfo(task, effectiveGroup, attentionById.get(task.id)?.permission);
          const existing = grouped.get(info.key);
          if (existing) {
            existing.units.push(unit);
          } else {
            grouped.set(info.key, { info, units: [unit] });
          }
        }

        const groups = [...grouped.values()].sort((a, b) => {
          if (effectiveGroup === "status") {
            return a.info.rank - b.info.rank;
          }
          return a.info.label.localeCompare(b.info.label);
        });

        for (const { info, units: groupedUnits } of groups) {
          const groupKey = `working:${effectiveGroup}:${info.key}`;
          const groupCollapsed = collapsedGroups.has(groupKey);
          result.push({
            key: `group:${groupKey}`,
            kind: "group",
            shelf: "working",
            group: info,
            count: groupedUnits.reduce((count, unit) => count + unit.tasks.length, 0),
          });
          if (groupCollapsed) continue;
          for (const unit of groupedUnits) {
            if (unit.tree.children.length > 0) {
              result.push({
                key: `task-group:${shelf}:${unit.key}`,
                kind: "task-group",
                unit,
              });
            } else {
              result.push({
                key: `task:${unit.representative.id}`,
                kind: "task",
                task: unit.representative,
                shelf,
              });
            }
          }
        }
      } else {
        const isSettled = shelf === "settled";
        const visibleUnits = isSettled ? units.slice(0, settledPageLimit) : units;
        for (const unit of visibleUnits) {
          if (unit.tree.children.length > 0) {
            result.push({
              key: `task-group:${shelf}:${unit.key}`,
              kind: "task-group",
              unit,
            });
          } else {
            result.push({
              key: `task:${unit.representative.id}`,
              kind: "task",
              task: unit.representative,
              shelf,
            });
          }
        }
        if (isSettled && units.length > settledPageLimit) {
          result.push({ key: "settled:load-more", kind: "load-more", shelf: "settled" });
        }
      }
    }

    return result;
  }, [
    attentionById,
    collapsedGroups,
    collapsedShelves,
    effectiveGroup,
    settledPageLimit,
    runningOnly,
    taskShelfById,
    unitMap,
    visibleShelves,
  ]);

  const totalAttentionCount = queue.length;

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return 120;
      if (row.kind === "shelf") return 32;
      if (row.kind === "group") return 28;
      if (row.kind === "load-more") return 32;
      if (row.kind === "task-group") return 150;
      return 120;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: 5,
  });

  useEffect(() => {
    if (!attentionTargetId) return;
    setQuery("");
    setFilter("all");
    setCollapsedGroups(new Set());
    const targetRoot = taskGroupIndex.rootByTaskId.get(attentionTargetId);
    if (targetRoot?.children.length) {
      setExpandedTaskGroups((current) => new Set(current).add(targetRoot.task.id));
    }

    let targetShelf: ShelfId | null = null;
    if (partition.needsYou.some((t) => t.id === attentionTargetId)) targetShelf = "needs-you";
    else if (partition.working.some((t) => t.id === attentionTargetId)) targetShelf = "working";
    else if (partition.snoozed.some((t) => t.id === attentionTargetId)) targetShelf = "snoozed";
    else if (partition.settled.some((t) => t.id === attentionTargetId)) targetShelf = "settled";

    if (targetShelf) {
      setCollapsedShelves((current) => {
        const next = new Set(current);
        next.delete(targetShelf!);
        return next;
      });
      if (targetShelf === "settled") {
        skipSettledResetRef.current = true;
        setSettledPageLimit(partition.settled.length);
      }
    } else {
      setCollapsedShelves(new Set());
    }
  }, [attentionTargetId, attentionTargetNonce, partition, taskGroupIndex.rootByTaskId]);

  const materialKey = `${query}|${filter}|${state.snapshot.tasks.length}`;
  const prevMaterialKeyRef = useRef(materialKey);
  useEffect(() => {
    if (prevMaterialKeyRef.current === materialKey) return;
    prevMaterialKeyRef.current = materialKey;
    if (skipSettledResetRef.current) {
      skipSettledResetRef.current = false;
      return;
    }
    setSettledPageLimit(SETTLED_PAGE_SIZE);
  }, [materialKey]);

  useEffect(() => {
    if (!attentionTargetId || handledTargetNonce.current === attentionTargetNonce) return;
    const index = rows.findIndex(
      (row) =>
        (row.kind === "task" && row.task.id === attentionTargetId) ||
        (row.kind === "task-group" &&
          flattenTaskTree(row.unit.tree).some((task) => task.id === attentionTargetId)),
    );
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

  const handleOpen = useCallback(
    (taskId: string) => {
      const wasWoke = activeWokeIds.has(taskId);
      if (wasWoke) {
        setVisitedWokeIds((prev) => {
          const next = new Set(prev);
          next.add(taskId);
          return next;
        });
      }
      try {
        onOpenTask(taskId);
      } catch {
        if (wasWoke) {
          setVisitedWokeIds((prev) => {
            const next = new Set(prev);
            next.delete(taskId);
            return next;
          });
        }
      }
    },
    [onOpenTask, activeWokeIds],
  );
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
  const handleTogglePreview = useCallback((taskId: string) => {
    setExpandedTaskId((current) => (current === taskId ? null : taskId));
  }, []);
  const toggleShelf = useCallback((shelf: ShelfId) => {
    setCollapsedShelves((current) => {
      const next = new Set(current);
      if (next.has(shelf)) {
        next.delete(shelf);
      } else {
        next.add(shelf);
      }
      return next;
    });
  }, []);
  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);
  const toggleTaskGroup = useCallback((rootId: string) => {
    setExpandedTaskGroups((current) => {
      const next = new Set(current);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }, []);
  const handleGroupChange = useCallback(
    (value: string) => {
      setGroup(value as GroupMode);
      if (sort === "status" || sort === "project") {
        setSort("updated");
      }
    },
    [sort],
  );

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden rounded-none border-y-0 border-l-0 border-border/80 bg-background shadow-none">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <Activity className="size-3.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Sessions</p>
          <p className="truncate text-[10px] text-muted-foreground">Live workspace activity</p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Explain session sections"
                className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-72 space-y-1 p-3">
              <p>
                <strong>Needs you:</strong> waiting for your input or review.
              </p>
              <p>
                <strong>Working:</strong> the agent is active or the task is ongoing.
              </p>
              <p>
                <strong>Later:</strong> hidden until its reminder time. This does not pause a
                running agent.
              </p>
              <p>
                <strong>Handled:</strong> removed from active attention, but not deleted or stopped.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {totalAttentionCount > 0 && (
          <span className="tnum ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-warn" />
            {totalAttentionCount} need you
          </span>
        )}
      </div>

      <RailFilterBar
        query={query}
        setQuery={setQuery}
        sort={sort}
        setSort={setSort}
        effectiveGroup={effectiveGroup}
        handleGroupChange={handleGroupChange}
        filter={filter}
        setFilter={setFilter}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-background">
        {rows.length === 0 ? (
          <div className="mt-10 px-4 text-center text-sm leading-relaxed text-muted-foreground">
            <p className="mb-1 text-foreground">All quiet.</p>
            No matching live sessions.
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full px-2 py-px"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === "shelf" ? (
                    <ShelfHeader
                      shelf={row.shelf}
                      label={row.label}
                      count={row.count}
                      collapsed={collapsedShelves.has(row.shelf)}
                      onToggle={toggleShelf}
                    />
                  ) : row.kind === "group" ? (
                    <button
                      type="button"
                      className="flex h-7 w-full items-center gap-1.5 rounded-md border border-transparent px-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:border-border/60 hover:bg-secondary/50 hover:text-foreground"
                      onClick={() => {
                        const groupKey = `working:${effectiveGroup}:${row.group.key}`;
                        toggleGroup(groupKey);
                      }}
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 transition-transform",
                          !collapsedGroups.has(`working:${effectiveGroup}:${row.group.key}`) &&
                            "rotate-90",
                        )}
                      />
                      {effectiveGroup === "agent" ? (
                        <AgentBadge agentId={row.group.key} size="xs" className="font-semibold" />
                      ) : effectiveGroup === "status" ? (
                        <StatusBadge status={row.group.key as StatusKind} size="xs" />
                      ) : (
                        <span className="truncate">{row.group.label}</span>
                      )}
                      <span className="tnum ml-auto font-normal">{row.count}</span>
                    </button>
                  ) : row.kind === "load-more" ? (
                    <button
                      type="button"
                      data-settled-load-more
                      className="flex h-7 w-full items-center justify-center rounded-md border border-border/40 text-[11px] font-medium text-muted-foreground hover:border-border/60 hover:bg-secondary/40 hover:text-foreground"
                      onClick={() => {
                        setSettledPageLimit((prev) => prev + SETTLED_PAGE_SIZE);
                      }}
                    >
                      Load more
                    </button>
                  ) : row.kind === "task-group" ? (
                    <RailTaskGroup
                      unit={row.unit}
                      expanded={expandedTaskGroups.has(row.unit.key)}
                      onToggle={toggleTaskGroup}
                      taskShelfById={taskShelfById}
                      state={state}
                      pinned={pinnedSet.has(row.unit.tree.task.id)}
                      attentionById={attentionById}
                      attentionTargetId={attentionTargetId}
                      activeWokeIds={activeWokeIds}
                      timeMode={sort === "created" ? "created" : "updated"}
                      expandedTaskId={expandedTaskId}
                      onPin={handlePin}
                      onOpen={handleOpen}
                      onTogglePreview={handleTogglePreview}
                    />
                  ) : (
                    <SessionRailCard
                      task={row.task}
                      shelf={row.shelf}
                      parentTask={
                        taskGroupIndex.rootByTaskId.get(row.task.id)?.task.id !== row.task.id
                          ? taskGroupIndex.rootByTaskId.get(row.task.id)?.task
                          : undefined
                      }
                      updates={state.sessionUpdates[row.task.id]}
                      pinned={pinnedSet.has(
                        taskGroupIndex.rootByTaskId.get(row.task.id)?.task.id ?? row.task.id,
                      )}
                      attention={attentionById.has(row.task.id)}
                      reason={attentionById.get(row.task.id)?.reason}
                      permission={attentionById.get(row.task.id)?.permission}
                      focused={attentionTargetId === row.task.id}
                      woke={activeWokeIds.has(row.task.id)}
                      timeMode={sort === "created" ? "created" : "updated"}
                      expanded={expandedTaskId === row.task.id}
                      childAgents={childAgentsByTaskId.get(row.task.id)}
                      onPin={handlePin}
                      onOpen={handleOpen}
                      onTogglePreview={handleTogglePreview}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

interface RailTaskGroupProps {
  unit: RailUnit;
  expanded: boolean;
  onToggle: (rootId: string) => void;
  taskShelfById: ReadonlyMap<string, ShelfId>;
  state: DaemonState;
  pinned: boolean;
  attentionById: ReadonlyMap<string, AttentionItem>;
  attentionTargetId: string | null;
  activeWokeIds: ReadonlySet<string>;
  timeMode: "created" | "updated";
  expandedTaskId: string | null;
  onPin: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onTogglePreview: (taskId: string) => void;
}

function RailTaskGroup({
  unit,
  expanded,
  onToggle,
  taskShelfById,
  state,
  pinned,
  attentionById,
  attentionTargetId,
  activeWokeIds,
  timeMode,
  expandedTaskId,
  onPin,
  onOpen,
  onTogglePreview,
}: RailTaskGroupProps) {
  const root = unit.tree.task;
  const representative = unit.representative;
  const members = flattenTaskTree(unit.tree);
  const descendants = members.slice(1);
  const childAgents = [...new Set(descendants.map((d) => d.agent))];
  const counts = taskGroupCounts(unit.tree);
  const attentionCount = members.filter((task) => attentionById.has(task.id)).length;
  const otherTasks = unit.tasks.filter((task) => task.id !== representative.id);
  const representativeAttention = attentionById.get(representative.id);

  return (
    <div className="overflow-hidden rounded-md bg-card/20 ring-1 ring-border/55">
      <SessionRailCard
        task={representative}
        shelf={taskShelfById.get(representative.id) ?? unit.shelf}
        parentTask={representative.id === root.id ? undefined : root}
        updates={state.sessionUpdates[representative.id]}
        pinned={pinned}
        attention={Boolean(representativeAttention)}
        reason={representativeAttention?.reason}
        permission={representativeAttention?.permission}
        focused={attentionTargetId === representative.id}
        woke={activeWokeIds.has(representative.id)}
        timeMode={timeMode}
        expanded={expandedTaskId === representative.id}
        childAgents={childAgents}
        onPin={onPin}
        onOpen={onOpen}
        onTogglePreview={onTogglePreview}
      />
      <button
        type="button"
        className="flex w-full items-center gap-1.5 border-t border-border/50 bg-secondary/15 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => onToggle(root.id)}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Workflow className="size-3 text-primary" />
        <span className="font-medium text-foreground">Agents</span>
        <span className="tnum">{descendants.length}</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[10px]">
          {attentionCount > 0 && <span className="text-warn">{attentionCount} need you</span>}
          {counts.blocked > 0 && <span className="text-destructive">{counts.blocked} blocked</span>}
          {counts.running > 0 && <span className="text-ok">{counts.running} running</span>}
          {counts.review > 0 && <span className="text-warn">{counts.review} review</span>}
          {counts.done > 0 && <span>{counts.done} done</span>}
        </span>
      </button>
      {expanded && otherTasks.length > 0 && (
        <div className="space-y-px border-t border-border/50 bg-background/30 p-1 pl-2">
          {otherTasks.map((task) => {
            const attention = attentionById.get(task.id);
            return (
              <SessionRailCard
                key={task.id}
                task={task}
                shelf={taskShelfById.get(task.id) ?? unit.shelf}
                parentTask={task.id === root.id ? undefined : root}
                updates={state.sessionUpdates[task.id]}
                pinned={pinned}
                attention={Boolean(attention)}
                reason={attention?.reason}
                permission={attention?.permission}
                focused={attentionTargetId === task.id}
                woke={activeWokeIds.has(task.id)}
                timeMode={timeMode}
                expanded={expandedTaskId === task.id}
                previewMode="hidden"
                onPin={onPin}
                onOpen={onOpen}
                onTogglePreview={onTogglePreview}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const ACTIVE_SHELVES: ReadonlySet<ShelfId> = new Set(["needs-you", "working"]);

interface ShelfHeaderProps {
  shelf: ShelfId;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: (shelf: ShelfId) => void;
}

function ShelfHeader({ shelf, label, count, collapsed, onToggle }: ShelfHeaderProps) {
  const collapsible = !ACTIVE_SHELVES.has(shelf);

  if (!collapsible) {
    return (
      <h3
        data-shelf={shelf}
        className="flex h-7 w-full items-center gap-1.5 border-b border-border/45 px-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
      >
        <span className="truncate">{label}</span>
        <span className="tnum ml-auto font-normal">{count}</span>
      </h3>
    );
  }

  return (
    <button
      type="button"
      data-shelf={shelf}
      className="flex h-7 w-full items-center gap-1.5 border-b border-border/45 px-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:bg-secondary/25 hover:text-foreground"
      onClick={() => onToggle(shelf)}
      aria-expanded={!collapsed}
    >
      <ChevronRight
        className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
      />
      <span className="truncate">{label}</span>
      <span className="tnum ml-auto font-normal">{count}</span>
    </button>
  );
}

export default memo(AttentionRail);
