import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useQueries,
} from "@tanstack/react-query";
import { daemonQuery } from "../query";
import {
  ArrowLeft,
  Check,
  X,
  ChevronDown,
  Trash2,
  Folder,
  GitBranch,
  GitCommitVertical,
  MessageSquare,
  Diff,
  FileText,
  SquareTerminal,
  RefreshCw,
  Loader2,
  ListTodo,
  Send,
} from "lucide-react";
import { RuntimePanel } from "../components/RuntimePanel";
import { daemon, DaemonState } from "../daemon";
import {
  CommandInfo,
  FileDiff,
  FileDoc,
  GitBranchList,
  GitOpResult,
  HunkResolution,
  OrchNodeInfo,
  ProjectFile,
  SessionUpdate,
  TaskDiff,
  TaskInfo,
} from "../protocol";
import {
  StreamLine,
  coalesceUpdates,
  streamKey,
} from "./MissionControl";
import { useUi } from "../store/ui";
import { Composer, ComposerHandle } from "../components/Composer";
import { AgentActivityIndicator } from "../components/AgentActivityIndicator";
import { AgentConfigBar } from "../components/AgentConfigBar";
import { CodeEditor } from "../components/CodeEditor";
import { MergeDiff } from "../components/MergeDiff";
import { ChangesRail } from "../components/ChangesRail";
import { sessionActivity } from "@/lib/sessionActivity";
import { resolvedPermissions } from "@/lib/sessionPermissions";
import { activityBadge, taskBadge, orchNodeBadge } from "@/lib/status";
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
import { toast } from "sonner";

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
  const [localRes, setLocalRes] = useState<Record<string, HunkResolution>>({});
  const [activeTab, setActiveTab] = useState<ActiveTab>({ kind: "changes" });
  const [openFileTabs, setOpenFileTabs] = useState<string[]>([]);
  const diffView = useUi((s) => s.diffView);
  const setDiffView = useUi((s) => s.setDiffView);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
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
  const queryClient = useQueryClient();

  const composerRef = useRef<ComposerHandle>(null);
  const streamParent = useRef<HTMLDivElement>(null);
  const badge = taskBadge(task.status);
  const editable = task.status !== "done";
  const activeFile = activeTab.kind === "file" ? activeTab.path : selectedFile;

  // ── On-demand daemon reads (TanStack Query) ──
  // Keyed on the task's server-side updatedAt, so a `task.updated` event (agent
  // edit, git op, hunk resolve) changes the key and refetches on its own;
  // keepPreviousData avoids re-mounting the diff/editor on every save, and the
  // window-focus refetch (query default) catches edits made outside the app.
  const diffQuery = useQuery({
    queryKey: ["diff", task.id, task.updatedAt],
    queryFn: daemonQuery<TaskDiff>("diff.get", { task_id: task.id }),
    refetchOnWindowFocus: "always",
    placeholderData: keepPreviousData,
  });
  const diff = diffQuery.data ?? null;

  const fileListQuery = useQuery({
    queryKey: ["fileList", task.id, task.updatedAt],
    queryFn: daemonQuery<ProjectFile[]>("file.list", { task_id: task.id }),
    placeholderData: keepPreviousData,
  });
  const projectFiles = Array.isArray(fileListQuery.data) ? fileListQuery.data : [];
  const fileListError = fileListQuery.error?.message ?? null;

  const fileContentsEnabled = !!activeFile && activeTab.kind === "file";
  const fileDocQuery = useQuery({
    queryKey: ["fileContents", task.id, activeFile, task.updatedAt],
    queryFn: daemonQuery<FileDoc>("file.contents", {
      task_id: task.id,
      path: activeFile,
    }),
    enabled: fileContentsEnabled,
    refetchOnWindowFocus: "always",
    placeholderData: keepPreviousData,
  });
  const fileDoc = fileContentsEnabled ? fileDocQuery.data ?? null : null;

  // Split review is still an all-changes view. Fetch every changed file here;
  // selectedFile only tracks the rail highlight/scroll target and must not
  // determine which diff blocks are mounted.
  const splitFileQueries = useQueries({
    queries:
      activeTab.kind === "changes" && diffView === "split"
        ? (diff?.files ?? []).map((file) => ({
            queryKey: ["fileContents", task.id, file.path, task.updatedAt],
            queryFn: daemonQuery<FileDoc>("file.contents", {
              task_id: task.id,
              path: file.path,
            }),
            refetchOnWindowFocus: "always" as const,
            placeholderData: keepPreviousData,
          }))
        : [],
  });

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
    requestAnimationFrame(() => {
      document.getElementById(fileAnchor(path))?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
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

  // Default the split-view selection to the first changed file.
  useEffect(() => {
    if (!diff) return;
    const paths = diff.files.map((f) => f.path);
    setSelectedFile((current) => {
      if (current && paths.includes(current)) return current;
      return paths[0] ?? null;
    });
  }, [diff]);

  const merged = useMemo(() => coalesceUpdates(updates), [updates]);
  const activity = useMemo(() => sessionActivity(task, merged), [task, merged]);
  // While the agent is actively working a turn, the header chip reflects the
  // live activity (thinking/working/writing) instead of the coarse status.
  const headerBadge = activity ? activityBadge(activity.tone, activity.label) : badge;

  // Persisted permission answers (request_id → outcome) so resolved prompts
  // don't re-show live buttons after a reopen.
  const resolvedPerms = useMemo(() => resolvedPermissions(updates), [updates]);


  // Slash-menu commands = the agent's most recent available_commands update.
  const commands = useMemo<CommandInfo[]>(() => {
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      if (u.kind === "available_commands") return u.commands;
    }
    return [];
  }, [updates]);
  const imageSupported = useMemo(() => {
    for (let i = updates.length - 1; i >= 0; i--) { const update = updates[i]; if (update.kind === "prompt_capabilities") return update.image; }
    return false;
  }, [updates]);

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

  const resolveHunkMut = useMutation({
    mutationFn: (v: { file: string; hunkIndex: number; resolution: HunkResolution }) =>
      daemon.request("diff.resolveHunk", {
        task_id: task.id,
        file: v.file,
        hunk_index: v.hunkIndex,
        resolution: v.resolution,
      }),
    // A reject rewrites the tree; refetch the diff to reflect the revert.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["diff", task.id] }),
  });
  const resolveHunk = (file: string, hunkIndex: number, resolution: HunkResolution) => {
    // Optimistic: mark it now; onSettled revert-refetches the diff.
    setLocalRes((prev) => ({ ...prev, [`${file}#${hunkIndex}`]: resolution }));
    resolveHunkMut.mutate({ file, hunkIndex, resolution });
  };
  const diffError = diffQuery.error?.message ?? resolveHunkMut.error?.message ?? null;

  const openTabs = useMemo(() => {
    const changed = new Set((diff?.files ?? []).map((f) => f.path));
    return openFileTabs.map((path) => ({ path, changed: changed.has(path) }));
  }, [diff?.files, openFileTabs]);
  const projectRoot = useMemo(
    () => state.snapshot.projects.find((p) => p.name === task.project)?.path.replace(/\/+$/, ""),
    [state.snapshot.projects, task.project],
  );
  const knownFilePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const file of projectFiles) paths.add(file.path);
    for (const file of diff?.files ?? []) paths.add(file.path);
    for (const path of openFileTabs) paths.add(path);
    return paths;
  }, [diff?.files, openFileTabs, projectFiles]);
  const resolveSessionFilePath = useCallback(
    (value: string): string | null => {
      let path = value.trim().replace(/^['"`]+|['"`]+$/g, "");
      path = path.replace(/:\d+(?::\d+)?$/, "");
      path = path.replace(/[),;]+$/, "");
      path = path.replace(/^\.\/+/, "");

      if (projectRoot && path.startsWith(`${projectRoot}/`)) {
        return path.slice(projectRoot.length + 1);
      }

      if (knownFilePaths.has(path)) return path;

      return null;
    },
    [knownFilePaths, projectRoot],
  );
  const rightRailOpen = showDiff && rightPanel !== null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex h-9 shrink-0 items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-muted-foreground">
          <ArrowLeft className="size-4" />
          board
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{task.prompt}</h1>
        <Badge variant={headerBadge.variant}>{headerBadge.label}</Badge>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="max-w-36 truncate">{task.project}</span>
          <span>·</span>
          <GitControls
            taskId={task.id}
            branch={diff?.branch ?? null}
          />
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
                        resolveFilePath={resolveSessionFilePath}
                        onOpenFile={openFileTab}
                      />
                    </div>
                  ))}
                </div>
              )}
              {activity && (
                <div className="sticky bottom-0 z-10 pt-3">
                  <AgentActivityIndicator activity={activity} />
                </div>
              )}
            </div>
            <Composer
              ref={composerRef}
              commands={commands}
              files={projectFiles}
              filesLoading={fileListQuery.isLoading}
              imageSupported={imageSupported}
              disabled={task.status === "done"}
              onSend={async (submission) => { await daemon.request("session.prompt", { task_id: task.id, ...submission }); }}
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
                <GitCommitVertical className="size-3.5" />
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
                            onSendToChat={(f) => {
                              composerRef.current?.attachDiff(f, formatFileDiffAsMessage(f));
                            }}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-auto">
                      {!diff ? (
                        <p className="p-3 text-sm text-muted-foreground">Loading diff…</p>
                      ) : diff.files.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">No changes yet.</p>
                      ) : (
                        diff.files.map((file, index) => {
                          const query = splitFileQueries[index];
                          const doc = query?.data;
                          return (
                            <div
                              key={file.path}
                              id={fileAnchor(file.path)}
                              className="h-full min-h-[24rem] border-b last:border-b-0"
                            >
                              {doc ? (
                                <MergeDiff
                                  doc={doc}
                                  editable={editable}
                                  onSave={(content) =>
                                    void daemon.request("file.save", {
                                      task_id: task.id,
                                      path: doc.path,
                                      content,
                                    })
                                  }
                                />
                              ) : query?.error ? (
                                <p className="p-3 text-sm text-destructive">
                                  Failed to load {file.path}: {query.error.message}
                                </p>
                              ) : (
                                <p className="p-3 text-sm text-muted-foreground">
                                  Loading {file.path}…
                                </p>
                              )}
                            </div>
                          );
                        })
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
                      onCommitted={() => {
                        void queryClient.invalidateQueries({ queryKey: ["diff", task.id] });
                        void queryClient.invalidateQueries({ queryKey: ["fileList", task.id] });
                      }}
                      onRefresh={() => {
                        void queryClient.invalidateQueries({ queryKey: ["diff", task.id] });
                        void queryClient.invalidateQueries({ queryKey: ["fileList", task.id] });
                      }}
                      onSelect={openDiffFile}
                    />
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">Loading changes…</p>
                  )
                ) : rightPanel === "subtasks" ? (
                  <SubtasksRail task={task} />
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
          <MessageSquare className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Toggle diff"
          title="Toggle diff"
          onClick={toggleDiff}
          className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", showDiff && "bg-secondary text-foreground")}
        >
          <Diff className="size-4" />
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
          <Folder className="size-4" />
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
          <GitCommitVertical className="size-4" />
        </button>
        {task.orchestrationGraph && task.orchestrationGraph.nodes.length > 0 && (
          <button
            type="button"
            aria-label="Subtasks"
            title="Subtasks"
            onClick={() => {
              setShowDiff(true);
              setRightPanel(rightPanel === "subtasks" ? null : "subtasks");
            }}
            className={cn("rounded-md p-1.5 hover:bg-secondary hover:text-foreground", rightPanel === "subtasks" && "bg-secondary text-foreground")}
          >
            <ListTodo className="size-4" />
          </button>
        )}
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

/** Format a FileDiff as a git-style unified diff message for sending to chat. */
function formatFileDiffAsMessage(file: FileDiff): string {
  const header = file.oldPath && file.oldPath !== file.path
    ? `diff --git a/${file.oldPath} b/${file.path}`
    : `diff --git a/${file.path} b/${file.path}`;
  const statusLine =
    file.status === "added"
      ? `new file mode 100644`
      : file.status === "deleted"
        ? `deleted file mode 100644`
        : file.status === "renamed"
          ? `rename from ${file.oldPath}\nrename to ${file.path}`
          : `index ---..+++ 100644`;

  const hunkHeaders = file.hunks.map(
    (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
  );
  const lines = file.hunks.flatMap((h) => h.lines);

  return `${header}\n${statusLine}\n${hunkHeaders.join("\n")}\n${lines.join("\n")}`;
}

function FileDiffView({
  id,
  file,
  localRes,
  onResolve,
  onSendToChat,
}: {
  id?: string;
  file: FileDiff;
  localRes: Record<string, HunkResolution>;
  onResolve: (file: string, hunkIndex: number, r: HunkResolution) => void;
  onSendToChat?: (file: FileDiff) => void;
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
        <span>{file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        {onSendToChat && (
          <span className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              title="Send this file's diff to chat"
              onClick={(e) => {
                e.stopPropagation();
                onSendToChat(file);
              }}
            >
              <Send className="size-3" />
              send
            </Button>
          </span>
        )}
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

/// Header git controls: an "Update" button (rebase-on-upstream + autostash) and
/// a branch chip that doubles as a switcher. Both operate on the task's project
/// repo via the daemon, which handles the stash/rollback; this just reflects the
/// result. Since a project's tasks share one working tree, switching here moves
/// the whole project's checkout.
function GitControls({
  taskId,
  branch,
}: {
  taskId: string;
  branch: string | null;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  // Branch list is only needed while the dropdown is open.
  const branchesQuery = useQuery({
    queryKey: ["branches", taskId],
    queryFn: daemonQuery<GitBranchList>("git.branches", { task_id: taskId }),
    enabled: open,
  });
  const branches = branchesQuery.data?.branches ?? [];

  // After a clean op the tree changed — refetch the task's reads. (The daemon's
  // task.updated event also refetches via the updatedAt-keyed queries; this just
  // makes it immediate.)
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["diff", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["fileList", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["branches", taskId] });
  };
  const onOk = (r: GitOpResult) => {
    switch (r.status) {
      case "up_to_date":
        toast.info(r.message);
        break;
      case "ok":
        toast.success(r.message);
        break;
      case "conflict":
        toast.error(r.message, {
          description: r.conflicts.length > 0 ? r.conflicts.join(", ") : undefined,
        });
        break;
      case "error":
        toast.error(r.message);
        break;
    }
  };
  const onErr = (e: Error) =>
    toast.error(e.message);

  const updateMut = useMutation({
    mutationFn: () => daemon.request("git.update", { task_id: taskId }) as Promise<GitOpResult>,
    onSuccess: (r) => {
      onOk(r);
      invalidate();
    },
    onError: (e: Error) => onErr(e),
  });
  const switchMut = useMutation({
    mutationFn: (target: string) =>
      daemon.request("git.switchBranch", { task_id: taskId, branch: target }) as Promise<GitOpResult>,
    onSuccess: (r) => {
      onOk(r);
      invalidate();
    },
    onError: (e: Error) => onErr(e),
  });

  const updating = updateMut.isPending;
  const switching = switchMut.isPending ? switchMut.variables : null;
  const busy = updating || switchMut.isPending;

  const switchTo = (target: string) => {
    setOpen(false);
    if (busy || target === branch) return;
    switchMut.mutate(target);
  };

  return (
    <span className="flex items-center gap-1">
      <div className="relative">
        <button
          type="button"
          disabled={!branch}
          onClick={() => setOpen((o) => !o)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          title="Switch branch"
          className="flex items-center gap-1 rounded px-1 py-0.5 font-mono hover:bg-secondary hover:text-foreground disabled:opacity-60"
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate">{branch ?? "no-branch"}</span>
          {switching ? (
            <Loader2 className="size-3 animate-spin opacity-60" />
          ) : (
            branch && <ChevronDown className="size-3 opacity-60" />
          )}
        </button>
        {open && branch && (
          <div className="absolute left-0 top-full z-30 mt-1 max-h-[50vh] min-w-[200px] overflow-y-auto rounded-md border bg-popover shadow-md">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Switch branch
            </div>
            {branchesQuery.isLoading && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">loading…</div>
            )}
            {!branchesQuery.isLoading && branches.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">no branches</div>
            )}
            {branches.map((b) => (
              <button
                type="button"
                key={b}
                onMouseDown={(e) => {
                  e.preventDefault();
                  switchTo(b);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs",
                  b === branch ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <Check
                  className={cn("size-3 shrink-0", b === branch ? "opacity-100" : "opacity-0")}
                />
                <span className="truncate">{b}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => !busy && updateMut.mutate()}
        disabled={busy || !branch}
        title="Update project — rebase on upstream, autostashing your changes (⌘T)"
        className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-secondary hover:text-foreground disabled:opacity-60"
      >
        {updating ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        <span>Update</span>
      </button>
    </span>
  );
}

function SubtasksRail({ task }: { task: TaskInfo }) {
  const nodes = task.orchestrationGraph?.nodes ?? [];
  const graph = task.orchestrationGraph;
  if (!graph) return <p className="p-3 text-sm text-muted-foreground">No orchestration data.</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ListTodo className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Subtasks</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {nodes.filter((n) => n.status === "complete").length}/{nodes.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-2">
          {nodes.map((node) => (
            <SubtaskRow key={node.id} node={node} />
          ))}
        </div>
      </ScrollArea>
      <div className="border-t px-3 py-2">
        <div className="text-xs text-muted-foreground">{graph.goal}</div>
      </div>
    </div>
  );
}

function SubtaskRow({ node }: { node: OrchNodeInfo }) {
  const badge = orchNodeBadge(node.status);
  return (
    <div className="flex items-center gap-2 rounded bg-secondary/30 px-2 py-1.5 text-xs">
      <Badge variant={badge.variant} className="w-16 text-center text-[10px]">
        {badge.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{node.kind}</div>
        <div className="text-muted-foreground">{node.agent}</div>
      </div>
      {node.taskId && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{node.taskId}</span>
      )}
    </div>
  );
}
