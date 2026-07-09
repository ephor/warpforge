import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Check,
  X,
  ChevronDown,
  Trash2,
  FolderTree,
  GitBranch,
  MessagesSquare,
  Columns2,
  FileText,
  SquareTerminal,
  PanelRight,
} from "lucide-react";
import { RuntimePanel } from "../components/RuntimePanel";
import { daemon, DaemonState } from "../daemon";
import {
  CommandInfo,
  FileDiff,
  FileDoc,
  HunkResolution,
  ProjectFile,
  SessionUpdate,
  TaskDiff,
  TaskInfo,
} from "../protocol";
import { StreamLine, coalesceUpdates, streamKey } from "./MissionControl";
import { useUi } from "../store/ui";
import { Composer } from "../components/Composer";
import { AgentConfigBar } from "../components/AgentConfigBar";
import { CodeEditor } from "../components/CodeEditor";
import { MergeDiff } from "../components/MergeDiff";
import { ChangesRail } from "../components/ChangesRail";
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
  state: DaemonState;
  onClose: () => void;
}

type ActiveTab = { kind: "changes" } | { kind: "file"; path: string };

/**
 * Task detail: the conversation with the agent (stream + composer) on the
 * left, multi-file diff with per-hunk accept/reject on the right — Zed's
 * agent-panel review is the bar.
 */
