import {
  AlarmClock,
  ArrowDown,
  ArrowUp,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Plus,
  Route,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentAvatarGroup } from "@/components/AgentAvatar";
import { AgentBadge } from "@/components/AgentBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stageLabel } from "@/components/WorkflowControls";
import { elapsed } from "@/lib/status";
import type { BoardLifecycleFilter, TaskTree } from "@/lib/taskGroups";
import {
  buildTaskForest,
  flattenTaskTree,
  taskGroupCounts,
  taskLifecycle,
  taskLifecycleCounts,
  taskNeedsAttention,
  treeLane,
  treeMatchesLifecycle,
  treeMatches,
} from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import type { OrchNodeInfo, Snapshot, TaskInfo, TaskStatus } from "../protocol";

interface Props {
  snapshot: Snapshot;
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string) => void;
}

/**
 * Board — the planning view. Throughput at the top; then the queue (with
 * priority reordering), running work, review, and history. Distinct from
 * Mission Control: MC is "what needs me now", Board is "what to run next and
 * what already shipped".
 */
export default function Board({ snapshot, onOpenTask, onNewTask }: Props) {
  const [project, setProject] = useState("all");
  const [agent, setAgent] = useState("all");
  const [lifecycle, setLifecycle] = useState<BoardLifecycleFilter>("all");
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  // Local priority ordering for the queue (daemon would persist this).
  const [order, setOrder] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const agents = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.agent))].sort(),
    [snapshot.tasks],
  );

  const match = useMemo(
    () => (t: TaskInfo) =>
      (project === "all" || t.project === project) && (agent === "all" || t.agent === agent),
    [project, agent],
  );
  const tasks = useMemo(() => snapshot.tasks.filter(match), [snapshot.tasks, match]);
  const matchingForest = useMemo(
    () => buildTaskForest(snapshot.tasks).filter((tree) => treeMatches(tree, match)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.tasks, project, agent],
  );
  const forest = useMemo(
    () => matchingForest.filter((tree) => treeMatchesLifecycle(tree, lifecycle, nowSeconds)),
    [lifecycle, matchingForest, nowSeconds],
  );
  const lifecycleCounts = useMemo(
    () =>
      tasks.reduce(
        (counts, task) => {
          const taskState = taskLifecycle(task, nowSeconds);
          if (taskState === "later") counts.later += 1;
          if (taskState === "handled") counts.handled += 1;
          if (taskNeedsAttention(task)) counts.attention += 1;
          return counts;
        },
        { attention: 0, handled: 0, later: 0 },
      ),
    [nowSeconds, tasks],
  );

  const byStatus = useMemo(() => {
    const cache = new Map<string, TaskInfo[]>();
    return (s: TaskStatus | TaskStatus[]) => {
      const statuses = new Set(Array.isArray(s) ? s : [s]);
      const key = [...statuses].sort().join(",");
      let result = cache.get(key);
      if (!result) {
        result = tasks.filter((task) => statuses.has(task.status));
        cache.set(key, result);
      }
      return result;
    };
  }, [tasks]);

  // Queue ordered by local priority, unknown ids appended.
  const queued = useMemo(() => {
    const q = byStatus("queued").filter((task) => !task.parentTaskId);
    return [...q].sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? -1 : ia) - (ib === -1 ? -1 : ib);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, order]);

  const move = (id: string, dir: -1 | 1) => {
    const ids = queued.map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) {
      return;
    }
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setOrder(ids);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const laneTrees = useMemo(
    () => (lane: ReturnType<typeof treeLane>) => forest.filter((tree) => treeLane(tree) === lane),
    [forest],
  );
  const queueTrees = useMemo(() => laneTrees("queue"), [laneTrees]);
  const activeTrees = useMemo(() => laneTrees("active"), [laneTrees]);
  const reviewTrees = useMemo(() => laneTrees("review"), [laneTrees]);
  const historyTrees = useMemo(
    () => laneTrees("history").sort((a, b) => b.task.updatedAt - a.task.updatedAt),
    [laneTrees],
  );

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex h-8 shrink-0 items-center gap-2">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger className="h-7 w-44 bg-card/80 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {snapshot.projects.map((p) => (
              <SelectItem key={p.name} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger className="h-7 w-36 bg-card/80 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a} value={a}>
                <AgentBadge agentId={a} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div
          className="flex h-7 items-center rounded border border-border/80 bg-card/80 p-0.5"
          aria-label="Filter board by attention state"
        >
          {(
            [
              ["all", "All", tasks.length],
              ["attention", "Needs attention", lifecycleCounts.attention],
              ["later", "Later", lifecycleCounts.later],
              ["handled", "Handled", lifecycleCounts.handled],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              className={cn(
                "flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                lifecycle === value && "bg-secondary text-foreground",
              )}
              aria-pressed={lifecycle === value}
              onClick={() => setLifecycle(value)}
            >
              {label}
              {value !== "all" && <span className="tnum opacity-70">{count}</span>}
            </button>
          ))}
        </div>
        <Button size="sm" className="ml-auto h-7" onClick={() => onNewTask()}>
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded-md border border-border/80">
        <ResizablePanelGroup
          autoSaveId="warpforge-board-lanes-v1"
          direction="horizontal"
          className="min-w-[880px]"
        >
          <ResizablePanel id="queue" order={1} defaultSize={25} minSize={10}>
            <Column title="Queue" hint="Local ordering for this view" count={queueTrees.length}>
              {queueTrees.map((tree) => {
                if (tree.children.length > 0) {
                  return (
                    <TaskGroupCard
                      key={tree.task.id}
                      tree={tree}
                      onOpenTask={onOpenTask}
                      collapsed={!expandedGroups.has(tree.task.id)}
                      onToggle={() => toggleGroup(tree.task.id)}
                      nowSeconds={nowSeconds}
                    />
                  );
                }
                const i = queued.findIndex((task) => task.id === tree.task.id);
                return (
                  <QueueCard
                    key={tree.task.id}
                    task={tree.task}
                    rank={i + 1}
                    first={i <= 0}
                    last={i === queued.length - 1}
                    onOpen={() => onOpenTask(tree.task.id)}
                    onUp={() => move(tree.task.id, -1)}
                    onDown={() => move(tree.task.id, 1)}
                    nowSeconds={nowSeconds}
                  />
                );
              })}
              {queueTrees.length === 0 && <Empty />}
            </Column>
          </ResizablePanel>
          <ResizableHandle />

          <ResizablePanel id="active" order={2} defaultSize={25} minSize={10}>
            <Column title="Active" count={activeTrees.length}>
              {activeTrees.map((tree) =>
                tree.children.length > 0 ? (
                  <TaskGroupCard
                    key={tree.task.id}
                    tree={tree}
                    onOpenTask={onOpenTask}
                    collapsed={!expandedGroups.has(tree.task.id)}
                    onToggle={() => toggleGroup(tree.task.id)}
                    nowSeconds={nowSeconds}
                  />
                ) : (
                  <TaskCard
                    key={tree.task.id}
                    task={tree.task}
                    onOpen={() => onOpenTask(tree.task.id)}
                    expanded={expanded.has(tree.task.id)}
                    onToggleExpand={() => toggleExpanded(tree.task.id)}
                    nowSeconds={nowSeconds}
                  />
                ),
              )}
              {activeTrees.length === 0 && <Empty />}
            </Column>
          </ResizablePanel>
          <ResizableHandle />

          <ResizablePanel id="review" order={3} defaultSize={25} minSize={10}>
            <Column title="Review / blocked" count={reviewTrees.length} tone="warn">
              {reviewTrees.map((tree) =>
                tree.children.length > 0 ? (
                  <TaskGroupCard
                    key={tree.task.id}
                    tree={tree}
                    onOpenTask={onOpenTask}
                    collapsed={!expandedGroups.has(tree.task.id)}
                    onToggle={() => toggleGroup(tree.task.id)}
                    nowSeconds={nowSeconds}
                  />
                ) : (
                  <TaskCard
                    key={tree.task.id}
                    task={tree.task}
                    onOpen={() => onOpenTask(tree.task.id)}
                    expanded={expanded.has(tree.task.id)}
                    onToggleExpand={() => toggleExpanded(tree.task.id)}
                    nowSeconds={nowSeconds}
                  />
                ),
              )}
              {reviewTrees.length === 0 && <Empty />}
            </Column>
          </ResizablePanel>
          <ResizableHandle />

          <ResizablePanel id="history" order={4} defaultSize={25} minSize={10}>
            <Column title="History" count={historyTrees.length} muted>
              {historyTrees.map((tree) =>
                tree.children.length > 0 ? (
                  <TaskGroupCard
                    key={tree.task.id}
                    tree={tree}
                    onOpenTask={onOpenTask}
                    collapsed={!expandedGroups.has(tree.task.id)}
                    onToggle={() => toggleGroup(tree.task.id)}
                    muted
                    nowSeconds={nowSeconds}
                  />
                ) : (
                  <TaskCard
                    key={tree.task.id}
                    task={tree.task}
                    onOpen={() => onOpenTask(tree.task.id)}
                    muted
                    expanded={expanded.has(tree.task.id)}
                    onToggleExpand={() => toggleExpanded(tree.task.id)}
                    nowSeconds={nowSeconds}
                  />
                ),
              )}
              {historyTrees.length === 0 && <Empty />}
            </Column>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function Column({
  title,
  hint,
  count,
  children,
  muted,
  tone,
}: {
  title: string;
  hint?: string;
  count: number;
  children: React.ReactNode;
  muted?: boolean;
  tone?: "warn";
}) {
  return (
    <section
      aria-label={`${title} lane`}
      className={cn("flex h-full min-h-0 min-w-0 flex-col bg-card", muted && "opacity-75")}
    >
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border/80 px-3"
        title={hint}
      >
        {tone === "warn" && <span className="size-1.5 rounded-full bg-warn" />}
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="tnum ml-auto text-xs text-muted-foreground">{count}</span>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1.5 p-1.5">{children}</div>
      </ScrollArea>
    </section>
  );
}

function TaskGroupCard({
  tree,
  onOpenTask,
  collapsed,
  onToggle,
  muted,
  nowSeconds,
}: {
  tree: TaskTree;
  onOpenTask: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  muted?: boolean;
  nowSeconds: number;
}) {
  const descendants = flattenTaskTree(tree).slice(1);
  const counts = taskGroupCounts(tree);
  const lifecycleCounts = taskLifecycleCounts(tree, nowSeconds);
  const childAgents = [...new Set(descendants.map((d) => d.agent))];

  return (
    <div className={cn(muted && "opacity-70")}>
      <div>
        <TaskCard
          task={tree.task}
          onOpen={() => onOpenTask(tree.task.id)}
          hideOrchAccordion
          flattenBottom
          nowSeconds={nowSeconds}
          childAgents={childAgents}
        />
        <button
          type="button"
          className="relative -mt-px flex w-full items-center gap-1.5 rounded-b-md border border-t-0 border-border bg-secondary/60 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <Workflow className="size-3 text-primary" />
          <span className="font-medium text-foreground">Agents</span>
          <span>{descendants.length}</span>
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[10px]">
            {counts.blocked > 0 && (
              <span className="text-destructive">{counts.blocked} blocked</span>
            )}
            {counts.running > 0 && <span className="text-ok">{counts.running} running</span>}
            {counts.review > 0 && <span className="text-warn">{counts.review} review</span>}
            {counts.done > 0 && <span>{counts.done} done</span>}
            {lifecycleCounts.later > 0 && (
              <span className="text-blue-500">{lifecycleCounts.later} later</span>
            )}
            {lifecycleCounts.handled > 0 && <span>{lifecycleCounts.handled} handled</span>}
          </span>
        </button>
      </div>

      {!collapsed && (
        <div className="ml-3 mr-2 flex flex-col border-l-2 border-primary/30 pl-2 pt-1.5">
          {tree.children.map((child) => (
            <ChildTaskRow
              key={child.task.id}
              tree={child}
              onOpenTask={onOpenTask}
              nowSeconds={nowSeconds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChildTaskRow({
  tree,
  onOpenTask,
  nowSeconds,
}: {
  tree: TaskTree;
  onOpenTask: (id: string) => void;
  nowSeconds: number;
}) {
  return (
    <div className="relative border-b border-border/50 py-1.5 last:border-b-0">
      <span className="absolute -left-2.5 top-3.5 h-px w-2 bg-primary/30" />
      <button
        type="button"
        className="w-full min-w-0 text-left"
        onClick={() => onOpenTask(tree.task.id)}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <StatusBadge status={tree.task.status} size="xs" className="shrink-0" />
          <LifecycleBadge task={tree.task} nowSeconds={nowSeconds} />
          <span className="min-w-0 flex-1 truncate text-foreground">{taskLabel(tree.task)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 pl-0.5 text-[10px] text-muted-foreground">
          <AgentBadge agentId={tree.task.agent} size="xs" />
          {tree.task.filesChanged > 0 && <span>{tree.task.filesChanged} files</span>}
          <span className="ml-auto tnum">{elapsed(tree.task.updatedAt)} ago</span>
        </div>
      </button>
      {tree.children.length > 0 && (
        <div className="ml-2 mt-1 border-l border-primary/20 pl-2">
          {tree.children.map((child) => (
            <ChildTaskRow
              key={child.task.id}
              tree={child}
              onOpenTask={onOpenTask}
              nowSeconds={nowSeconds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  onOpen,
  muted,
  expanded,
  onToggleExpand,
  hideOrchAccordion,
  flattenBottom,
  nowSeconds,
  childAgents,
}: {
  task: TaskInfo;
  onOpen: () => void;
  muted?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  hideOrchAccordion?: boolean;
  flattenBottom?: boolean;
  nowSeconds: number;
  childAgents?: string[];
}) {
  const nodes = task.orchestrationGraph?.nodes;
  const hasAccordion = !hideOrchAccordion && nodes && nodes.length > 0;

  return (
    <div>
      <Card
        className={cn(
          "bg-background/35 p-2 transition-colors hover:border-primary/50",
          muted && "opacity-70",
          flattenBottom && "rounded-b-none",
        )}
      >
        {/* Clickable row: opens TaskDetail */}
        <button type="button" className="w-full cursor-pointer text-left" onClick={onOpen}>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusBadge status={task.status} size="xs" />
            <LifecycleBadge task={task} nowSeconds={nowSeconds} />
            <WorkflowBadge task={task} />
            <span className="min-w-0 truncate font-semibold text-foreground">{task.project}</span>
            {task.worktree && <GitBranch className="size-3 shrink-0 text-primary" />}
            <div
              className={cn("flex shrink-0 items-center", task.worktree ? undefined : "ml-auto")}
            >
              <AgentAvatarGroup agentId={task.agent} childAgents={childAgents} />
            </div>
            <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
            <span className="tnum shrink-0">
              {task.status === "done" ? `${elapsed(task.updatedAt)} ago` : elapsed(task.createdAt)}
            </span>
          </div>
          <p className="mt-1.5 line-clamp-2 text-sm">{taskLabel(task)}</p>
          {task.filesChanged > 0 && (
            <div className="mt-1.5 flex items-center">
              <span className="tnum text-xs text-muted-foreground">{task.filesChanged} files</span>
            </div>
          )}
        </button>

        {/* Accordion toggle for orchestrator tasks */}
        {hasAccordion && (
          <button
            type="button"
            className="mt-1.5 flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span>{nodes.length} subtasks</span>
            <span className="ml-auto text-[10px]">
              {nodes.filter((n) => n.status === "complete").length}/{nodes.length}
            </span>
          </button>
        )}
      </Card>

      {/* Expanded subtask list */}
      {hasAccordion && expanded && (
        <div className="ml-2 mt-1 flex flex-col gap-1 border-l-2 border-border pl-2">
          {nodes.map((node) => (
            <NodeRow key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeRow({ node }: { node: OrchNodeInfo }) {
  return (
    <div className="flex items-center gap-2 rounded bg-secondary/20 px-2 py-1 text-xs">
      <StatusBadge status={node.status} size="xs" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{node.kind}</span>
      <AgentBadge agentId={node.agent} size="xs" className="shrink-0 text-muted-foreground" />
      {node.taskId && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{node.taskId}</span>
      )}
    </div>
  );
}

function QueueCard({
  task,
  rank,
  first,
  last,
  onOpen,
  onUp,
  onDown,
  nowSeconds,
}: {
  task: TaskInfo;
  rank: number;
  first: boolean;
  last: boolean;
  onOpen: () => void;
  onUp: () => void;
  onDown: () => void;
  nowSeconds: number;
}) {
  return (
    <Card className="flex gap-2 bg-background/35 p-2">
      <div className="flex flex-col items-center gap-0.5">
        <span className="tnum text-xs font-semibold text-muted-foreground">{rank}</span>
        <button
          type="button"
          aria-label="Move task up"
          className="rounded p-0.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"
          onClick={onUp}
          disabled={first}
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          type="button"
          aria-label="Move task down"
          className="rounded p-0.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"
          onClick={onDown}
          disabled={last}
        >
          <ArrowDown className="size-3" />
        </button>
      </div>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <LifecycleBadge task={task} nowSeconds={nowSeconds} />
          <span className="min-w-0 truncate font-semibold text-foreground">{task.project}</span>
          <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
          <AgentAvatarGroup agentId={task.agent} />
        </div>
        <p className="my-1 line-clamp-2 text-sm">{taskLabel(task)}</p>
        <div className="flex flex-wrap gap-1">
          {task.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      </button>
    </Card>
  );
}

function LifecycleBadge({ task, nowSeconds }: { task: TaskInfo; nowSeconds: number }) {
  const lifecycle = taskLifecycle(task, nowSeconds);
  if (lifecycle === "active") return null;

  if (lifecycle === "later") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/12 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
        <AlarmClock className="size-2.5" />
        Later
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <CheckCheck className="size-2.5" />
      Handled
    </span>
  );
}

/**
 * Pipeline stage pill for workflow parent tasks. Amber while the pipeline
 * waits on the user (a question or an exhausted review limit), muted
 * otherwise — the surrounding StatusBadge already carries run/done state.
 */
function WorkflowBadge({ task }: { task: TaskInfo }) {
  const run = task.workflowRun;
  if (!run || run.stage === "done" || run.stage === "failed") return null;
  const waiting = run.waiting ?? null;
  const needsUser = !!waiting && waiting.kind !== "paused";
  const label =
    waiting?.kind === "limit"
      ? "review limit"
      : waiting?.kind === "question"
        ? "needs answer"
        : waiting?.kind === "paused"
          ? "paused"
          : stageLabel(run.stage);
  return (
    <span
      title={`${run.workflowName}${run.round > 0 ? ` — round ${run.round}/${run.maxRounds}` : ""}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        needsUser
          ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
          : "bg-primary/10 text-primary",
      )}
    >
      <Route className="size-2.5" />
      {label}
      {run.round > 0 && !needsUser && (
        <span className="tnum opacity-70">
          {run.round}/{run.maxRounds}
        </span>
      )}
    </span>
  );
}

function Empty() {
  return <div className="px-2 py-8 text-center text-xs text-muted-foreground/50">No tasks</div>;
}
