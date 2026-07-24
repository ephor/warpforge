import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, FileText, Folder, Loader2, X } from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { sessionActivity } from "@/lib/sessionActivity";
import { buildTaskGroupIndex, isTaskGroupPinned, setTaskGroupPinned } from "@/lib/taskGroups";
import { taskLabel } from "@/lib/taskLabel";
import { cn } from "@/lib/utils";

import { AgentBadge } from "../components/AgentBadge";
import { ChangesRail } from "../components/ChangesRail";
import { ChatTranscript } from "../components/ChatTranscript";
import type { ComposerHandle } from "../components/Composer";
import { RuntimePanel } from "../components/RuntimePanel";
import { StatusBadge } from "../components/StatusBadge";
import { TaskAgentSwitcher } from "../components/TaskAgentSwitcher";
import { TaskDetailActions } from "../components/TaskDetailActions";
import { TaskMenu } from "../components/TaskMenu";
import { daemon } from "../daemon";
import type {
  CommandInfo,
  EditHunk,
  FileDiff,
  HunkResolution,
  SessionUpdate,
  Snapshot,
  TaskInfo,
} from "../protocol";
import { useUi } from "../store/ui";
import { DiffWorkspace, type DiffWorkspaceHandle } from "./task-detail/DiffWorkspace";
import { formatFileDiffAsMessage } from "./task-detail/FileDiffView";
import { FocusButton } from "./task-detail/FocusButton";
import { GitWorkspaceControls } from "./task-detail/GitWorkspaceControls";
import { ProjectFilesPanel } from "./task-detail/ProjectFilesPanel";
import { SubtasksRail } from "./task-detail/SubtasksRail";
import { useTaskQueries, type ActiveTab } from "./task-detail/useTaskQueries";

interface Props {
  task: TaskInfo;
  snapshot: Snapshot;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onOpenPush: () => void;
}

const CodeEditor = lazy(async () => ({
  default: (await import("../components/CodeEditor")).CodeEditor,
}));

function EditorLoading() {
  return (
    <div className="flex h-full items-center px-4 text-sm text-muted-foreground">
      Loading editor…
    </div>
  );
}

const EMPTY_SESSION_UPDATES: SessionUpdate[] = [];
const EMPTY_TASK_COMMANDS: CommandInfo[] = [];

function useTaskSessionUpdates(taskId: string) {
  const getUpdates = useCallback(
    () => daemon.getState().sessionUpdates[taskId] ?? EMPTY_SESSION_UPDATES,
    [taskId],
  );
  return useSyncExternalStore(daemon.subscribe, getUpdates, getUpdates);
}

const TaskActivityStatus = memo(function TaskActivityStatus({ task }: { task: TaskInfo }) {
  const updates = useTaskSessionUpdates(task.id);
  const activity = useMemo(() => sessionActivity(task, updates), [task, updates]);
  return <StatusBadge status={task.status} activity={activity} />;
});

type TaskConversationProps = Omit<
  ComponentProps<typeof ChatTranscript>,
  "activity" | "commands" | "imageSupported" | "updates"
>;

const TaskConversation = memo(function TaskConversation(props: TaskConversationProps) {
  const updates = useTaskSessionUpdates(props.task.id);
  const activity = useMemo(() => sessionActivity(props.task, updates), [props.task, updates]);
  const commands = useMemo<CommandInfo[]>(() => {
    for (let index = updates.length - 1; index >= 0; index -= 1) {
      const update = updates[index];
      if (update.kind === "available_commands") {
        return update.commands;
      }
    }
    return EMPTY_TASK_COMMANDS;
  }, [updates]);
  const imageSupported = useMemo(() => {
    for (let index = updates.length - 1; index >= 0; index -= 1) {
      const update = updates[index];
      if (update.kind === "prompt_capabilities") {
        return update.image;
      }
    }
    return false;
  }, [updates]);

  return (
    <ChatTranscript
      key={props.task.id}
      {...props}
      activity={activity}
      commands={commands}
      imageSupported={imageSupported}
      updates={updates}
    />
  );
});