export default function TaskDetail({ task, updates, state, onClose }: Props) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [localRes, setLocalRes] = useState<Record<string, HunkResolution>>({});
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>({ kind: "changes" });
  const [openFileTabs, setOpenFileTabs] = useState<string[]>([]);
  const diffView = useUi((s) => s.diffView);
  const setDiffView = useUi((s) => s.setDiffView);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDoc, setFileDoc] = useState<FileDoc | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showChat = useUi((s) => s.showChat);
  const showDiff = useUi((s) => s.showDiff);
  const rightPanel = useUi((s) => s.rightPanel);
  const toggleChat = useUi((s) => s.toggleChat);
  const toggleDiff = useUi((s) => s.toggleDiff);
  const setShowDiff = useUi((s) => s.setShowDiff);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setRightPanel = useUi((s) => s.setRightPanel);
  const runtimeOpen = useUi((s) => s.runtimeOpen);
  const setRuntimeOpen = useUi((s) => s.setRuntimeOpen);
  const services = state.snapshot.services.filter((s) => s.project === task.project);
  const portforwards = state.snapshot.portforwards.filter((p) => p.project === task.project);
  // Bumped on window focus to refetch the diff (terminal edits show on return).
  const [focusTick, setFocusTick] = useState(0);
  const streamParent = useRef<HTMLDivElement>(null);
  const badge = taskBadge(task.status);
  const editable = task.status !== "done";
  const activeFile = activeTab.kind === "file" ? activeTab.path : selectedFile;

  const setView = (v: "unified" | "split") => setDiffView(v);
  const openFileTab = (path: string) => {
    setOpenFileTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setSelectedFile(path);
    setActiveTab({ kind: "file", path });
    setShowDiff(true);
    setCenterTab("editor");
  };
  const openDiffFile = (path: string) => {
    setSelectedFile(path);
    setActiveTab({ kind: "changes" });
    setShowDiff(true);
    setCenterTab("changes");
    if (diffView === "unified") {
      requestAnimationFrame(() => {
        document.getElementById(fileAnchor(path))?.scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
      });
    }
  };
  const openChangesTab = () => {
    setActiveTab({ kind: "changes" });
    setShowDiff(true);
    setCenterTab("changes");
  };
  const closeFileTab = (path: string) => {
    setOpenFileTabs((tabs) => {
      const idx = tabs.indexOf(path);
      const next = tabs.filter((p) => p !== path);
      if (activeTab.kind === "file" && activeTab.path === path) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveTab(fallback ? { kind: "file", path: fallback } : { kind: "changes" });
        setSelectedFile(fallback ?? null);
        if (!fallback) setCenterTab("changes");
      }
      return next;
    });
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
    if (!activeFile || (activeTab.kind === "changes" && diffView !== "split")) {
      setFileDoc(null);
      return;
    }
    let cancelled = false;
    daemon
      .request("file.contents", { task_id: task.id, path: activeFile })
      .then((d) => !cancelled && setFileDoc(d as FileDoc))
      .catch(() => !cancelled && setFileDoc(null));
    return () => {
      cancelled = true;
    };
  }, [activeFile, activeTab.kind, diffView, task.id, task.updatedAt, focusTick]);

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

  useEffect(() => {
    setFileListError(null);
    daemon
      .request("file.list", { task_id: task.id })
      .then((d) => setProjectFiles(Array.isArray(d) ? (d as ProjectFile[]) : []))
      .catch((e: Error) => setFileListError(e.message));
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

  const openTabs = useMemo(() => {
    const changed = new Set((diff?.files ?? []).map((f) => f.path));
    return openFileTabs.map((path) => ({ path, changed: changed.has(path) }));
  }, [diff?.files, openFileTabs]);
  const rightRailOpen = showDiff && rightPanel !== null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex h-9 shrink-0 items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-muted-foreground">
          <ArrowLeft className="size-4" />
          board
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{task.prompt}</h1>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="max-w-36 truncate">{task.project}</span>
          <span>·</span>
          <GitBranch className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate font-mono">{diff?.branch ?? "no-branch"}</span>
          <span>·</span>
          <span className="max-w-32 truncate">{task.agent}</span>
        </span>
        {(task.status === "running" || task.status === "queued") && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void daemon.request("task.cancel", { task_id: task.id })}
          >
            cancel
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-2">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1 gap-0">
        {/* ── Conversation ── */}
        {showChat && (
        <ResizablePanel id="chat" order={1} defaultSize={showDiff ? 42 : 100} minSize={28}>
          <Card className="flex h-full min-h-0 flex-col overflow-hidden border-border/80 bg-card/95 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]">
            <div className="flex h-11 items-center gap-2 border-b px-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">Conversation</div>
                <div className="truncate text-xs text-muted-foreground">Steer the agent or respond to requests</div>
              </div>
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
                  <AgentConfigBar taskId={task.id} options={task.configOptions} />
                ) : undefined
              }
            />
          </Card>
        </ResizablePanel>
        )}

        {showChat && showDiff && <ResizableHandle withHandle className="mx-2" />}

        {/* ── Center: Changes / Editor ── */}
        {showDiff && (
        <ResizablePanel id="center" order={2} defaultSize={showChat ? 58 : 100} minSize={30}>
        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-border/80 bg-card/95 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]">
          <div className="flex h-10 min-w-0 items-center gap-1 border-b px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              <button
                type="button"
                onClick={openChangesTab}
                className={cn(
                  "flex h-7 shrink-0 items-center rounded-md border px-2 text-xs",
                  activeTab.kind === "changes"
                    ? "border-border bg-secondary text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                All Changes
              </button>
              {openTabs.map((f) => {
                const name = f.path.split("/").pop() ?? f.path;
                const active = activeTab.kind === "file" && activeTab.path === f.path;
                return (
                  <div
                    key={f.path}
                    title={f.path}
                    className={cn(
                      "flex h-7 max-w-[240px] shrink-0 items-center overflow-hidden rounded-md border font-mono text-xs",
                      active
                        ? "border-border bg-secondary text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => openFileTab(f.path)}
                      className="flex min-w-0 items-center gap-1.5 px-2"
                    >
                      <FileText className={cn("size-3.5 shrink-0", f.changed ? "text-sky-400" : "text-muted-foreground")} />
                      <span className="truncate">{name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${name}`}
                      onClick={() => closeFileTab(f.path)}
                      className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                  type="button"
                aria-label="Toggle changed files tree"
                onClick={() => setRightPanel(rightPanel === "changes" ? null : "changes")}
                title="Toggle changes panel"
                  className={cn(
                  "rounded-md p-1.5 transition-colors",
                  rightPanel === "changes"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  )}
                >
                <FolderTree className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="flex h-9 items-center gap-2 border-b bg-background/25 px-3">
            <span className="text-xs font-medium text-muted-foreground">
              {activeTab.kind === "changes" ? "Changes" : "Editor"}
            </span>
            {diff && activeTab.kind === "changes" && (
              <span className="tnum text-xs text-muted-foreground">{diff.files.length} files</span>
            )}
            {activeTab.kind === "file" && (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {activeTab.path}
              </span>
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
            {activeTab.kind === "changes" && (
              <div className="ml-auto flex items-center gap-2">
                <div className="flex rounded-md border border-border/80 bg-background/30 p-0.5">
                  {(["unified", "split"] as const).map((v) => (
                    <button
                      type="button"
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
            )}
          </div>

          <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
            <ResizablePanel id="workspace" order={1} defaultSize={runtimeOpen ? 78 : 100} minSize={35}>
              {activeTab.kind === "changes" ? (
                <div className="flex h-full min-h-0 min-w-0 flex-col">
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
                            id={fileAnchor(file.path)}
                            file={file}
                            localRes={localRes}
                            onResolve={resolveHunk}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  ) : (
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
                  )}
                </div>
              ) : fileDoc ? (
                <CodeEditor
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
            </ResizablePanel>
            {runtimeOpen && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel id="runtime" order={2} defaultSize={22} minSize={12} maxSize={55}>
                  <RuntimePanel
                    project={task.project}
                    services={services}
                    portforwards={portforwards}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </Card>
        </ResizablePanel>
        )}

        {rightRailOpen && (
          <>
            {(showChat || showDiff) && <ResizableHandle withHandle className="mx-2" />}
            <ResizablePanel id="right-panel" order={3} defaultSize={26} minSize={16} maxSize={44}>
              <Card className="flex h-full min-h-0 flex-col overflow-hidden border-border/80 bg-card/95 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]">
                {rightPanel === "changes" ? (
                  diff ? (
                    <ChangesRail
                      project={task.project}
                      files={diff.files}
                      selected={selectedFile}
                      taskId={task.id}
                      onCommitted={() => setFocusTick((t) => t + 1)}
                      onRefresh={() => setFocusTick((t) => t + 1)}
                      onSelect={openDiffFile}
                    />
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">Loading changes…</p>
                  )
                ) : (
                  <ProjectFilesPanel
                    files={projectFiles}
                    error={fileListError}
                    selected={activeFile}
                    onSelect={openFileTab}
                  />
                )}
              </Card>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <div className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border bg-card/95 py-2 text-muted-foreground">
        <button
          type="button"
          aria-label="Toggle chat"
          title="Toggle chat"
          onClick={toggleChat}
          className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", showChat && "bg-secondary text-foreground")}
        >
          <MessagesSquare className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Toggle editor"
          title="Toggle editor"
          onClick={toggleDiff}
          className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", showDiff && "bg-secondary text-foreground")}
        >
          <Columns2 className="size-4" />
        </button>
        <div className="my-1 h-px w-5 bg-border" />
        <button
          type="button"
          aria-label="Files"
          title="Files"
          onClick={() => {
            setShowDiff(true);
            setRightPanel(rightPanel === "files" ? null : "files");
          }}
          className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", rightPanel === "files" && "bg-secondary text-foreground")}
        >
          <FolderTree className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Changes"
          title="Changes"
          onClick={() => {
            setShowDiff(true);
            setRightPanel(rightPanel === "changes" ? null : "changes");
          }}
          className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", rightPanel === "changes" && "bg-secondary text-foreground")}
        >
          <PanelRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Runtime"
          title="Runtime"
          onClick={() => setRuntimeOpen(!runtimeOpen)}
          className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", runtimeOpen && "bg-secondary text-foreground")}
        >
          <SquareTerminal className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Delete task"
          title="Delete task"
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void daemon.deleteTask(task.id);
            onClose();
          }}
          className={cn("mt-auto rounded-md p-1.5 hover:bg-destructive/20 hover:text-destructive", confirmDelete && "bg-destructive/20 text-destructive")}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      </div>
    </div>
  );
}

interface ProjectTreeNode {
  name: string;
  path?: string;
  changed?: boolean;
  children: Map<string, ProjectTreeNode>;
}

function buildProjectTree(files: ProjectFile[]): ProjectTreeNode {
  const root: ProjectTreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.path = f.path;
        child.changed = f.changed;
      }
      node = child;
    });
  }
  return root;
}

function ProjectFileRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: ProjectTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pad = { paddingLeft: `${depth * 12 + 10}px` };

  if (node.path) {
    return (
      <button
        type="button"
        style={pad}
        onClick={() => onSelect(node.path!)}
        title={node.path}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs",
          selected === node.path ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
        )}
      >
        <FileText className={cn("size-3.5 shrink-0", node.changed ? "text-sky-400" : "text-muted-foreground")} />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const children = [...node.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });

  return (
    <>
      <button
        type="button"
        style={pad}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
        <span className="truncate">{node.name}</span>
      </button>
      {open &&
        children.map((child) => (
          <ProjectFileRow
            key={child.path ?? child.name}
            node={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function ProjectFilesPanel({
  files,
  error,
  selected,
  onSelect,
}: {
  files: ProjectFile[];
  error: string | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const root = useMemo(() => buildProjectTree(files), [files]);
  const top = useMemo(
    () =>
      [...root.children.values()].sort((a, b) => {
        const af = a.path ? 1 : 0;
        const bf = b.path ? 1 : 0;
        return af - bf || a.name.localeCompare(b.name);
      }),
    [root],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 items-center border-b px-3 text-sm font-semibold">Files</div>
      {error && <p className="border-b px-3 py-2 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {top.length === 0 && !error ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No files found.</p>
        ) : (
          top.map((node) => (
            <ProjectFileRow
              key={node.path ?? node.name}
              node={node}
              depth={0}
              selected={selected}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
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
        type="button"
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
            key={`${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`}
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
                  type="button"
                  size="sm"
                  variant={resolution === "accept" ? "default" : "outline"}
                  className="h-6"
                  onClick={() => onResolve(file.path, i, "accept")}
                >
                  <Check className="size-3" />
                  accept
                </Button>
                <Button
                  type="button"
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
                  key={`${hunk.oldStart}:${hunk.newStart}:${j}:${line}`}
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
