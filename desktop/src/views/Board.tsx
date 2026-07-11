import { useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Plus, Clock, CheckCheck, GitPullRequestArrow, Activity } from "lucide-react";
import { Snapshot, TaskInfo, TaskStatus } from "../protocol";
import { taskBadge, elapsed } from "@/lib/status";
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

  const agents = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.agent))].sort(),
    [snapshot.tasks],
  );

  const match = (t: TaskInfo) =>
    (project === "all" || t.project === project) && (agent === "all" || t.agent === agent);
  const tasks = snapshot.tasks.filter(match);

  const byStatus = (s: TaskStatus | TaskStatus[]) => {
    const set = Array.isArray(s) ? s : [s];
    return tasks.filter((t) => set.includes(t.status));
  };

  // Queue ordered by local priority, unknown ids appended.
  const queued = useMemo(() => {
    const q = byStatus("queued");
    return [...q].sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
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

  const done = byStatus("done").sort((a, b) => b.updatedAt - a.updatedAt);
  const running = byStatus("running");
  // Open conversations: the agent is either working (running) or waiting for
  // your next message (idle). Both are live, non-review, non-done.
  const active = byStatus(["running", "idle"]);
  const review = byStatus(["needs_review", "blocked", "interrupted"]);

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
        <Column title="Queue" hint="drag order → priority" count={queued.length}>
          {queued.map((t, i) => (
            <QueueCard
              key={t.id}
              task={t}
              rank={i + 1}
              first={i === 0}
              last={i === queued.length - 1}
              onOpen={() => onOpenTask(t.id)}
              onUp={() => move(t.id, -1)}
              onDown={() => move(t.id, 1)}
            />
          ))}
          {queued.length === 0 && <Empty />}
        </Column>

        <Column title="Active" count={active.length}>
          {active.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={() => onOpenTask(t.id)} />
          ))}
          {active.length === 0 && <Empty />}
        </Column>

        <Column title="Review / blocked" count={review.length}>
          {review.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={() => onOpenTask(t.id)} />
          ))}
          {review.length === 0 && <Empty />}
        </Column>

        <Column title="History" count={done.length}>
          {done.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={() => onOpenTask(t.id)} muted />
          ))}
          {done.length === 0 && <Empty />}
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

function TaskCard({ task, onOpen, muted }: { task: TaskInfo; onOpen: () => void; muted?: boolean }) {
  const badge = taskBadge(task.status);
  return (
    <Card
      className={cn(
        "cursor-pointer bg-secondary/40 p-2.5 transition-colors hover:border-primary/60",
        muted && "opacity-70",
      )}
      onClick={onOpen}
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{task.project}</span>
        <span>{task.agent}</span>
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
    </Card>
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
