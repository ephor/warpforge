import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, X, ChevronDown, Trash2 } from "lucide-react";
import { daemon } from "../daemon";
import {
  CommandInfo,
  FileDiff,
  FileDoc,
  HunkResolution,
  SessionUpdate,
  TaskDiff,
  TaskInfo,
} from "../protocol";
import { StreamLine } from "./MissionControl";
import { Composer } from "../components/Composer";
import { MergeDiff } from "../components/MergeDiff";
import { taskBadge } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
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
  const [localRes, setLocalRes] = useState<Record<string, HunkResolution>>({});
  const [diffView, setDiffView] = useState<"unified" | "split">(
    () => (localStorage.getItem("wf-diff-view") as "unified" | "split") || "split",
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDoc, setFileDoc] = useState<FileDoc | null>(null);
  const streamEnd = useRef<HTMLDivElement>(null);
  const badge = taskBadge(task.status);
  const editable = task.status !== "done";

  const setView = (v: "unified" | "split") => {
    localStorage.setItem("wf-diff-view", v);
    setDiffView(v);
  };

  // Default the split-view selection to the first changed file.
  useEffect(() => {
    if (!diff) return;
    const paths = diff.files.map((f) => f.path);
    if (selectedFile && paths.includes(selectedFile)) return;
    setSelectedFile(paths[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff]);

  // Load the selected file's old/new text for the split editor. Deliberately
  // NOT keyed on task.updatedAt — a save bumps that, and refetching mid-edit
  // would clobber the editor.
  useEffect(() => {
    if (diffView !== "split" || !selectedFile) {
      setFileDoc(null);
      return;
    }
    let cancelled = false;
    daemon
      .request("file.contents", { task_id: task.id, path: selectedFile })
      .then((d) => !cancelled && setFileDoc(d as FileDoc))
      .catch(() => !cancelled && setFileDoc(null));
    return () => {
      cancelled = true;
    };
  }, [diffView, selectedFile, task.id]);

  // Slash-menu commands = the agent's most recent available_commands update.
  const commands = useMemo<CommandInfo[]>(() => {
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      if (u.kind === "available_commands") return u.commands;
    }
    return [];
  }, [updates]);

  useEffect(() => {
    setLocalRes({});
  }, [task.id]);

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

  const resolveHunk = (file: string, hunkIndex: number, resolution: HunkResolution) => {
    // Optimistic: mark it now; a reject also revert-refetches via task.updated.
    setLocalRes((prev) => ({ ...prev, [`${file}#${hunkIndex}`]: resolution }));
    daemon
      .request("diff.resolveHunk", { task_id: task.id, file, hunk_index: hunkIndex, resolution })
      .catch((e: Error) => setDiffError(e.message));
  };

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
        <Button
          variant="ghost"
          size="sm"
          title="Delete task and its history"
          onClick={() => {
            if (confirm("Delete this task and its session history permanently?")) {
              void daemon.deleteTask(task.id);
              onClose();
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1 gap-0">
        {/* ── Conversation ── */}
        <ResizablePanel defaultSize={42} minSize={28}>
          <Card className="flex h-full min-h-0 flex-col">
            <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Conversation
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-2.5 p-4 text-sm">
                {updates.length === 0 && (
                  <p className="text-muted-foreground">No session activity yet.</p>
                )}
                {updates.map((u, i) => (
                  <StreamLine key={i} update={u} />
                ))}
                <div ref={streamEnd} />
              </div>
            </ScrollArea>
            <Composer
              commands={commands}
              disabled={task.status === "done"}
              onSend={(text) => void daemon.request("session.prompt", { task_id: task.id, text })}
            />
          </Card>
        </ResizablePanel>

        <ResizableHandle withHandle className="mx-2" />

        {/* ── Diff ── */}
        <ResizablePanel defaultSize={58} minSize={30}>
        <Card className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Changes
            </span>
            {diff && (
              <span className="tnum text-xs text-muted-foreground">{diff.files.length} files</span>
            )}
            <div className="ml-auto flex rounded-md border p-0.5">
              {(["unified", "split"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs capitalize transition-colors",
                    diffView === v
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {diffView === "unified" ? (
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
                  <FileDiffView
                    key={file.path}
                    file={file}
                    localRes={localRes}
                    onResolve={resolveHunk}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {diff && diff.files.length > 0 && (
                <div className="flex gap-1 overflow-x-auto border-b px-2 py-1.5">
                  {diff.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setSelectedFile(f.path)}
                      title={f.path}
                      className={cn(
                        "shrink-0 rounded px-2 py-1 font-mono text-xs transition-colors",
                        selectedFile === f.path
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-secondary/50",
                      )}
                    >
                      {f.path.split("/").pop()}
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1">
                {diff && diff.files.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No changes yet.</p>
                ) : fileDoc ? (
                  <MergeDiff
                    doc={fileDoc}
                    editable={editable}
                    onSave={(content) =>
                      void daemon.request("file.save", {
                        task_id: task.id,
                        path: fileDoc.path,
                        content,
                      })
                    }
                  />
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">Loading file…</p>
                )}
              </div>
            </div>
          )}
        </Card>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function FileDiffView({
  file,
  localRes,
  onResolve,
}: {
  file: FileDiff;
  localRes: Record<string, HunkResolution>;
  onResolve: (file: string, hunkIndex: number, r: HunkResolution) => void;
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
        file.hunks.map((hunk, i) => {
          const resolution = hunk.resolution ?? localRes[`${file.path}#${i}`] ?? null;
          return (
          <div
            key={i}
            className={cn(
              "border-t",
              resolution === "accept" && "border-l-2 border-l-ok",
              resolution === "reject" && "border-l-2 border-l-destructive opacity-50",
            )}
          >
            <div className="flex items-center justify-between bg-muted/40 px-3 py-1">
              <code className="tnum text-xs text-muted-foreground">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </code>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={resolution === "accept" ? "default" : "outline"}
                  className="h-6"
                  onClick={() => onResolve(file.path, i, "accept")}
                >
                  <Check className="size-3" />
                  accept
                </Button>
                <Button
                  size="sm"
                  variant={resolution === "reject" ? "destructive" : "outline"}
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
          );
        })}
    </div>
  );
}