export default function TaskDetail({ task, snapshot, onClose, onOpenTask, onOpenPush }: Props) {
  const [localRes, setLocalRes] = useState<Record<string, HunkResolution>>({});
  const [diffNavigation, setDiffNavigation] = useState<{
    path: string;
    hunks: EditHunk[];
  } | null>(null);
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
  const repositoryOperation = useUi((s) =>
    s.repositoryOperation?.taskId === task.id ? s.repositoryOperation : null,
  );
  const taskGroupIndex = useMemo(() => buildTaskGroupIndex(snapshot.tasks), [snapshot.tasks]);
  const enabledAgents = useMemo(
    () => (snapshot.agents ?? []).filter((agent) => agent.enabled),
    [snapshot.agents],
  );
  const taskGroup = taskGroupIndex.rootByTaskId.get(task.id);
  const taskGroupPinned = isTaskGroupPinned(taskGroupIndex, pinnedTaskIds, task.id);
  const toggleTaskGroupPin = useCallback(() => {
    setPinnedTaskIds(setTaskGroupPinned(taskGroupIndex, pinnedTaskIds, task.id, !taskGroupPinned));
  }, [pinnedTaskIds, setPinnedTaskIds, task.id, taskGroupIndex, taskGroupPinned]);
  const services = snapshot.services.filter((s) => s.project === task.project);
  const portforwards = snapshot.portforwards.filter((p) => p.project === task.project);

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
  const diffWorkspaceRef = useRef<DiffWorkspaceHandle>(null);
  const handledDiffNavigationRef = useRef<typeof diffNavigation>(null);
  const editable = task.status !== "done";
  const activeFile = activeTab.kind === "file" ? activeTab.path : selectedFile;

  const {
    diff,
    diffQuery,
    projectFiles,
    fileListError,
    mentionFiles,
    mentionFilesQuery,
    fileDoc,
    queryClient,
  } = useTaskQueries(task.id, activeFile, activeTab, task.updatedAt);

  const setView = (v: "unified" | "split") => setDiffView(v);
  const openFileTab = useCallback(
    (path: string) => {
      setOpenFileTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setSelectedFile(path);
      setActiveTab({ kind: "file", path });
      setShowDiff(true);
    },
    [setShowDiff],
  );
  const openDiffFile = useCallback(
    (path: string, hunks: EditHunk[] = []) => {
      setSelectedFile(path);
      setActiveTab({ kind: "changes" });
      setShowDiff(true);
      setRightPanel("changes");
      if (hunks.length > 0) {
        setDiffView("unified");
      }
      setDiffNavigation({ hunks, path });
    },
    [setDiffView, setRightPanel, setShowDiff],
  );

  useEffect(() => {
    if (
      activeTab.kind !== "changes" ||
      !diffNavigation ||
      handledDiffNavigationRef.current === diffNavigation ||
      (diffNavigation.hunks.length > 0 && diffView !== "unified") ||
      !diff?.files.some((file) => file.path === diffNavigation.path)
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const workspace = diffWorkspaceRef.current;
      if (!workspace) {
        return;
      }
      workspace.scrollToFile(diffNavigation.path, diffNavigation.hunks);
      handledDiffNavigationRef.current = diffNavigation;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab.kind, diff, diffNavigation, diffView]);
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

  const resolveHunkMut = useMutation({
    mutationFn: (v: { file: string; hunkIndex: number; resolution: HunkResolution }) =>
      daemon.request("diff.resolveHunk", {
        file: v.file,
        hunk_index: v.hunkIndex,
        resolution: v.resolution,
        task_id: task.id,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["diff", task.id] }),
  });
  const resolveHunk = useCallback(
    (file: string, hunkIndex: number, resolution: HunkResolution) => {
      setLocalRes((prev) => ({ ...prev, [`${file}#${hunkIndex}`]: resolution }));
      resolveHunkMut.mutate({ file, hunkIndex, resolution });
    },
    [resolveHunkMut],
  );
  const openProjectFiles = useCallback(() => setRightPanel("files"), [setRightPanel]);
  const sendDiffToChat = useCallback((file: FileDiff) => {
    composerRef.current?.attachDiff(file, formatFileDiffAsMessage(file));
  }, []);
  const diffError = diffQuery.error?.message ?? resolveHunkMut.error?.message ?? null;

  const openTabs = useMemo(() => {
    const changed = new Set((diff?.files ?? []).map((f) => f.path));
    return openFileTabs.map((path) => ({ changed: changed.has(path), path }));
  }, [diff?.files, openFileTabs]);
  const projectRoot = useMemo(
    () => snapshot.projects.find((p) => p.name === task.project)?.path.replace(/\/+$/, ""),
    [snapshot.projects, task.project],
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
        <TaskActivityStatus task={task} />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={task.prompt}>
          {taskLabel(task)}
        </h1>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="max-w-36 truncate">{task.project}</span>
          <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
          <AgentBadge agentId={task.agent} className="max-w-32" />
        </span>
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
                  <div className="min-w-0 flex-1 truncate text-sm font-semibold">Conversation</div>
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
                <TaskConversation
                  active={showChat}
                  agents={enabledAgents}
                  files={mentionFiles}
                  filesLoading={mentionFilesQuery.isLoading}
                  composerRef={composerRef}
                  onOpenFile={openFileTab}
                  onOpenFileDiff={openDiffFile}
                  onOpenTask={onOpenTask}
                  resolveFilePath={resolveSessionFilePath}
                  task={task}
                />
              </Card>
            </ResizablePanel>
          )}

          {showChat && showDiff && <ResizableHandle />}

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

                {activeTab.kind === "changes" && (
                  <div className="flex h-9 items-center gap-2 border-b bg-background/25 px-3">
                    {diff && (
                      <span className="tnum text-xs text-muted-foreground">
                        {diff.files.length} files
                      </span>
                    )}
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
                  </div>
                )}

                <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
                  <ResizablePanel
                    id="workspace"
                    order={1}
                    defaultSize={runtimeOpen ? 78 : 100}
                    minSize={35}
                  >
                    {activeTab.kind === "changes" ? (
                      <div className="flex h-full min-h-0 min-w-0 flex-col">
                        <DiffWorkspace
                          ref={diffWorkspaceRef}
                          diff={diff}
                          diffError={diffError}
                          diffView={diffView}
                          editable={editable}
                          localRes={localRes}
                          onOpenFiles={openProjectFiles}
                          onResolve={resolveHunk}
                          onSendToChat={sendDiffToChat}
                          taskId={task.id}
                        />
                      </div>
                    ) : fileDoc ? (
                      <Suspense fallback={<EditorLoading />}>
                        <CodeEditor
                          key={`${fileDoc.path}:${editable}`}
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
        {repositoryOperation && (
          <span className="ml-auto mr-2 flex shrink-0 items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {repositoryOperation.kind === "pull" ? "Pulling from remote…" : "Pushing to remote…"}
          </span>
        )}
        <span className={cn("flex items-center gap-2", !repositoryOperation && "ml-auto")}>
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
