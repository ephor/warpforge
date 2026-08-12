import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import AppHeader from "@/components/AppHeader";
import AttentionToast from "@/components/AttentionToast";
import BootstrapWizard from "@/components/BootstrapWizard";
import ErrorBoundary from "@/components/ErrorBoundary";
import { QuickOpen } from "@/components/QuickOpen";
import Sidebar from "@/components/Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { daemon } from "@/daemon";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useUi } from "@/store/ui";
import { SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from "@/store/ui";

import { useDaemonEvents } from "./hooks/useDaemonEvents";
import { useFontScaling } from "./hooks/useFontScaling";
import { useTheme } from "./hooks/useTheme";
import { usePullShortcut } from "./hooks/usePullShortcut";
import { usePushShortcut } from "./hooks/usePushShortcut";
import { useQuickOpenShortcut } from "./hooks/useQuickOpenShortcut";
import { useTauriClose } from "./hooks/useTauriClose";
import { queryClient, useProjectFileListQuery } from "./query";
import AddProjectDialog from "./views/AddProjectDialog";
import AgentSetupDialog from "./views/AgentSetupDialog";
import MissionControl from "./views/MissionControl";
import NewTaskDialog from "./views/NewTaskDialog";
import Projects from "./views/Projects";
import PushDialog from "./views/PushDialog";
import SettingsView from "./views/Settings";
import TaskDetail from "./views/TaskDetail";

function LiveMissionControl({
  onOpenTask,
  onNewTask,
}: {
  onOpenTask: (id: string) => void;
  onNewTask: (project?: string, prompt?: string) => void;
}) {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  return <MissionControl state={state} onOpenTask={onOpenTask} onNewTask={onNewTask} />;
}

function LiveSidebar(props: Omit<React.ComponentProps<typeof Sidebar>, "state">) {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  return <Sidebar state={state} {...props} />;
}

/** Hosts the quick-open palette: owns the file-list query and the double-Shift
 *  trigger. Rendered as a child of the QueryClientProvider so its hook sees the
 *  client (App's own hooks must not query — they'd render before the provider). */
function QuickOpenHost({
  openTaskId,
  hasOpenTask,
}: {
  openTaskId: string | null;
  hasOpenTask: boolean;
}) {
  const [open, setOpen] = useState(false);
  const filesQuery = useProjectFileListQuery(hasOpenTask ? openTaskId : null);
  const openTaskThroughNav = useUi((s) => s.openTaskWithNav);
  useQuickOpenShortcut(() => {
    if (hasOpenTask) setOpen(true);
  });
  return (
    <QuickOpen
      open={open}
      files={filesQuery.data ?? []}
      loading={filesQuery.isLoading}
      error={filesQuery.error?.message ?? null}
      onPick={(path) => {
        if (openTaskId) openTaskThroughNav(openTaskId, { surface: "files", path });
      }}
      onClose={() => setOpen(false)}
    />
  );
}

const getSnapshot = () => daemon.getState().snapshot;
const getConnection = () => daemon.getState().connection;
const getConnectionError = () => daemon.getState().connectionError;
const getPendingAgentSetup = () => daemon.getState().pendingAgentSetup;

const SIDEBAR_RESIZE_STEP = 10;
/** Icon-rail width when the sidebar is collapsed. */
const SIDEBAR_COLLAPSED_WIDTH = 64;

function SidebarResizeHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (w: number) => void;
}) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const handleMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startXRef.current;
        onWidthChange(startWidthRef.current + delta);
      };
      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [width, onWidthChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next: number;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          next = width - SIDEBAR_RESIZE_STEP;
          break;
        case "ArrowRight":
          e.preventDefault();
          next = width + SIDEBAR_RESIZE_STEP;
          break;
        case "Home":
          e.preventDefault();
          next = SIDEBAR_WIDTH_MIN;
          break;
        case "End":
          e.preventDefault();
          next = SIDEBAR_WIDTH_MAX;
          break;
        default:
          return;
      }
      onWidthChange(next);
    },
    [width, onWidthChange],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      aria-label="Resize sidebar"
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      data-testid="sidebar-resize-handle"
      className="group flex w-1 shrink-0 cursor-col-resize items-center justify-center hover:bg-primary/15 focus-visible:bg-primary/15 focus-visible:outline-none"
    >
      <div className="h-full w-px bg-border/70 transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary/60" />
    </div>
  );
}

