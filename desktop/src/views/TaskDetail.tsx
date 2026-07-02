import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Send, Check, X, ChevronDown } from "lucide-react";
import { daemon } from "../daemon";
import { FileDiff, SessionUpdate, TaskDiff, TaskInfo } from "../protocol";
import { StreamLine } from "./MissionControl";
import { taskBadge } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  task: TaskInfo;
  updates: SessionUpdate[];
  onClose: () => void;
}

/**
 * Task detail: the conversation with the agent (stream + composer) on the
 * left, multi-file diff with per-hunk accept/reject on the right — Zed's
 * agent-panel review is the bar.
 */
export default function TaskDetail({ task, updates, onClose }: Props) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const streamEnd = useRef<HTMLDivElement>(null);
  const badge = taskBadge(task.status);

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    daemon
      .request("diff.get", { task_id: task.id })
      .then((d) => setDiff(d as TaskDiff))
      .catch((e: Error) => setDiffError(e.message));
  }, [task.id, task.updatedAt]);

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [updates.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void daemon.request("session.prompt", { task_id: task.id, text });
    setDraft("");
  };

  const resolveHunk = (file: string, hunkIndex: number, resolution: "accept" | "reject") =>
    daemon
      .request("diff.resolveHunk", { task_id: task.id, file, hunk_index: hunkIndex, resolution })
      .catch((e: Error) => setDiffError(e.message));

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft className="size-4" />
          board
        </Button>
        <h1 className="flex-1 truncate text-base font-semibold">{task.prompt}</h1>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {task.project} · {task.agent}
        </span>
        {(task.status === "running" || task.status === "queued") && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void daemon.request("task.cancel", { task_id: task.id })}
          >
            cancel
          </Button>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,1fr)_1.5fr] gap-3">
        {/* ── Conversation ── */}
        <Card className="flex min-h-0 flex-col">
          <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Conversation
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-2 p-4 text-sm">
              {updates.length === 0 && (
                <p className="text-muted-foreground">No session activity yet.</p>
              )}
              {updates.map((u, i) => (
                <StreamLine key={i} update={u} />
              ))}
              <div ref={streamEnd} />
            </div>
          </ScrollArea>
          <div className="flex items-end gap-2 border-t p-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
              placeholder="Message or steer the agent…  (⌘↵ to send)"
              className="max-h-32 min-h-[38px] flex-1 resize-none"
              rows={1}
            />
            <Button size="icon" onClick={send} disabled={!draft.trim()}>
              <Send className="size-4" />
            </Button>
          </div>
        </Card>

        {/* ── Diff ── */}
        <Card className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Changes
            </span>
            {diff && (
              <span className="tnum text-xs text-muted-foreground">{diff.files.length} files</span>
            )}
          </div>
          <ScrollArea className="flex-1">
            <div className="p-3">
              {diffError && <p className="text-sm text-destructive">{diffError}</p>}
              {!diff && !diffError && (
                <p className="text-sm text-muted-foreground">Loading diff…</p>
              )}
              {diff && diff.files.length === 0 && (
                <p className="text-sm text-muted-foreground">No changes yet.</p>
              )}
              {diff?.files.map((file) => (
                <FileDiffView key={file.path} file={file} onResolve={resolveHunk} />
              ))}
            </div>
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}

function FileDiffView({
  file,
  onResolve,
}: {
  file: FileDiff;
  onResolve: (file: string, hunkIndex: number, r: "accept" | "reject") => void;
}) {
  const [open, setOpen] = useState(true);
  const statusColor =
    file.status === "added"
      ? "text-ok"
      : file.status === "deleted"
        ? "text-destructive"
        : "text-warn";

  return (
    <div className="mb-3 overflow-hidden rounded-md border">
      <button
        className="flex w-full items-center gap-2 bg-secondary/50 px-3 py-2 text-left font-mono text-xs hover:bg-secondary"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        <span className={cn("uppercase", statusColor)}>{file.status}</span>
        <span>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
      </button>
      {open &&
        file.hunks.map((hunk, i) => (
          <div
            key={i}
            className={cn(
              "border-t",
              hunk.resolution === "accept" && "border-l-2 border-l-ok",
              hunk.resolution === "reject" && "border-l-2 border-l-destructive opacity-50",
            )}
          >
            <div className="flex items-center justify-between bg-muted/40 px-3 py-1">
              <code className="tnum text-xs text-muted-foreground">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </code>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={hunk.resolution === "accept" ? "default" : "outline"}
                  className="h-6"
                  onClick={() => onResolve(file.path, i, "accept")}
                >
                  <Check className="size-3" />
                  accept
                </Button>
                <Button
                  size="sm"
                  variant={hunk.resolution === "reject" ? "destructive" : "outline"}
                  className="h-6"
                  onClick={() => onResolve(file.path, i, "reject")}
                >
                  <X className="size-3" />
                  reject
                </Button>
              </div>
            </div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
              {hunk.lines.map((line, j) => (
                <div
                  key={j}
                  className={cn(
                    "px-1",
                    line.startsWith("+") && "bg-ok/10 text-ok",
                    line.startsWith("-") && "bg-destructive/10 text-destructive",
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          </div>
        ))}
    </div>
  );
}
