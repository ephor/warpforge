import { useState } from "react";
import {
  Maximize2,
  Pin,
  X,
  Wrench,
  FilePen,
  TriangleAlert,
  Send,
  Plus,
  ListTodo,
} from "lucide-react";
import { daemon, DaemonState } from "../daemon";
import { SessionUpdate, TaskInfo } from "../protocol";
import { Markdown } from "../components/Markdown";
import { taskBadge, taskEdge, elapsed } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

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

type PermissionUpdate = Extract<SessionUpdate, { kind: "permission_request" }>;

function pendingPermission(updates: SessionUpdate[]): PermissionUpdate | undefined {
  const last = updates[updates.length - 1];
  return last?.kind === "permission_request" ? last : undefined;
}

interface AttentionItem {
  task: TaskInfo;
  reason: string;
  priority: number;
  permission?: PermissionUpdate;
}

function attentionQueue(state: DaemonState): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of state.snapshot.tasks) {
    const permission = pendingPermission(state.sessionUpdates[task.id] ?? []);
    if (permission) items.push({ task, reason: permission.title, priority: 0, permission });
    else if (task.status === "needs_review")
      items.push({ task, reason: "finished — review changes", priority: 1 });
    else if (task.status === "blocked")
      items.push({ task, reason: task.blockedReason ?? "blocked", priority: 2 });
    else if (task.status === "interrupted")
      items.push({ task, reason: "session lost on daemon restart", priority: 3 });
  }
  return items.sort((a, b) => a.priority - b.priority || a.task.updatedAt - b.task.updatedAt);
}

function activityLine(updates: SessionUpdate[]): string {
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    if (u.kind === "tool_call") return `⚙ ${u.title}`;
    if (u.kind === "file_edit") return `✎ ${u.path}`;
    if (u.kind === "agent_text") return u.text;
    if (u.kind === "user_message") return `› ${u.text}`;
    if (u.kind === "permission_request") return `⚠ ${u.title}`;
    if (u.kind === "turn_ended") return `— turn ended (${u.stop_reason})`;
  }
  return "waiting for agent…";
}

