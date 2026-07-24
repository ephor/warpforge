import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import {
  latestPendingPermission,
  prunePermissionCache,
  type PermissionUpdate,
} from "@/lib/sessionPermissions";
import type { StatusKind } from "@/lib/statusMeta";
import { buildTaskGroupIndex, isTaskGroupPinned, setTaskGroupPinned } from "@/lib/taskGroups";
import { cn } from "@/lib/utils";

import type { DaemonState } from "../daemon";
import type { TaskInfo, TaskStatus } from "../protocol";
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

/**
 * "Needs you" rail — live tasks, with human-blocked work promoted to the top.
 * The flattened row model allows cards and collapsible headers to share one
 * virtualizer, keeping the mounted tree bounded during busy sessions.
 */

interface AttentionItem {
  task: TaskInfo;
  reason: string;
  priority: number;
  permission?: PermissionUpdate;
}

function buildAttentionQueue(
  tasks: TaskInfo[],
  sessionUpdates: DaemonState["sessionUpdates"],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  prunePermissionCache(new Set(tasks.map((task) => task.id)));
  for (const task of tasks) {
    const permission = latestPendingPermission(task.id, sessionUpdates[task.id]);
    if (permission) {
      items.push({ permission, priority: 0, reason: permission.title, task });
    } else if (task.status === "needs_review") {
      items.push({ priority: 1, reason: "finished — review changes", task });
    } else if (task.status === "blocked") {
      items.push({ priority: 2, reason: task.blockedReason ?? "blocked", task });
    } else if (task.status === "interrupted") {
      items.push({ priority: 3, reason: "session lost on daemon restart", task });
    }
  }
  return items.sort((a, b) => a.priority - b.priority || b.task.updatedAt - a.task.updatedAt);
}

interface GroupInfo {
  key: string;
  label: string;
  rank: number;
}

type RailRow =
  | { key: string; kind: "group"; group: GroupInfo; count: number }
  | { key: string; kind: "task"; task: TaskInfo };

const STATUS_RANK: Record<TaskStatus, number> = {
  needs_review: 1,
  blocked: 2,
  interrupted: 3,
  running: 4,
  idle: 5,
  queued: 6,
  done: 7,
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  needs_review: "Needs review",
  blocked: "Blocked",
  interrupted: "Interrupted",
  running: "Running",
  idle: "Idle",
  queued: "Queued",
  done: "Done",
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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledTargetNonce = useRef<number | null>(null);

  const queue = useMemo(
    () => buildAttentionQueue(state.snapshot.tasks, state.sessionUpdates),
    [state.sessionUpdates, state.snapshot.tasks],
  );
  const attentionById = useMemo(() => new Map(queue.map((item) => [item.task.id, item])), [queue]);
  const taskGroupIndex = useMemo(
    () => buildTaskGroupIndex(state.snapshot.tasks),
    [state.snapshot.tasks],
  );
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

  const tasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const result = state.snapshot.tasks.filter((task) => {
      if (task.status === "done") {
        return false;
      }
      if (filter === "attention" && !attentionById.has(task.id)) {
        return false;
      }
      if (filter === "running" && task.status !== "running") {
        return false;
      }
      return (
        !normalizedQuery ||
        task.prompt.toLocaleLowerCase().includes(normalizedQuery) ||
        task.project.toLocaleLowerCase().includes(normalizedQuery)
      );
    });

    return result.sort((a, b) => {
      if (sort === "created") {
        return b.createdAt - a.createdAt;
      }
      if (sort === "project") {
        return a.project.localeCompare(b.project) || b.updatedAt - a.updatedAt;
      }
      if (sort === "status") {
        const aGroup = statusGroup(a, attentionById.get(a.id)?.permission);
        const bGroup = statusGroup(b, attentionById.get(b.id)?.permission);
        return aGroup.rank - bGroup.rank || b.updatedAt - a.updatedAt;
      }
      const updatedDifference = b.updatedAt - a.updatedAt;
      if (updatedDifference !== 0) {
        return updatedDifference;
      }
      const aStatusRank = statusGroup(a, attentionById.get(a.id)?.permission).rank;
      const bStatusRank = statusGroup(b, attentionById.get(b.id)?.permission).rank;
      return aStatusRank - bStatusRank || a.id.localeCompare(b.id);
    });
  }, [attentionById, filter, query, sort, state.snapshot.tasks]);

  const rows = useMemo(() => {
    if (effectiveGroup === "none") {
      return tasks.map((task): RailRow => ({ key: `task:${task.id}`, kind: "task", task }));
    }

    const grouped = new Map<string, { info: GroupInfo; tasks: TaskInfo[] }>();
    for (const task of tasks) {
      const info = groupInfo(task, effectiveGroup, attentionById.get(task.id)?.permission);
      const existing = grouped.get(info.key);
      if (existing) {
        existing.tasks.push(task);
      } else {
        grouped.set(info.key, { info, tasks: [task] });
      }
    }

    const groups = [...grouped.values()].sort((a, b) => {
      if (effectiveGroup === "status") {
        return a.info.rank - b.info.rank;
      }
      return a.info.label.localeCompare(b.info.label);
    });
    return groups.flatMap(({ info, tasks: groupedTasks }): RailRow[] => {
      const groupKey = `${effectiveGroup}:${info.key}`;
      const header: RailRow = {
        count: groupedTasks.length,
        group: info,
        key: `group:${groupKey}`,
        kind: "group",
      };
      return collapsed.has(groupKey)
        ? [header]
        : [
            header,
            ...groupedTasks.map(
              (task): RailRow => ({ key: `task:${task.id}`, kind: "task", task }),
            ),
          ];
    });
  }, [attentionById, collapsed, effectiveGroup, tasks]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.kind === "group" ? 36 : 120),
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: 5,
    // Each mounted wrapper is observed through measureElement below. Do not
    // call virtualizer.measure() for content changes: it clears every cached
    // mixed-height measurement, while only the changed row emits a resize.
  });

  useEffect(() => {
    if (!attentionTargetId) return;
    setQuery("");
    setFilter("all");
    setCollapsed(new Set());
  }, [attentionTargetId, attentionTargetNonce]);

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

  const handleOpen = useCallback((taskId: string) => onOpenTask(taskId), [onOpenTask]);
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
  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
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
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <Activity className="size-3.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Sessions</p>
          <p className="truncate text-[10px] text-muted-foreground">Live workspace activity</p>
        </div>
        {queue.length > 0 && (
          <span className="tnum ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-warn" />
            {queue.length} need you
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
                  className="absolute left-0 top-0 w-full px-2 py-0.5"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === "group" ? (
                    <button
                      type="button"
                      className="flex h-7 w-full items-center gap-1.5 rounded-md border border-transparent px-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:border-border/60 hover:bg-secondary/50 hover:text-foreground"
                      onClick={() => toggleGroup(`${effectiveGroup}:${row.group.key}`)}
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 transition-transform",
                          !collapsed.has(`${effectiveGroup}:${row.group.key}`) && "rotate-90",
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
                  ) : (
                    <SessionRailCard
                      task={row.task}
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
                      timeMode={sort === "created" ? "created" : "updated"}
                      expanded={expandedTaskId === row.task.id}
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

export default memo(AttentionRail);
