import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Check, X, ChevronDown, Trash2, FolderTree, GitBranch } from "lucide-react";
import { daemon } from "../daemon";
import {
  CommandInfo,
  ConfigOption,
  FileDiff,
  FileDoc,
  HunkResolution,
  SessionUpdate,
  TaskDiff,
  TaskInfo,
} from "../protocol";
import { StreamLine, coalesceUpdates, streamKey } from "./MissionControl";
import { Composer } from "../components/Composer";
import { MergeDiff } from "../components/MergeDiff";
import { FileTree } from "../components/FileTree";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTree, setShowTree] = useState(false);
  // Bumped on window focus to refetch the diff (terminal edits show on return).
  const [focusTick, setFocusTick] = useState(0);
  const streamParent = useRef<HTMLDivElement>(null);
  const unifiedScroll = useRef<HTMLDivElement>(null);

  // Scroll a file's block into view inside the unified diff — only that
  // viewport, so tree/panels around it don't move.
  const scrollToFile = (path: string) => {
    const vp = unifiedScroll.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement | null;
    const el = vp?.querySelector(`#${CSS.escape(fileAnchor(path))}`) as HTMLElement | null;
    if (!vp || !el) return;
    const top = el.getBoundingClientRect().top - vp.getBoundingClientRect().top + vp.scrollTop;
    vp.scrollTo({ top: top - 8, behavior: "smooth" });
  };
  const badge = taskBadge(task.status);
  const editable = task.status !== "done";

  const setView = (v: "unified" | "split") => {
    localStorage.setItem("wf-diff-view", v);
    setDiffView(v);
  };

  useEffect(() => {
    const onFocus = () => setFocusTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Default the split-view selection to the first changed file.
  useEffect(() => {
    if (!diff) return;
    const paths = diff.files.map((f) => f.path);
    if (selectedFile && paths.includes(selectedFile)) return;
    setSelectedFile(paths[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff]);

  // Load the selected file's old/new text for the split editor. Keyed on
  // task.updatedAt so an agent editing the open file refetches. MergeDiff
  // syncs the right pane in place and skips its own save-echo, so this no
  // longer clobbers unsaved edits.
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
  }, [diffView, selectedFile, task.id, task.updatedAt, focusTick]);

  const merged = useMemo(() => coalesceUpdates(updates), [updates]);

  // Persisted permission answers (request_id → outcome) so resolved prompts
  // don't re-show live buttons after a reopen.
  const resolvedPerms = useMemo(() => {
    const m: Record<string, string> = {};
    for (const u of updates) {
      if (u.kind === "permission_resolved") m[u.request_id] = u.outcome;
    }
    return m;
  }, [updates]);


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
    setDiff(null); // clear only when switching tasks, not on every refetch
  }, [task.id]);

  // Refetch the diff on task switch and after edits (updatedAt bumps). Don't
  // null it out here — replacing in place avoids re-mounting the whole diff
  // (which flashed the tabs/tree/editor on every ⌘S save).
  useEffect(() => {
    setDiffError(null);
    daemon
      .request("diff.get", { task_id: task.id })
      .then((d) => setDiff(d as TaskDiff))
      .catch((e: Error) => setDiffError(e.message));
  }, [task.id, task.updatedAt, focusTick]);

  // Virtualize the conversation — histories run to thousands of updates
  // (codex re-sends every tool_call frame), so only mount what's on screen.
  const streamVirtualizer = useVirtualizer({
    count: merged.length,
    getScrollElement: () => streamParent.current,
    estimateSize: () => 72,
    overscan: 12,
    getItemKey: (i) => streamKey(merged[i], i),
  });

  useEffect(() => {
    if (merged.length > 0) {
      streamVirtualizer.scrollToIndex(merged.length - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged.length]);

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
          variant={confirmDelete ? "destructive" : "ghost"}
          size="sm"
          title="Delete task and its history"
          onBlur={() => setConfirmDelete(false)}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void daemon.deleteTask(task.id);
            onClose();
          }}
        >
          <Trash2 className="size-4" />
          {confirmDelete && "confirm delete"}
        </Button>
      </div>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1 gap-0">
        {/* ── Conversation ── */}
        <ResizablePanel defaultSize={42} minSize={28}>
          <Card className="flex h-full min-h-0 flex-col border-0 bg-transparent shadow-none">
            <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Conversation
            </div>
            <div ref={streamParent} className="min-w-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
              {merged.length === 0 ? (
                <p className="text-muted-foreground">No session activity yet.</p>
              ) : (
                <div
                  className="relative w-full"
                  style={{ height: streamVirtualizer.getTotalSize() }}
                >
                  {streamVirtualizer.getVirtualItems().map((vi) => (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={streamVirtualizer.measureElement}
                      className="absolute left-0 top-0 w-full pb-3"
                      style={{ transform: `translateY(${vi.start}px)` }}
                    >
                      <StreamLine
                        update={merged[vi.index]}
                        taskId={task.id}
                        resolved={resolvedPerms}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <Composer
              commands={commands}
              disabled={task.status === "done"}
              onSend={(text) => void daemon.request("session.prompt", { task_id: task.id, text })}
              toolbar={
                task.configOptions && task.configOptions.length > 0 ? (
                  <ConfigBar taskId={task.id} options={task.configOptions} />
                ) : undefined
              }
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
            {diff?.branch && (
              <span
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
                title={diff.branch}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate font-mono">{diff.branch}</span>
              </span>
            )}
            <button
              onClick={() => setShowTree((v) => !v)}
              title="Toggle changed-files tree"
              className={cn(
                "ml-auto rounded-md border px-1.5 py-1 transition-colors",
                showTree
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FolderTree className="size-3.5" />
            </button>
            <div className="flex rounded-md border p-0.5">
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

          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {diffView === "unified" ? (
                <ScrollArea ref={unifiedScroll} className="flex-1">
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
                        id={fileAnchor(file.path)}
                        file={file}
                        localRes={localRes}
                        onResolve={resolveHunk}
                      />
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <>
                  {/* Tab strip — only when the tree is hidden. */}
                  {!showTree && diff && diff.files.length > 0 && (
                    <div className="flex gap-1 overflow-x-auto border-b px-2 py-1.5">
                      {diff.files.map((f) => {
                        const name = f.path.split("/").pop() ?? f.path;
                        const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
                        return (
                          <button
                            key={f.path}
                            onClick={() => setSelectedFile(f.path)}
                            title={f.path}
                            className={cn(
                              "flex max-w-[220px] shrink-0 flex-col items-start rounded px-2 py-1 font-mono text-xs transition-colors",
                              selectedFile === f.path
                                ? "bg-secondary text-foreground"
                                : "text-muted-foreground hover:bg-secondary/50",
                            )}
                          >
                            <span className="max-w-full truncate">{name}</span>
                            {dir && (
                              <span className="max-w-full truncate text-[10px] text-muted-foreground/70">
                                {dir}
                              </span>
                            )}
                          </button>
                        );
                      })}
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
                </>
              )}
            </div>

            {/* Changed-files tree (right), toggled — replaces the tab strip. */}
            {showTree && diff && diff.files.length > 0 && (
              <div className="w-56 shrink-0 overflow-auto border-l">
                <FileTree
                  files={diff.files}
                  selected={selectedFile}
                  onSelect={(path) => {
                    setSelectedFile(path);
                    if (diffView === "unified") {
                      scrollToFile(path);
                    } else {
                      setView("split");
                    }
                  }}
                />
              </div>
            )}
          </div>
        </Card>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/** Renders the agent's session selectors, keeping at most one menu open. */
function ConfigBar({ taskId, options }: { taskId: string; options: ConfigOption[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {options.map((opt) => (
        <ConfigSelect
          key={opt.id}
          taskId={taskId}
          opt={opt}
          open={openId === opt.id}
          onToggle={() => setOpenId((id) => (id === opt.id ? null : opt.id))}
          onClose={() => setOpenId((id) => (id === opt.id ? null : id))}
        />
      ))}
    </>
  );
}

/**
 * A session selector the agent exposes (model / mode / reasoning effort). Shows
 * the current value; opens a menu to switch it via `session.setConfigOption`.
 * The daemon echoes the change back as a task.updated, so no local value state.
 */
function ConfigSelect({
  taskId,
  opt,
  open,
  onToggle,
  onClose,
}: {
  taskId: string;
  opt: ConfigOption;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const cur = opt.options.find((o) => o.value === opt.currentValue)?.name ?? opt.currentValue;
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        onBlur={() => setTimeout(onClose, 120)}
        title={opt.name}
        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
      >
        {cur}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 max-h-[50vh] min-w-[180px] overflow-y-auto rounded-md border bg-popover shadow-md">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {opt.name}
          </div>
          {opt.options.map((o) => (
            <button
              key={o.value}
              onMouseDown={(e) => {
                e.preventDefault();
                onClose();
                if (o.value !== opt.currentValue) {
                  void daemon.request("session.setConfigOption", {
                    task_id: taskId,
                    config_id: opt.id,
                    value: o.value,
                  });
                }
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
                o.value === opt.currentValue ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <Check
                className={cn(
                  "size-3 shrink-0",
                  o.value === opt.currentValue ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="truncate">{o.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Stable DOM id for a file's unified-diff block, for tree-click scroll-to. */
const fileAnchor = (path: string) => `diff-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;

function FileDiffView({
  id,
  file,
  localRes,
  onResolve,
}: {
  id?: string;
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
    <div id={id} className="mb-3 scroll-mt-2 overflow-hidden rounded-md border">
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