export default function App() {
  const snapshot = useSyncExternalStore(daemon.subscribe, getSnapshot);
  const connection = useSyncExternalStore(daemon.subscribe, getConnection);
  const connectionError = useSyncExternalStore(daemon.subscribe, getConnectionError);
  const pendingAgentSetup = useSyncExternalStore(daemon.subscribe, getPendingAgentSetup);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const openProject = useUi((s) => s.openProject);
  const openTaskId = useUi((s) => s.openTaskId);
  const setOpenTaskId = useUi((s) => s.openTask);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const setSidebarWidth = useUi((s) => s.setSidebarWidth);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUi((s) => s.toggleSidebarCollapsed);
  const isWide = useMediaQuery("(min-width: 1024px)");
  const showPersistent = isWide;
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);
  const [newTaskPrompt, setNewTaskPrompt] = useState<string | undefined>(undefined);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [wizardProject, setWizardProject] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useFontScaling();
  useTheme();
  useDaemonEvents();
  useTauriClose();

  const handleOpenTask = (id: string) => {
    setNewTaskOpen(false);
    setOpenTaskId(id);
  };

  const handleSelectView = (nextView: typeof view) => {
    setNewTaskOpen(false);
    setView(nextView);
  };

  const handleOpenProject = (name: string) => {
    setNewTaskOpen(false);
    openProject(name);
  };

  const openTask = snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  const startNewTask = useCallback((project?: string, prompt?: string) => {
    setNewTaskProject(project ?? null);
    setNewTaskPrompt(prompt);
    setNewTaskOpen(true);
  }, []);

  const handleProjectAdded = useCallback(
    (name: string) => {
      openProject(name);
      toast("Project added", {
        description: `Run the setup wizard for ${name}`,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Open wizard",
          onClick: () => setWizardProject(name),
        },
      });
    },
    [openProject],
  );

  // The sidebar advertises ⌘N next to New task, so the shortcut lives here
  // rather than inside the sidebar, which is unmounted while it is closed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      startNewTask();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startNewTask]);

  usePullShortcut(snapshot.tasks);
  usePushShortcut(snapshot.tasks, setPushOpen);

  const sidebarProps = {
    collapsed: sidebarCollapsed,
    connection,
    connectionError,
    onNewTask: () => startNewTask(),
    onOpenSettings: () => setSettingsOpen(true),
    onOpenTask: handleOpenTask,
    onSelectView: handleSelectView,
    onOpenProject: handleOpenProject,
    onToggleCollapsed: toggleSidebarCollapsed,
    openTaskId,
    view,
  };
  const persistentWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;

  return (
    <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={300}>
      {/* Prototype shell: full-height sidebar beside a column of topbar + content. */}
      <div className="relative flex h-screen bg-background">
        {showPersistent && (
          <>
            <aside
              style={{
                width: persistentWidth,
                minWidth: persistentWidth,
                maxWidth: persistentWidth,
              }}
              className="flex shrink-0 flex-col overflow-hidden"
              data-testid="persistent-sidebar"
            >
              <LiveSidebar {...sidebarProps} />
            </aside>
            {!sidebarCollapsed && (
              <SidebarResizeHandle width={sidebarWidth} onWidthChange={setSidebarWidth} />
            )}
          </>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!newTaskOpen && (
            <AppHeader
              view={view}
              openTask={openTask}
              onAddProject={() => setAddProjectOpen(true)}
              onCloseTask={() => setOpenTaskId(null)}
            />
          )}
          <main
            className={
              newTaskOpen ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-hidden p-2"
            }
          >
            <ErrorBoundary>
              {newTaskOpen ? (
                <NewTaskDialog
                  open
                  onOpenChange={setNewTaskOpen}
                  snapshot={snapshot}
                  defaultProject={newTaskProject}
                  initialPrompt={newTaskPrompt}
                />
              ) : openTask ? (
                <TaskDetail
                  key={openTask.id}
                  task={openTask}
                  snapshot={snapshot}
                  onOpenTask={setOpenTaskId}
                  onOpenPush={() => setPushOpen(true)}
                />
              ) : view === "control" ? (
                <LiveMissionControl onOpenTask={setOpenTaskId} onNewTask={startNewTask} />
              ) : (
                <Projects
                  snapshot={snapshot}
                  onOpenTask={setOpenTaskId}
                  onNewTask={startNewTask}
                  onAddProject={() => setAddProjectOpen(true)}
                />
              )}
            </ErrorBoundary>
          </main>
        </div>

        {pushOpen && <PushDialog open onOpenChange={setPushOpen} task={openTask} />}
        <QuickOpenHost
          openTaskId={openTask ? openTask.id : null}
          hasOpenTask={!!openTask && !newTaskOpen}
        />
        {addProjectOpen && (
          <AddProjectDialog open onOpenChange={setAddProjectOpen} onAdded={handleProjectAdded} />
        )}
        <SettingsView open={settingsOpen} onOpenChange={setSettingsOpen} />
        {pendingAgentSetup && (
          <AgentSetupDialog
            detected={pendingAgentSetup}
            onClose={() => {
              daemon.dismissAgentSetup();
            }}
          />
        )}
        {wizardProject && (
          <BootstrapWizard
            project={wizardProject}
            agents={snapshot.agents ?? []}
            open={!!wizardProject}
            onOpenChange={(v) => {
              if (!v) setWizardProject(null);
            }}
            onStarted={(taskId) => {
              const projectName = wizardProject;
              setWizardProject(null);
              const toastId = `bootstrap:${taskId}`;
              toast.custom(
                (sonnerId) => (
                  <AttentionToast
                    title="Config generation started"
                    identity={projectName ?? "project"}
                    summary="Agent is writing .warpforge.yaml in background"
                    onDismiss={() => toast.dismiss(sonnerId)}
                    onOpen={() => {
                      useUi.getState().openTask(taskId);
                      toast.dismiss(sonnerId);
                    }}
                  />
                ),
                {
                  action: null,
                  cancel: null,
                  description: null,
                  duration: 10_000,
                  icon: null,
                  id: toastId,
                  richColors: false,
                  unstyled: true,
                },
              );
            }}
          />
        )}
      </div>
    </TooltipProvider>
    </QueryClientProvider>
  );
}
