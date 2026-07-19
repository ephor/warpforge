import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  FileText,
  Folder,
  GitBranch,
  GitCommitVertical,
  ListTodo,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  Send,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { withOccurrenceKeys } from "@/lib/renderKeys";
import { sessionActivity } from "@/lib/sessionActivity";
import { activityBadge, orchNodeBadge, taskBadge } from "@/lib/status";
import { buildTaskGroupIndex, isTaskGroupPinned, setTaskGroupPinned } from "@/lib/taskGroups";
import { cn } from "@/lib/utils";

import { ChangesRail } from "../components/ChangesRail";
import { ChatTranscript } from "../components/ChatTranscript";
import type { ComposerHandle } from "../components/Composer";
import { RuntimePanel } from "../components/RuntimePanel";
import { TaskAgentSwitcher } from "../components/TaskAgentSwitcher";
import { TaskDetailActions } from "../components/TaskDetailActions";
import { TaskMenu } from "../components/TaskMenu";
import type { DaemonState } from "../daemon";
import { daemon } from "../daemon";
import type {
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
import { daemonQuery } from "../query";
import { useUi } from "../store/ui";

interface Props {
  task: TaskInfo;
  updates: SessionUpdate[];
  state: DaemonState;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onOpenPush: () => void;
}

const EMPTY_PROJECT_FILES: ProjectFile[] = [];

const CodeEditor = lazy(async () => ({
  default: (await import("../components/CodeEditor")).CodeEditor,
}));
const MergeDiff = lazy(async () => ({
  default: (await import("../components/MergeDiff")).MergeDiff,
}));

function EditorLoading() {
  return (
    <div className="flex h-full items-center px-4 text-sm text-muted-foreground">
      Loading editor…
    </div>
  );
}

function EmptyChangesState({ onOpenFiles }: { onOpenFiles: () => void }) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="rounded-full border border-border/70 bg-secondary/40 p-3 text-muted-foreground">
        <GitCommitVertical className="size-5" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">No file changes yet</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Continue the conversation, or open a project file while the agent is working.
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onOpenFiles}>
        <FileText className="size-3.5" />
        Open files
      </Button>
    </div>
  );
}

type ActiveTab = { kind: "changes" } | { kind: "file"; path: string };

/**
 * Task detail: the conversation with the agent (stream + composer) on the
 * left, multi-file diff with per-hunk accept/reject on the right — Zed's
 * agent-panel review is the bar.
 */
