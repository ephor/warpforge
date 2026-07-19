import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Plus,
  Workflow,
} from "lucide-react";
import { useMemo, useState } from "react";

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
import { elapsed, orchNodeBadge, taskBadge } from "@/lib/status";
import type { TaskTree } from "@/lib/taskGroups";
import {
  buildTaskForest,
  flattenTaskTree,
  taskGroupCounts,
  treeLane,
  treeMatches,
} from "@/lib/taskGroups";
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
  // Local priority ordering for the queue (daemon would persist this).
  const [order, setOrder] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
  const forest = useMemo(
    () => buildTaskForest(snapshot.tasks).filter((tree) => treeMatches(tree, match)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.tasks, project, agent],
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
    setCollapsedGroups((prev) => {
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
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
                      collapsed={collapsedGroups.has(tree.task.id)}
                      onToggle={() => toggleGroup(tree.task.id)}
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
                    collapsed={collapsedGroups.has(tree.task.id)}
                    onToggle={() => toggleGroup(tree.task.id)}
                  />
                ) : (
                  <TaskCard
                    key={tree.task.id}
                    task={tree.task}
                    onOpen={() => onOpenTask(tree.task.id)}
                    expanded={expanded.has(tree.task.id)}
                    onToggleExpand={() => toggleExpanded(tree.task.id)}
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
                    collapsed={collapsedGroups.has(tree.task.id)}
                    onToggle={() => toggleGroup(tree.task.id)}
                  />
                ) : (
                  <TaskCard
                    key={tree.task.id}
                    task={tree.task}
                    onOpen={() => onOpenTask(tree.task.id)}
                    expanded={expanded.has(tree.task.id)}
                    onToggleExpand={() => toggleExpanded(tree.task.id)}
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
                    collapsed={collapsedGroups.has(tree.task.id)}
                    onToggle={() => toggleGroup(tree.task.id)}
                    muted
                  />
                ) : (
                  <TaskCard
                    key={tree.task.id}
                    task={tree.task}
                    onOpen={() => onOpenTask(tree.task.id)}
                    muted
                    expanded={expanded.has(tree.task.id)}
                    onToggleExpand={() => toggleExpanded(tree.task.id)}
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
}: {
  tree: TaskTree;
  onOpenTask: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  muted?: boolean;
}) {
  const descendants = flattenTaskTree(tree).slice(1);
  const counts = taskGroupCounts(tree);

  return (
    <div className={cn(muted && "opacity-70")}>
      <div>
        <TaskCard
          task={tree.task}
          onOpen={() => onOpenTask(tree.task.id)}
          hideOrchAccordion
          flattenBottom
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
          </span>
        </button>
      </div>

      {!collapsed && (
        <div className="ml-3 mr-2 flex flex-col border-l-2 border-primary/30 pl-2 pt-1.5">
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
      <button
        type="button"
        className="w-full min-w-0 text-left"
        onClick={() => onOpenTask(tree.task.id)}
      >
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
          "bg-background/35 p-2 transition-colors hover:border-primary/50",
          muted && "opacity-70",
          flattenBottom && "rounded-b-none",
        )}
      >
        {/* Clickable row: opens TaskDetail */}
        <button type="button" className="w-full cursor-pointer text-left" onClick={onOpen}>
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
  const badge = orchNodeBadge(node.status);
  return (
    <div className="flex items-center gap-2 rounded bg-secondary/20 px-2 py-1 text-xs">
      <Badge variant={badge.variant} className="w-14 text-center">
        {badge.label}
      </Badge>
      <span className="font-medium text-foreground">{node.kind}</span>
      <span className="text-muted-foreground">{node.agent}</span>
      {node.taskId && (
        <span className="ml-auto text-[10px] text-muted-foreground/60">{node.taskId}</span>
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
  return <div className="px-2 py-8 text-center text-xs text-muted-foreground/50">No tasks</div>;
}
