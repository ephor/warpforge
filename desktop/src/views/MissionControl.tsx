import { useState } from "react";
import {
  Maximize2,
  X,
  Wrench,
  FilePen,
  TriangleAlert,
  Send,
  Plus,
  ListTodo,
  ChevronRight,
} from "lucide-react";
import { daemon, DaemonState } from "../daemon";
import { SessionUpdate, TaskInfo } from "../protocol";
import { useUi } from "../store/ui";
import { Markdown } from "../components/Markdown";
import { taskEdge } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
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


export default function MissionControl({ state, onOpenTask, onNewTask }: Props) {
  const pinned = useUi((s) => s.pinnedTaskIds);
  const togglePin = useUi((s) => s.togglePinnedTask);
  const live = state.snapshot.tasks.filter((t) => t.status !== "done");

  const pinnedTasks = pinned
    .map((id) => live.find((t) => t.id === id))
    .filter((t): t is TaskInfo => !!t);

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-4 pr-3">
          {pinnedTasks.length > 0 ? (
            <div className="grid grid-cols-2 gap-3">
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
          ) : live.length > 0 ? (
            <div className="mt-16 flex flex-col items-center gap-2 text-center text-muted-foreground">
              <p className="text-foreground">No pinned sessions.</p>
              <p className="max-w-md text-sm">
                Pin sessions from the sidebar when you want them on the Mission Control board.
              </p>
            </div>
          ) : null}

          {live.length === 0 ? (
            <div className="mt-16 flex flex-col items-center gap-3 text-muted-foreground">
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
  const recent = coalesceUpdates(updates).slice(-40);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void daemon.request("session.prompt", { task_id: task.id, text });
    setDraft("");
  };

  return (
    <Card className={cn("flex max-h-[340px] flex-col border-l-[3px]", taskEdge(task.status))}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-semibold">{task.project}</span>
        <span className="truncate text-sm text-muted-foreground">{task.prompt}</span>
        <button className="ml-auto rounded p-0.5 hover:bg-secondary" onClick={onOpen} title="Full detail">
          <Maximize2 className="size-4" />
        </button>
        <button className="rounded p-0.5 hover:bg-secondary" onClick={onUnpin} title="Unpin">
          <X className="size-4" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-3 text-sm leading-relaxed">
          {recent.length === 0 && <p className="text-muted-foreground">waiting for agent…</p>}
          {recent.map((u, i) => (
            <StreamLine key={streamKey(u, i)} update={u} compact />
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-center gap-2 border-t p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Steer this session…"
          className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button size="icon" className="size-8" onClick={send} disabled={!draft.trim()}>
          <Send className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

/**
 * Fold a raw session stream into what should actually be shown:
 *  - consecutive `agent_text` / `agent_thought` chunks merge into one block
 *    (codex-acp streams sub-word deltas; otherwise each renders on its own line);
 *  - repeated `tool_call` frames for the same `tool_call_id` collapse to a
 *    single row updated in place (agents re-send a call many times as its status
 *    moves in_progress → completed).
 */
/**
 * A React key that stays stable across streaming/coalescing for updates that
 * hold local UI state (permission buttons, expandable tool cards). Coalescing
 * changes element counts, so an index key would remount these and reset their
 * state; keying by the update's own id avoids that. Stateless blocks fall back
 * to the index.
 */
export function streamKey(u: SessionUpdate, i: number): string {
  if (u.kind === "tool_call") return `tool:${u.tool_call_id}`;
  if (u.kind === "permission_request") return `perm:${u.request_id}`;
  if (u.kind === "permission_resolved") return `res:${u.request_id}`;
  return `i:${i}`;
}

export function coalesceUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  const toolAt = new Map<string, number>();
  for (const u of updates) {
    const prev = out[out.length - 1];
    if (
      (u.kind === "agent_text" || u.kind === "agent_thought") &&
      prev?.kind === u.kind
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + u.text };
    } else if (u.kind === "tool_call") {
      const at = toolAt.get(u.tool_call_id);
      const existing = at !== undefined ? out[at] : undefined;
      if (existing?.kind === "tool_call") {
        out[at!] = {
          ...existing,
          status: u.status,
          title: u.title || existing.title,
          tool_kind: u.tool_kind || existing.tool_kind,
          content: u.content ?? existing.content,
        };
      } else {
        toolAt.set(u.tool_call_id, out.length);
        out.push(u);
      }
    } else {
      out.push(u);
    }
  }
  return out;
}

/** Shared renderer for one session-stream update. `compact` = focus pane
 * (plain text, dense); otherwise the full Task Detail (markdown, tool cards). */
/** A tool-call card whose output can be expanded/collapsed. Collapsed by default. */
function ToolCallLine({
  update,
  dot,
}: {
  update: Extract<SessionUpdate, { kind: "tool_call" }>;
  dot: string;
}) {
  const [open, setOpen] = useState(false);
  const hasContent = !!update.content;
  return (
    <div className="rounded-md border bg-secondary/30">
      <button
        type="button"
        disabled={!hasContent}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          hasContent && "hover:bg-secondary/50",
        )}
      >
        {hasContent ? (
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
        ) : (
          <Wrench className={cn("size-3.5 shrink-0", dot)} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{update.title}</span>
        {update.tool_kind && update.tool_kind !== "other" && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {update.tool_kind}
          </span>
        )}
        <span className={cn("shrink-0 text-xs", dot)}>{update.status.replace("_", " ")}</span>
      </button>
      {open && hasContent && (
        <pre className="max-h-56 overflow-auto border-t px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {update.content}
        </pre>
      )}
    </div>
  );
}

/**
 * A permission prompt with allow/deny buttons. Once answered it collapses to a
 * muted "responded" row — the update itself lingers in the stream, so we track
 * the answer locally to stop showing live buttons.
 */
function PermissionLine({
  update,
  taskId,
  resolvedOutcome,
}: {
  update: Extract<SessionUpdate, { kind: "permission_request" }>;
  taskId?: string;
  /** Outcome recorded in the stream — persists across reopen/restart. */
  resolvedOutcome?: string;
}) {
  const [clicked, setClicked] = useState<string | null>(null);
  const answered = clicked ?? resolvedOutcome ?? null;
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        answered ? "border-border bg-secondary/20" : "border-warn/40 bg-warn/5",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5",
          answered ? "text-muted-foreground" : "mb-2 text-warn",
        )}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{update.title}</span>
        {answered && <span className="shrink-0 text-xs">✓ {answered.replace("_", " ")}</span>}
      </p>
      {!answered &&
        (taskId ? (
          <div className="flex flex-wrap gap-1.5">
            {update.options.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={opt === "deny" ? "destructive" : "default"}
                onClick={() => {
                  setClicked(opt);
                  void daemon.request("session.permission", {
                    task_id: taskId,
                    request_id: update.request_id,
                    outcome: opt,
                  });
                }}
              >
                {opt.replace("_", " ")}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open the task to respond.</p>
        ))}
    </div>
  );
}

export function StreamLine({
  update,
  compact,
  taskId,
  resolved,
}: {
  update: SessionUpdate;
  compact?: boolean;
  /** When set, permission requests render inline allow/deny buttons. */
  taskId?: string;
  /** request_id → recorded outcome, from persisted permission_resolved updates. */
  resolved?: Record<string, string>;
}) {
  switch (update.kind) {
    case "user_message":
      return (
        <div className={cn("rounded-md bg-primary/10 px-2.5 py-1.5 text-primary", compact && "text-xs")}>
          {compact ? <Markdown className="text-current">{`› ${update.text}`}</Markdown> : <Markdown>{update.text}</Markdown>}
        </div>
      );
    case "agent_text":
      return compact ? (
        <Markdown className="text-current">{update.text}</Markdown>
      ) : (
        <Markdown>{update.text}</Markdown>
      );
    case "agent_thought":
      return compact ? (
        <Markdown className="italic text-muted-foreground">{update.text}</Markdown>
      ) : (
        <p className="italic text-muted-foreground">💭 {update.text}</p>
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
      return <ToolCallLine update={update} dot={dot} />;
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
        <PermissionLine
          update={update}
          taskId={taskId}
          resolvedOutcome={resolved?.[update.request_id]}
        />
      );
    case "permission_resolved":
      // Metadata only — folded into the permission_request row above.
      return null;
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
