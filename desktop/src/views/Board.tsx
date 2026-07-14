import { useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Plus, Clock, CheckCheck, GitPullRequestArrow, Activity, GitBranch, ChevronDown, ChevronRight, Workflow } from "lucide-react";
import { Snapshot, TaskInfo, TaskStatus, OrchNodeInfo } from "../protocol";
import { taskBadge, elapsed, orchNodeBadge } from "@/lib/status";
import { buildTaskForest, flattenTaskTree, TaskTree, treeLane, treeMatches } from "@/lib/taskGroups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  // Local priority ordering for the queue (daemon would persist this).
  const [order, setOrder] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const agents = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.agent))].sort(),
    [snapshot.tasks],
  );

  const match = (t: TaskInfo) =>
    (project === "all" || t.project === project) && (agent === "all" || t.agent === agent);
  const tasks = snapshot.tasks.filter(match);
  const forest = useMemo(
    () => buildTaskForest(snapshot.tasks).filter((tree) => treeMatches(tree, match)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.tasks, project, agent],
  );

  const byStatus = (s: TaskStatus | TaskStatus[]) => {
    const set = Array.isArray(s) ? s : [s];
    return tasks.filter((t) => set.includes(t.status));
  };

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
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setOrder(ids);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const done = byStatus("done").sort((a, b) => b.updatedAt - a.updatedAt);
  const running = byStatus("running");
  // Open conversations: the agent is either working (running) or waiting for
  // your next message (idle). Both are live, non-review, non-done.
  const review = byStatus(["needs_review", "blocked", "interrupted"]);
  const laneTrees = (lane: ReturnType<typeof treeLane>) => forest.filter((tree) => treeLane(tree) === lane);
  const queueTrees = laneTrees("queue");
  const activeTrees = laneTrees("active");
  const reviewTrees = laneTrees("review");
  const historyTrees = laneTrees("history").sort((a, b) => b.task.updatedAt - a.task.updatedAt);

  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doneToday = done.filter((t) => Date.now() / 1000 - t.updatedAt < 86400).length;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Throughput */}
      <div className="grid grid-cols-4 gap-3">
        <Stat icon={Activity} label="Running now" value={running.length} tone="ok" />
        <Stat icon={Clock} label="In queue" value={queued.length} />
        <Stat icon={GitPullRequestArrow} label="Awaiting review" value={review.length} tone="warn" />
        <Stat icon={CheckCheck} label="Done · 24h" value={doneToday} />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger className="w-44">
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
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="ml-auto" onClick={() => onNewTask()}>
          <Plus className="size-4" />
          New task
        </Button>
      </div>

      {/* Columns */}
      <div className="grid min-h-0 flex-1 grid-cols-4 gap-3">
        <Column title="Queue" hint="arrows set standalone priority" count={queueTrees.length}>
          {queueTrees.map((tree) => {
            if (tree.children.length > 0) {
              return <TaskGroupCard key={tree.task.id} tree={tree} onOpenTask={onOpenTask} collapsed={collapsedGroups.has(tree.task.id)} onToggle={() => toggleGroup(tree.task.id)} />;
            }
            const i = queued.findIndex((task) => task.id === tree.task.id);
            return <QueueCard key={tree.task.id} task={tree.task} rank={i + 1} first={i <= 0} last={i === queued.length - 1} onOpen={() => onOpenTask(tree.task.id)} onUp={() => move(tree.task.id, -1)} onDown={() => move(tree.task.id, 1)} />;
          })}
          {queueTrees.length === 0 && <Empty />}
        </Column>

        <Column title="Active" count={activeTrees.length}>
          {activeTrees.map((tree) => tree.children.length > 0 ? (
            <TaskGroupCard key={tree.task.id} tree={tree} onOpenTask={onOpenTask} collapsed={collapsedGroups.has(tree.task.id)} onToggle={() => toggleGroup(tree.task.id)} />
          ) : (
            <TaskCard key={tree.task.id} task={tree.task} onOpen={() => onOpenTask(tree.task.id)} expanded={expanded.has(tree.task.id)} onToggleExpand={() => toggleExpanded(tree.task.id)} />
          ))}
          {activeTrees.length === 0 && <Empty />}
        </Column>

        <Column title="Review / blocked" count={reviewTrees.length}>
          {reviewTrees.map((tree) => tree.children.length > 0 ? (
            <TaskGroupCard key={tree.task.id} tree={tree} onOpenTask={onOpenTask} collapsed={collapsedGroups.has(tree.task.id)} onToggle={() => toggleGroup(tree.task.id)} />
          ) : (
            <TaskCard key={tree.task.id} task={tree.task} onOpen={() => onOpenTask(tree.task.id)} expanded={expanded.has(tree.task.id)} onToggleExpand={() => toggleExpanded(tree.task.id)} />
          ))}
          {reviewTrees.length === 0 && <Empty />}
        </Column>

        <Column title="History" count={historyTrees.length}>
          {historyTrees.map((tree) => tree.children.length > 0 ? (
            <TaskGroupCard key={tree.task.id} tree={tree} onOpenTask={onOpenTask} collapsed={collapsedGroups.has(tree.task.id)} onToggle={() => toggleGroup(tree.task.id)} muted />
          ) : (
            <TaskCard key={tree.task.id} task={tree.task} onOpen={() => onOpenTask(tree.task.id)} muted expanded={expanded.has(tree.task.id)} onToggleExpand={() => toggleExpanded(tree.task.id)} />
          ))}
          {historyTrees.length === 0 && <Empty />}
        </Column>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
  tone?: "ok" | "warn";
}) {
  return (
    <Card className="flex items-center gap-3 p-3">
      <Icon
        className={cn(
          "size-5",
          tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-muted-foreground",
        )}
      />
      <div>
        <div className="tnum text-xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}

function Column({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint?: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex min-h-0 flex-col">
      <div className="flex items-baseline justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="tnum text-xs text-muted-foreground">{count}</span>
      </div>
      {hint && <div className="px-3 pb-1 text-[10px] text-muted-foreground/70">{hint}</div>}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-2">{children}</div>
      </ScrollArea>
    </Card>
  );
}

function TaskGroupCard({
  tree,
  onOpenTask,
  collapsed,
  onToggle,
  muted,
}: {
  tree: TaskTree;
  onOpenTask: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  muted?: boolean;
}) {
  const descendants = flattenTaskTree(tree).slice(1);
  const reviewCount = descendants.filter((task) =>
    ["needs_review", "blocked", "interrupted"].includes(task.status),
  ).length;
  const runningCount = descendants.filter((task) => task.status === "running").length;
  const doneCount = descendants.filter((task) => task.status === "done").length;

  return (
    <div className={cn("relative", muted && "opacity-70")}>
      {/* A restrained card stack signals ownership even while collapsed. */}
      <div className="pointer-events-none absolute inset-x-1 top-1 h-full rounded-md border border-border/60 bg-secondary/20" />
      <div className="relative pb-1">
        <TaskCard task={tree.task} onOpen={() => onOpenTask(tree.task.id)} hideOrchAccordion flattenBottom />
        <button
          className="relative -mt-px flex w-full items-center gap-1.5 rounded-b-md border border-t-0 border-border bg-secondary/60 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <Workflow className="size-3 text-primary" />
          <span className="font-medium text-foreground">Orchestration</span>
          <span>{descendants.length}</span>
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[10px]">
            {runningCount > 0 && <span className="text-ok">{runningCount} live</span>}
            {reviewCount > 0 && <span className="text-warn">{reviewCount} review</span>}
            {doneCount > 0 && <span>{doneCount} done</span>}
          </span>
        </button>
      </div>

      {!collapsed && (
        <div className="ml-3 flex flex-col border-l-2 border-primary/30 pl-2 pt-1">
          {tree.children.map((child) => (
            <ChildTaskRow key={child.task.id} tree={child} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChildTaskRow({ tree, onOpenTask }: { tree: TaskTree; onOpenTask: (id: string) => void }) {
  const badge = taskBadge(tree.task.status);
  return (
    <div className="relative border-b border-border/50 py-1.5 last:border-b-0">
      <span className="absolute -left-2.5 top-3.5 h-px w-2 bg-primary/30" />
      <button className="w-full min-w-0 text-left" onClick={() => onOpenTask(tree.task.id)}>
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Badge variant={badge.variant} className="shrink-0">
            {badge.label}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-foreground">{tree.task.prompt}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 pl-0.5 text-[10px] text-muted-foreground">
          <span>{tree.task.agent}</span>
          {tree.task.filesChanged > 0 && <span>{tree.task.filesChanged} files</span>}
          <span className="ml-auto tnum">{elapsed(tree.task.updatedAt)} ago</span>
        </div>
      </button>
      {tree.children.length > 0 && (
        <div className="ml-2 mt-1 border-l border-primary/20 pl-2">
          {tree.children.map((child) => (
            <ChildTaskRow key={child.task.id} tree={child} onOpenTask={onOpenTask} />
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
}: {
  task: TaskInfo;
  onOpen: () => void;
  muted?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  hideOrchAccordion?: boolean;
  flattenBottom?: boolean;
}) {
  const badge = taskBadge(task.status);
  const nodes = task.orchestrationGraph?.nodes;
  const hasAccordion = !hideOrchAccordion && nodes && nodes.length > 0;

  return (
    <div>
      <Card
        className={cn(
          "bg-secondary/40 p-2.5 transition-colors hover:border-primary/60",
          muted && "opacity-70",
          flattenBottom && "rounded-b-none",
        )}
      >
        {/* Clickable row: opens TaskDetail */}
        <button className="w-full cursor-pointer text-left" onClick={onOpen}>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{task.project}</span>
            <span className="flex items-center gap-1">
              {task.worktree && <GitBranch className="size-3 text-primary" />}
              {task.agent}
            </span>
          </div>
          <p className="my-1.5 line-clamp-2 text-sm">{task.prompt}</p>
          <div className="flex items-center gap-2">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {task.filesChanged > 0 && (
              <span className="tnum text-xs text-muted-foreground">{task.filesChanged} files</span>
            )}
            <span className="tnum ml-auto text-xs text-muted-foreground">
              {task.status === "done" ? `${elapsed(task.updatedAt)} ago` : elapsed(task.createdAt)}
            </span>
          </div>
        </button>

        {/* Accordion toggle for orchestrator tasks */}
        {hasAccordion && (
          <button
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
  const badge = orchNodeBadge(node.status);
  return (
    <div className="flex items-center gap-2 rounded bg-secondary/20 px-2 py-1 text-xs">
      <Badge variant={badge.variant} className="w-14 text-center">
        {badge.label}
      </Badge>
      <span className="font-medium text-foreground">{node.kind}</span>
      <span className="text-muted-foreground">{node.agent}</span>
      {node.taskId && <span className="ml-auto text-[10px] text-muted-foreground/60">{node.taskId}</span>}
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
}: {
  task: TaskInfo;
  rank: number;
  first: boolean;
  last: boolean;
  onOpen: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <Card className="flex gap-2 bg-secondary/40 p-2.5">
      <div className="flex flex-col items-center gap-0.5">
        <span className="tnum text-xs font-semibold text-muted-foreground">{rank}</span>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"
          onClick={onUp}
          disabled={first}
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"
          onClick={onDown}
          disabled={last}
        >
          <ArrowDown className="size-3" />
        </button>
      </div>
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{task.project}</span>
          <span>{task.agent}</span>
        </div>
        <p className="my-1 line-clamp-2 text-sm">{task.prompt}</p>
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

function Empty() {
  return <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">—</div>;
}