export default function MissionControl({ state, onOpenTask, onNewTask }: Props) {
  const [pinned, setPinned] = useState<string[]>([]);
  const live = state.snapshot.tasks.filter((t) => t.status !== "done");
  const queue = attentionQueue(state);
  const working = live.filter((t) => t.status === "running").length;

  const togglePin = (id: string) =>
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-3), id]));

  const pinnedTasks = pinned
    .map((id) => live.find((t) => t.id === id))
    .filter((t): t is TaskInfo => !!t);

  return (
    <div className="grid h-full grid-cols-[300px_1fr] gap-4">
      {/* ── Attention rail ── */}
      <Card className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Needs you
          </span>
          {queue.length > 0 && (
            <span className="tnum flex size-5 items-center justify-center rounded-full bg-destructive text-xs font-bold text-destructive-foreground">
              {queue.length}
            </span>
          )}
        </div>
        <Separator />
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2 p-3">
            {queue.length === 0 ? (
              <div className="mt-10 px-4 text-center text-sm leading-relaxed text-muted-foreground">
                <p className="mb-1 text-foreground">All quiet.</p>
                {working} agent{working === 1 ? "" : "s"} working. Nothing needs you.
              </div>
            ) : (
              queue.map((item) => (
                <Card
                  key={item.task.id}
                  className="border-warn/40 bg-warn/5 p-3 transition-colors hover:border-warn"
                >
                  <button
                    className="mb-1.5 flex w-full items-center justify-between text-xs"
                    onClick={() => onOpenTask(item.task.id)}
                  >
                    <span className="font-semibold">{item.task.project}</span>
                    <Badge variant={taskBadge(item.task.status).variant}>
                      {taskBadge(item.task.status).label}
                    </Badge>
                  </button>
                  <p className="mb-2 text-sm">{item.reason}</p>
                  {item.permission ? (
                    <div className="flex flex-wrap gap-1.5">
                      {item.permission.options.map((opt) => (
                        <Button
                          key={opt}
                          size="sm"
                          variant={opt === "deny" ? "destructive" : "default"}
                          onClick={() =>
                            void daemon.request("session.permission", {
                              task_id: item.task.id,
                              request_id: item.permission!.request_id,
                              outcome: opt,
                            })
                          }
                        >
                          {opt}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onOpenTask(item.task.id)}>
                      {item.task.status === "needs_review" ? "review diff" : "open"}
                    </Button>
                  )}
                </Card>
              ))
            )}
          </div>
        </ScrollArea>
      </Card>

      {/* ── Wall + focus row ── */}
      <ScrollArea className="min-h-0">
        <div className="flex flex-col gap-4 pr-3">
          {pinnedTasks.length > 0 && (
            <div className="grid grid-flow-col auto-cols-fr gap-3">
              {pinnedTasks.map((task) => (
                <FocusPane
                  key={task.id}
                  task={task}
                  updates={state.sessionUpdates[task.id] ?? []}
                  onUnpin={() => togglePin(task.id)}
                  onOpen={() => onOpenTask(task.id)}
                />
              ))}
            </div>
          )}

          {live.length === 0 ? (
            <div className="mt-16 flex flex-col items-center gap-3 text-muted-foreground">
              <p>No live sessions.</p>
              <Button variant="outline" onClick={() => onNewTask()}>
                <Plus className="size-4" />
                Start a task
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {live.map((task) => (
                <SessionTile
                  key={task.id}
                  task={task}
                  updates={state.sessionUpdates[task.id] ?? []}
                  pinned={pinned.includes(task.id)}
                  onPin={() => togglePin(task.id)}
                  onOpen={() => onOpenTask(task.id)}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function SessionTile({
  task,
  updates,
  pinned,
  onPin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  pinned: boolean;
  onPin: () => void;
  onOpen: () => void;
}) {
  const badge = taskBadge(task.status);
  return (
    <Card
      className={cn(
        "cursor-pointer border-l-[3px] p-3 transition-colors hover:border-primary/60",
        taskEdge(task.status),
        pinned && "ring-1 ring-primary",
      )}
      onClick={onPin}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{task.project}</span>
        <span>{task.agent}</span>
        <span className="tnum ml-auto">{elapsed(task.createdAt)}</span>
        <button
          className="rounded p-0.5 hover:bg-secondary"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title="Open full detail"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      <p className="mt-2 truncate text-sm font-medium">{task.prompt}</p>
      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
        {activityLine(updates)}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {task.filesChanged > 0 && (
          <span className="tnum text-xs text-muted-foreground">{task.filesChanged} files</span>
        )}
        {pinned && <Pin className="ml-auto size-3.5 text-primary" />}
      </div>
    </Card>
  );
}

function FocusPane({
  task,
  updates,
  onUnpin,
  onOpen,
}: {
  task: TaskInfo;
  updates: SessionUpdate[];
  onUnpin: () => void;
  onOpen: () => void;
}) {
  const [draft, setDraft] = useState("");
  const recent = updates.slice(-14);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void daemon.request("session.prompt", { task_id: task.id, text });
    setDraft("");
  };

  return (
    <Card className={cn("flex max-h-[340px] flex-col border-l-[3px]", taskEdge(task.status))}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-semibold">{task.project}</span>
        <span className="truncate text-xs text-muted-foreground">{task.prompt}</span>
        <button className="ml-auto rounded p-0.5 hover:bg-secondary" onClick={onOpen} title="Full detail">
          <Maximize2 className="size-3.5" />
        </button>
        <button className="rounded p-0.5 hover:bg-secondary" onClick={onUnpin} title="Unpin">
          <X className="size-3.5" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1.5 p-3 text-xs">
          {recent.length === 0 && <p className="text-muted-foreground">waiting for agent…</p>}
          {recent.map((u, i) => (
            <StreamLine key={i} update={u} compact />
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-center gap-2 border-t p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Steer this session…"
          className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button size="icon" className="size-7" onClick={send} disabled={!draft.trim()}>
          <Send className="size-3.5" />
        </Button>
      </div>
    </Card>
  );
}

/** Shared renderer for one session-stream update. `compact` = focus pane
 * (plain text, dense); otherwise the full Task Detail (markdown, tool cards). */
export function StreamLine({ update, compact }: { update: SessionUpdate; compact?: boolean }) {
  switch (update.kind) {
    case "user_message":
      return (
        <div className={cn("rounded-md bg-primary/10 px-2.5 py-1.5 text-primary", compact && "text-xs")}>
          {compact ? `› ${update.text}` : <Markdown>{update.text}</Markdown>}
        </div>
      );
    case "agent_text":
      return compact ? (
        <p>{update.text}</p>
      ) : (
        <Markdown>{update.text}</Markdown>
      );
    case "agent_thought":
      return (
        <p className="italic text-muted-foreground">{compact ? update.text : `💭 ${update.text}`}</p>
      );
    case "tool_call": {
      const dot =
        update.status === "completed"
          ? "text-ok"
          : update.status === "failed"
            ? "text-destructive"
            : "text-warn";
      if (compact) {
        return (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Wrench className={cn("size-3.5 shrink-0", dot)} />
            <span className="text-foreground">{update.title}</span>
          </p>
        );
      }
      return (
        <div className="rounded-md border bg-secondary/30">
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
            <Wrench className={cn("size-3.5 shrink-0", dot)} />
            <span className="font-medium">{update.title}</span>
            {update.tool_kind && update.tool_kind !== "other" && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {update.tool_kind}
              </span>
            )}
            <span className={cn("ml-auto text-xs", dot)}>{update.status.replace("_", " ")}</span>
          </div>
          {update.content && (
            <pre className="max-h-56 overflow-auto border-t px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {update.content}
            </pre>
          )}
        </div>
      );
    }
    case "file_edit":
      return (
        <p className="flex items-center gap-1.5 font-mono text-xs">
          <FilePen className="size-3.5 shrink-0 text-primary" />
          {update.path}
        </p>
      );
    case "permission_request":
      return (
        <p className="flex items-center gap-1.5 text-warn">
          <TriangleAlert className="size-3.5 shrink-0" />
          {update.title}
        </p>
      );
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
            {update.entries.map((e, i) => (
              <li key={i} className="flex items-start gap-2">
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
                <span className={cn(e.status === "completed" && "text-muted-foreground line-through")}>
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "available_commands":
      // Metadata for the composer's slash menu — not shown inline.
      return null;
    case "turn_ended":
      return (
        <p className="text-center text-xs text-muted-foreground">
          — turn ended ({update.stop_reason}) —
        </p>
      );
  }
}