export default function TaskDetail({
  task,
  updates,
  state,
  onClose,
  onOpenTask,
  onOpenPush,
}: Props) {
  const [localRes, setLocalRes] = useState<Record<string, HunkResolution>>({});
  const [activeTab, setActiveTab] = useState<ActiveTab>({ kind: "changes" });
  const [openFileTabs, setOpenFileTabs] = useState<string[]>([]);
  const [commitExpanded, setCommitExpanded] = useState(false);
  const diffView = useUi((s) => s.diffView);
  const setDiffView = useUi((s) => s.setDiffView);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const showChat = useUi((s) => s.showChat);
  const showDiff = useUi((s) => s.showDiff);
  const rightPanel = useUi((s) => s.rightPanel);
  const setShowDiff = useUi((s) => s.setShowDiff);
  const toggleChat = useUi((s) => s.toggleChat);
  const setRightPanel = useUi((s) => s.setRightPanel);
  const runtimeOpen = useUi((s) => s.runtimeOpen);
  const compactLayout = useMediaQuery("(max-width: 1199px)");
  const pinnedTaskIds = useUi((s) => s.pinnedTaskIds);
  const setPinnedTaskIds = useUi((s) => s.setPinnedTaskIds);
  const taskGroupIndex = useMemo(
    () => buildTaskGroupIndex(state.snapshot.tasks),
    [state.snapshot.tasks],
  );
  const enabledAgents = useMemo(
    () => (state.snapshot.agents ?? []).filter((agent) => agent.enabled),
    [state.snapshot.agents],
  );
  const taskGroup = taskGroupIndex.rootByTaskId.get(task.id);
  const taskGroupPinned = isTaskGroupPinned(taskGroupIndex, pinnedTaskIds, task.id);
  const toggleTaskGroupPin = useCallback(() => {
    setPinnedTaskIds(setTaskGroupPinned(taskGroupIndex, pinnedTaskIds, task.id, !taskGroupPinned));
  }, [pinnedTaskIds, setPinnedTaskIds, task.id, taskGroupIndex, taskGroupPinned]);
  const services = state.snapshot.services.filter((s) => s.project === task.project);
  const portforwards = state.snapshot.portforwards.filter((p) => p.project === task.project);
  const queryClient = useQueryClient();

  const openCommit = useCallback(() => {
    setShowDiff(true);
    setRightPanel("changes");
    setCommitExpanded(true);
  }, [setRightPanel, setShowDiff]);

  useEffect(() => {
    const openCommitFromShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "k") {
        return;
      }
      event.preventDefault();
      openCommit();
    };
    window.addEventListener("keydown", openCommitFromShortcut);
    return () => window.removeEventListener("keydown", openCommitFromShortcut);
  }, [openCommit]);

  const composerRef = useRef<ComposerHandle>(null);
  const diffScrollParent = useRef<HTMLDivElement>(null);
  const splitScrollParent = useRef<HTMLDivElement>(null);
  const badge = taskBadge(task.status);
  const editable = task.status !== "done";
  const activeFile = activeTab.kind === "file" ? activeTab.path : selectedFile;

  // ── On-demand daemon reads (TanStack Query) ──
  // Keyed on the task's server-side updatedAt, so a `task.updated` event (agent
  // Edit, git op, hunk resolve) changes the key and refetches on its own;
  // KeepPreviousData avoids re-mounting the diff/editor on every save, and the
  // Window-focus refetch (query default) catches edits made outside the app.
  const diffQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<TaskDiff>("diff.get", { task_id: task.id }),
    queryKey: ["diff", task.id, task.updatedAt],
    refetchOnWindowFocus: "always",
  });
  const diff = diffQuery.data ?? null;

  const fileListQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<ProjectFile[]>("file.list", { task_id: task.id }),
    queryKey: ["fileList", task.id, task.updatedAt],
  });
  const projectFiles = Array.isArray(fileListQuery.data) ? fileListQuery.data : EMPTY_PROJECT_FILES;
  const fileListError = fileListQuery.error?.message ?? null;

  const fileContentsEnabled = Boolean(activeFile) && activeTab.kind === "file";
  const fileDocQuery = useQuery({
    enabled: fileContentsEnabled,
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<FileDoc>("file.contents", {
      task_id: task.id,
      path: activeFile,
    }),
    queryKey: ["fileContents", task.id, activeFile, task.updatedAt],
    refetchOnWindowFocus: "always",
  });
  const fileDoc = fileContentsEnabled ? (fileDocQuery.data ?? null) : null;

  // Split review is still an all-changes view. Fetch every changed file here;
  // SelectedFile only tracks the rail highlight/scroll target and must not
  // Determine which diff blocks are mounted.
  // Only fetch file contents for files near the viewport to avoid 900+ simultaneous queries.
  const [splitRange, setSplitRange] = useState({ start: 0, end: 20 });
  const splitFileQueries = useQueries({
    queries:
      activeTab.kind === "changes" && diffView === "split"
        ? (diff?.files ?? []).map((file, i) => ({
            enabled: i >= splitRange.start && i <= splitRange.end,
            placeholderData: keepPreviousData,
            queryFn: daemonQuery<FileDoc>("file.contents", {
              task_id: task.id,
              path: file.path,
            }),
            queryKey: ["fileContents", task.id, file.path, task.updatedAt],
            refetchOnWindowFocus: "always" as const,
          }))
        : [],
  });

  // Keep large review surfaces virtualized. These live above the navigation
  // callbacks so the callbacks can safely depend on the current instances.
  const diffVirtualizer = useVirtualizer({
    count: diff?.files.length ?? 0,
    estimateSize: () => 200,
    getScrollElement: () => diffScrollParent.current,
    overscan: 5,
  });
  const splitFileCount = diff?.files.length ?? 0;
  const splitVirtualizer = useVirtualizer({
    count: splitFileCount,
    estimateSize: () => 384,
    getScrollElement: () => splitScrollParent.current,
    overscan: 3,
  });
  const splitVisItems = splitVirtualizer.getVirtualItems();
  if (splitVisItems.length > 0) {
    const newStart = splitVisItems[0].index;
    const newEnd = splitVisItems[splitVisItems.length - 1].index;
    if (splitRange.start !== newStart || splitRange.end !== newEnd) {
      setSplitRange({ start: newStart, end: newEnd });
    }
  }

  const setView = (v: "unified" | "split") => setDiffView(v);
  const openFileTab = useCallback(
    (path: string) => {
      setOpenFileTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setSelectedFile(path);
      setActiveTab({ kind: "file", path });
      setShowDiff(true);
      setRightPanel("files");
    },
    [setRightPanel, setShowDiff],
  );
  const openDiffFile = useCallback(
    (path: string) => {
      setSelectedFile(path);
      setActiveTab({ kind: "changes" });
      setShowDiff(true);
      setRightPanel("changes");
      requestAnimationFrame(() => {
        const idx = diff?.files.findIndex((f) => f.path === path);
        if (idx !== undefined && idx >= 0) {
          const viz = diffView === "unified" ? diffVirtualizer : splitVirtualizer;
          viz.scrollToIndex(idx, { align: "start" });
        }
        // After virtualizer scrolls, the DOM element should be mounted.
        requestAnimationFrame(() => {
          document.getElementById(fileAnchor(path))?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      });
    },
    [diff?.files, diffView, diffVirtualizer, setRightPanel, setShowDiff, splitVirtualizer],
  );
  const openChangesTab = useCallback(() => {
    setActiveTab({ kind: "changes" });
    setShowDiff(true);
    setRightPanel(diff && diff.files.length > 0 ? "changes" : null);
  }, [diff, setRightPanel, setShowDiff]);
  const closeFileTab = useCallback(
    (path: string) => {
      const index = openFileTabs.indexOf(path);
      const next = openFileTabs.filter((candidate) => candidate !== path);
      setOpenFileTabs(next);
      if (activeTab.kind !== "file" || activeTab.path !== path) return;

      const fallback = next[Math.min(index, next.length - 1)];
      setActiveTab(fallback ? { kind: "file", path: fallback } : { kind: "changes" });
      setSelectedFile(fallback ?? null);
      setRightPanel(fallback ? "files" : diff && diff.files.length > 0 ? "changes" : null);
    },
    [activeTab, diff, openFileTabs, setRightPanel],
  );

  // Default the split-view selection to the first changed file.
  useEffect(() => {
    if (!diff) {
      return;
    }
    const paths = diff.files.map((f) => f.path);
    setSelectedFile((current) => {
      if (current && paths.includes(current)) {
        return current;
      }
      return paths[0] ?? null;
    });
  }, [diff]);

  const activity = useMemo(() => sessionActivity(task, updates), [task, updates]);
  // While the agent is actively working a turn, the header chip reflects the
  // Live activity (thinking/working/writing) instead of the coarse status.
  const headerBadge = activity ? activityBadge(activity.tone, activity.label) : badge;

  // Slash-menu commands = the agent's most recent available_commands update.
  const commands = useMemo<CommandInfo[]>(() => {
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      if (u.kind === "available_commands") {
        return u.commands;
      }
    }
    return [];
  }, [updates]);
  const imageSupported = useMemo(() => {
    for (let i = updates.length - 1; i >= 0; i--) {
      const update = updates[i];
      if (update.kind === "prompt_capabilities") {
        return update.image;
      }
    }
    return false;
  }, [updates]);

  const resolveHunkMut = useMutation({
    mutationFn: (v: { file: string; hunkIndex: number; resolution: HunkResolution }) =>
      daemon.request("diff.resolveHunk", {
        file: v.file,
        hunk_index: v.hunkIndex,
        resolution: v.resolution,
        task_id: task.id,
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
    return openFileTabs.map((path) => ({ changed: changed.has(path), path }));
  }, [diff?.files, openFileTabs]);
  const projectRoot = useMemo(
    () => state.snapshot.projects.find((p) => p.name === task.project)?.path.replace(/\/+$/, ""),
    [state.snapshot.projects, task.project],
  );
  const knownFilePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const file of projectFiles) {
      paths.add(file.path);
    }
    for (const file of diff?.files ?? []) {
      paths.add(file.path);
    }
    for (const path of openFileTabs) {
      paths.add(path);
    }
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

      if (knownFilePaths.has(path)) {
        return path;
      }

      return null;
    },
    [knownFilePaths, projectRoot],
  );
  const rightRailOpen = showDiff && rightPanel !== null;
  const rightPanelContent =
    rightPanel === "changes" ? (
      diff ? (
        <ChangesRail
          project={task.project}
          files={diff.files}
          selected={selectedFile}
          taskId={task.id}
          commitExpanded={commitExpanded}
          onCommitExpandedChange={setCommitExpanded}
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
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex h-9 shrink-0 items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 px-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={task.prompt}>
          {task.prompt}
        </h1>
        <Badge variant={headerBadge.variant}>{headerBadge.label}</Badge>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="max-w-36 truncate">{task.project}</span>
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
        <TaskMenu
          task={task}
          pinned={taskGroupPinned}
          onTogglePin={toggleTaskGroupPin}
          onClose={onClose}
        />
      </div>

      <div className="relative flex min-h-0 flex-1 gap-2">
        <ResizablePanelGroup
          direction="horizontal"
          className={cn(
            "min-h-0 flex-1 gap-0",
            showChat && showDiff && "overflow-hidden rounded-md border border-border/80",
          )}
        >
          {/* ── Conversation ── */}
          {showChat && (
            <ResizablePanel id="chat" order={1} defaultSize={showDiff ? 42 : 100} minSize={28}>
              <Card
                className={cn(
                  "flex h-full min-h-0 w-full flex-col overflow-hidden border-transparent bg-transparent shadow-none",
                  !showDiff && "mx-auto max-w-[1100px]",
                )}
              >
                <div
                  className={cn(
                    "flex h-10 items-center gap-2 bg-card/95 px-4",
                    showDiff ? "border-b border-border/80" : "rounded-md border border-border/80",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">Conversation</div>
                    <div className="truncate text-xs text-muted-foreground">
                      Steer the agent or respond to requests
                    </div>
                  </div>
                  {taskGroup && (
                    <TaskAgentSwitcher
                      tree={taskGroup}
                      currentTaskId={task.id}
                      onOpenTask={onOpenTask}
                    />
                  )}
                  <FocusButton
                    focused={!showDiff}
                    label={showDiff ? "Focus conversation" : "Restore split view"}
                    onClick={() => setShowDiff(!showDiff)}
                  />
                </div>
                <ChatTranscript
                  active={showChat}
                  agents={enabledAgents}
                  activity={activity}
                  commands={commands}
                  files={projectFiles}
                  filesLoading={fileListQuery.isLoading}
                  imageSupported={imageSupported}
                  composerRef={composerRef}
                  onOpenFile={openFileTab}
                  onOpenTask={onOpenTask}
                  resolveFilePath={resolveSessionFilePath}
                  task={task}
                  updates={updates}
                />
              </Card>
            </ResizablePanel>
          )}

          {showChat && showDiff && <ResizableHandle />}

          {/* ── Center: Changes / Editor ── */}
          {showDiff && (
            <ResizablePanel id="center" order={2} defaultSize={showChat ? 58 : 100} minSize={30}>
              <Card
                className={cn(
                  "flex h-full min-h-0 flex-col overflow-hidden border-border/80 bg-card/95 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]",
                  showChat && "rounded-none border-0 shadow-none",
                )}
              >
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
                            <FileText
                              className={cn(
                                "size-3.5 shrink-0",
                                f.changed ? "text-sky-400" : "text-muted-foreground",
                              )}
                            />
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
                  <FocusButton
                    focused={!showChat}
                    label={showChat ? "Focus workspace" : "Restore split view"}
                    onClick={toggleChat}
                  />
                </div>

                <div className="flex h-9 items-center gap-2 border-b bg-background/25 px-3">
                  {diff && activeTab.kind === "changes" && (
                    <span className="tnum text-xs text-muted-foreground">
                      {diff.files.length} files
                    </span>
                  )}
                  {activeTab.kind === "file" && (
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                      {activeTab.path}
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
                  <ResizablePanel
                    id="workspace"
                    order={1}
                    defaultSize={runtimeOpen ? 78 : 100}
                    minSize={35}
                  >
                    {activeTab.kind === "changes" ? (
                      <div className="flex h-full min-h-0 min-w-0 flex-col">
                        {diffView === "unified" ? (
                          <div ref={diffScrollParent} className="min-h-0 flex-1 overflow-auto p-3">
                            {diffError && <p className="text-sm text-destructive">{diffError}</p>}
                            {!diff && !diffError && (
                              <p className="text-sm text-muted-foreground">Loading diff…</p>
                            )}
                            {diff && diff.files.length === 0 && (
                              <EmptyChangesState onOpenFiles={() => setRightPanel("files")} />
                            )}
                            {diff && diff.files.length > 0 && (
                              <div
                                className="relative w-full"
                                style={{ height: diffVirtualizer.getTotalSize() }}
                              >
                                {diffVirtualizer.getVirtualItems().map((vi) => {
                                  const file = diff.files[vi.index];
                                  return (
                                    <div
                                      key={vi.key}
                                      data-index={vi.index}
                                      ref={diffVirtualizer.measureElement}
                                      className="absolute left-0 top-0 w-full pb-3"
                                      style={{ transform: `translateY(${vi.start}px)` }}
                                    >
                                      <FileDiffView
                                        id={fileAnchor(file.path)}
                                        file={file}
                                        localRes={localRes}
                                        onResolve={resolveHunk}
                                        onSendToChat={(f) => {
                                          composerRef.current?.attachDiff(
                                            f,
                                            formatFileDiffAsMessage(f),
                                          );
                                        }}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div ref={splitScrollParent} className="min-h-0 flex-1 overflow-auto">
                            {!diff ? (
                              <p className="p-3 text-sm text-muted-foreground">Loading diff…</p>
                            ) : diff.files.length === 0 ? (
                              <EmptyChangesState onOpenFiles={() => setRightPanel("files")} />
                            ) : (
                              <div
                                className="relative w-full"
                                style={{ height: splitVirtualizer.getTotalSize() }}
                              >
                                {splitVirtualizer.getVirtualItems().map((vi) => {
                                  const file = diff.files[vi.index];
                                  const query = splitFileQueries[vi.index];
                                  const doc = query?.data;
                                  return (
                                    <div
                                      key={vi.key}
                                      id={fileAnchor(file.path)}
                                      className="absolute left-0 top-0 w-full border-b"
                                      style={{
                                        height: vi.size,
                                        transform: `translateY(${vi.start}px)`,
                                      }}
                                    >
                                      {doc ? (
                                        <Suspense fallback={<EditorLoading />}>
                                          <MergeDiff
                                            doc={doc}
                                            editable={editable}
                                            onSave={(content) =>
                                              void daemon.request("file.save", {
                                                content,
                                                path: doc.path,
                                                task_id: task.id,
                                              })
                                            }
                                          />
                                        </Suspense>
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
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : fileDoc ? (
                      <Suspense fallback={<EditorLoading />}>
                        <CodeEditor
                          doc={fileDoc}
                          editable={editable}
                          onSave={(content) =>
                            void daemon.request("file.save", {
                              content,
                              path: fileDoc.path,
                              task_id: task.id,
                            })
                          }
                        />
                      </Suspense>
                    ) : (
                      <p className="p-3 text-sm text-muted-foreground">Loading file…</p>
                    )}
                  </ResizablePanel>
                  {runtimeOpen && (
                    <>
                      <ResizableHandle withHandle />
                      <ResizablePanel
                        id="runtime"
                        order={2}
                        defaultSize={22}
                        minSize={12}
                        maxSize={55}
                      >
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

          {rightRailOpen && !compactLayout && (
            <>
              {(showChat || showDiff) && <ResizableHandle />}
              <ResizablePanel id="right-panel" order={3} defaultSize={26} minSize={16} maxSize={44}>
                <Card className="flex h-full min-h-0 flex-col overflow-hidden border-border/80 bg-card/95 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]">
                  {rightPanelContent}
                </Card>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {rightRailOpen && compactLayout && (
          <Card className="absolute inset-y-0 right-0 z-30 w-[min(340px,calc(100%-0.5rem))] overflow-hidden border-border/80 bg-card/95 shadow-2xl">
            {rightPanelContent}
          </Card>
        )}
      </div>
      <div className="flex h-4 shrink-0 items-center px-1 text-[10px] text-muted-foreground">
        <span
          className="flex min-w-0 items-center gap-1"
          title={task.worktree ?? "Runs in the local project workspace"}
        >
          <Folder className="size-3 shrink-0" />
          <span>{task.worktree ? "Git Worktree" : "Local Workspace"}</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <TaskDetailActions task={task} />
          <GitWorkspaceControls
            taskId={task.id}
            branch={diff?.branch ?? null}
            onOpenCommit={openCommit}
            onOpenPush={onOpenPush}
          />
        </span>
      </div>
    </div>
  );
}

function FocusButton({
  focused,
  label,
  onClick,
}: {
  focused: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  );
}

interface ProjectTreeNode {
  name: string;
  path?: string;
  changed?: boolean;
  children: Map<string, ProjectTreeNode>;
}

function buildProjectTree(files: ProjectFile[]): ProjectTreeNode {
  const root: ProjectTreeNode = { children: new Map(), name: "" };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), name: part };
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

/** Unique key for a folder node in the openFolders set. */
function projectFolderKey(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

interface ProjectFlatRow {
  key: string;
  node: ProjectTreeNode;
  depth: number;
  fKey?: string;
}

function flattenProjectTree(
  node: ProjectTreeNode,
  depth: number,
  parentPath: string,
  openFolders: Set<string>,
  out: ProjectFlatRow[],
): void {
  const kids = [...node.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
  for (const child of kids) {
    if (child.path) {
      out.push({ key: child.path, node: child, depth });
    } else {
      const fk = projectFolderKey(parentPath, child.name);
      out.push({ key: `f:${fk}`, node: child, depth, fKey: fk });
      if (openFolders.has(fk)) {
        flattenProjectTree(child, depth + 1, fk, openFolders, out);
      }
    }
  }
}

const PROJECT_ROW_HEIGHT = 28; // h-7

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
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: ProjectFlatRow[] = [];
    flattenProjectTree(root, 0, "", openFolders, out);
    return out;
  }, [root, openFolders]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => PROJECT_ROW_HEIGHT,
    getScrollElement: () => scrollRef.current,
    overscan: 20,
  });

  const toggleFolder = useCallback((fk: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fk)) {
        next.delete(fk);
      } else {
        next.add(fk);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 items-center border-b px-3 text-sm font-semibold">Files</div>
      {error && <p className="border-b px-3 py-2 text-xs text-destructive">{error}</p>}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1.5">
        {rows.length === 0 && !error ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No files found.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const pad = { paddingLeft: `${row.depth * 12 + 10}px` };

              if (row.node.path) {
                return (
                  <button
                    key={vi.key}
                    type="button"
                    style={{ ...pad, transform: `translateY(${vi.start}px)` }}
                    onClick={() => onSelect(row.node.path!)}
                    title={row.node.path}
                    className={cn(
                      "absolute left-0 top-0 flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs",
                      selected === row.node.path
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                    )}
                  >
                    <FileText
                      className={cn(
                        "size-3.5 shrink-0",
                        row.node.changed ? "text-sky-400" : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate">{row.node.name}</span>
                  </button>
                );
              }

              const isOpen = openFolders.has(row.fKey!);
              return (
                <button
                  key={vi.key}
                  type="button"
                  style={{ ...pad, transform: `translateY(${vi.start}px)` }}
                  onClick={() => toggleFolder(row.fKey!)}
                  className="absolute left-0 top-0 flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      !isOpen && "-rotate-90",
                    )}
                  />
                  <span className="truncate">{row.node.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Stable DOM id for a file's unified-diff block, for tree-click scroll-to. */
const fileAnchor = (path: string) => `diff-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;

/** Format a FileDiff as a git-style unified diff message for sending to chat. */
function formatFileDiffAsMessage(file: FileDiff): string {
  const header =
    file.oldPath && file.oldPath !== file.path
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
        <span>
          {file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
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
                {withOccurrenceKeys(hunk.lines, (line) => line).map(({ item: line, key }) => (
                  <div
                    key={`${hunk.oldStart}:${hunk.newStart}:${key}`}
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

/// Compact repository status and a searchable, viewport-bound branch/action menu.
function GitWorkspaceControls({
  taskId,
  branch,
  onOpenCommit,
  onOpenPush,
}: {
  taskId: string;
  branch: string | null;
  onOpenCommit: () => void;
  onOpenPush: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Branch list is only needed while the dropdown is open.
  const branchesQuery = useQuery({
    enabled: open,
    queryFn: daemonQuery<GitBranchList>("git.branches", { task_id: taskId }),
    queryKey: ["branches", taskId],
  });
  const branches = branchesQuery.data?.branches ?? [];
  const normalizedSearch = search.trim().toLowerCase();
  const filteredBranches = normalizedSearch
    ? branches.filter((item) => item.toLowerCase().includes(normalizedSearch))
    : branches;
  const showSync =
    !normalizedSearch || "sync with remote update project".includes(normalizedSearch);
  const showCommit = !normalizedSearch || "commit changes".includes(normalizedSearch);
  const showPush = !normalizedSearch || "push changes".includes(normalizedSearch);

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  // After a clean op the tree changed — refetch the task's reads. (The daemon's
  // Task.updated event also refetches via the updatedAt-keyed queries; this just
  // Makes it immediate.)
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
  const onErr = (e: Error) => toast.error(e.message);

  const updateMut = useMutation({
    mutationFn: () => daemon.request("git.update", { task_id: taskId }) as Promise<GitOpResult>,
    onError: (e: Error) => onErr(e),
    onSuccess: (r) => {
      onOk(r);
      invalidate();
    },
  });
  const switchMut = useMutation({
    mutationFn: (target: string) =>
      daemon.request("git.switchBranch", {
        task_id: taskId,
        branch: target,
      }) as Promise<GitOpResult>,
    onError: (e: Error) => onErr(e),
    onSuccess: (r) => {
      onOk(r);
      invalidate();
    },
  });

  const updating = updateMut.isPending;
  const switching = switchMut.isPending ? switchMut.variables : null;
  const busy = updating || switchMut.isPending;

  const switchTo = (target: string) => {
    setOpen(false);
    if (busy || target === branch) {
      return;
    }
    switchMut.mutate(target);
  };

  return (
    <span className="flex min-w-0 items-center">
      <div ref={menuRef} className="relative min-w-0">
        <button
          type="button"
          disabled={!branch}
          onClick={() => setOpen((o) => !o)}
          title="Branches and Git actions"
          className="flex items-center gap-1 rounded px-1 font-mono hover:bg-secondary hover:text-foreground disabled:opacity-60"
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="max-w-40 truncate">{branch ?? "no-branch"}</span>
          {switching ? (
            <Loader2 className="size-2.5 animate-spin opacity-60" />
          ) : (
            branch && <ChevronDown className="size-2.5 opacity-60" />
          )}
        </button>
        {open && branch && (
          <div className="absolute bottom-full right-0 z-50 mb-1 flex max-h-[min(520px,calc(100vh-4rem))] w-[min(420px,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-popover shadow-xl">
            <div className="shrink-0 border-b p-2">
              <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background/60 px-2 focus-within:ring-1 focus-within:ring-ring">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setOpen(false);
                  }}
                  placeholder="Search branches and actions"
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>
            <div className="min-h-0 overflow-y-auto p-1.5">
              {(showSync || showCommit || showPush) && (
                <div className="space-y-0.5 pb-1.5">
                  {showSync && (
                    <GitMenuAction
                      icon={
                        updating ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Download className="size-4" />
                        )
                      }
                      label="Sync with remote"
                      shortcut="⌘T"
                      disabled={busy || !branch}
                      onClick={() => updateMut.mutate()}
                    />
                  )}
                  {showCommit && (
                    <GitMenuAction
                      icon={<GitCommitVertical className="size-4" />}
                      label="Commit…"
                      shortcut="⌘K"
                      onClick={() => {
                        setOpen(false);
                        onOpenCommit();
                      }}
                    />
                  )}
                  {showPush && (
                    <GitMenuAction
                      icon={<Send className="size-4" />}
                      label="Push…"
                      shortcut="⇧⌘K"
                      onClick={() => {
                        setOpen(false);
                        onOpenPush();
                      }}
                    />
                  )}
                </div>
              )}

              {(showSync || showCommit || showPush) && filteredBranches.length > 0 && (
                <div className="mx-1 border-t" />
              )}
              <div className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Branches
              </div>
              {branchesQuery.isLoading && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
              )}
              {!branchesQuery.isLoading && filteredBranches.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {branches.length === 0 ? "No branches" : "No matching branches or actions"}
                </div>
              )}
              {filteredBranches.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => switchTo(item)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs",
                    item === branch ? "bg-accent text-foreground" : "hover:bg-accent/50",
                  )}
                >
                  <Check
                    className={cn(
                      "size-3.5 shrink-0",
                      item === branch ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </span>
  );
}

function GitMenuAction({
  disabled,
  icon,
  label,
  onClick,
  shortcut,
}: {
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  shortcut: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50 disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      <kbd className="font-sans text-[11px] text-muted-foreground">{shortcut}</kbd>
    </button>
  );
}

function SubtasksRail({ task }: { task: TaskInfo }) {
  const nodes = task.orchestrationGraph?.nodes ?? [];
  const graph = task.orchestrationGraph;
  if (!graph) {
    return <p className="p-3 text-sm text-muted-foreground">No orchestration data.</p>;
  }

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
