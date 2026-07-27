import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import AppHeader from "@/components/AppHeader";
import AttentionRail from "@/components/AttentionRail";
import AttentionToast from "@/components/AttentionToast";
import BootstrapWizard from "@/components/BootstrapWizard";
import ErrorBoundary from "@/components/ErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { daemon } from "@/daemon";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useUi } from "@/store/ui";
import { SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from "@/store/ui";

import { useDaemonEvents } from "./hooks/useDaemonEvents";
import { useFontScaling } from "./hooks/useFontScaling";
import { usePullShortcut } from "./hooks/usePullShortcut";
import { usePushShortcut } from "./hooks/usePushShortcut";
import { useTauriClose } from "./hooks/useTauriClose";
import { cn } from "./lib/utils";
import AgentSetupDialog from "./views/AgentSetupDialog";
import Board from "./views/Board";
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

function LiveAttentionRail({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  return <AttentionRail state={state} onOpenTask={onOpenTask} />;
}

const getSnapshot = () => daemon.getState().snapshot;
const getConnection = () => daemon.getState().connection;
const getConnectionError = () => daemon.getState().connectionError;
const getPendingAgentSetup = () => daemon.getState().pendingAgentSetup;

const SIDEBAR_RESIZE_STEP = 10;

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
  const openTaskId = useUi((s) => s.openTaskId);
  const setOpenTaskId = useUi((s) => s.openTask);
  const attentionOpen = useUi((s) => s.attentionOpen);
  const toggleAttention = useUi((s) => s.toggleAttention);
  const setAttentionOpen = useUi((s) => s.setAttentionOpen);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const setSidebarWidth = useUi((s) => s.setSidebarWidth);
  const isWide = useMediaQuery("(min-width: 1024px)");
  const showPersistent = isWide && attentionOpen;
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);
  const [newTaskPrompt, setNewTaskPrompt] = useState<string | undefined>(undefined);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [railMounted, setRailMounted] = useState(attentionOpen);
  const [wizardProject, setWizardProject] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useFontScaling();
  useDaemonEvents();
  useTauriClose();

  const handleOpenTask = useCallback(
    (id: string) => {
      setOpenTaskId(id);
      if (!isWide) setAttentionOpen(false);
    },
    [isWide, setAttentionOpen, setOpenTaskId],
  );

  const openTask = snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  useEffect(() => {
    if (attentionOpen) {
      setRailMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setRailMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [attentionOpen]);

  const startNewTask = (project?: string, prompt?: string) => {
    setNewTaskProject(project ?? null);
    setNewTaskPrompt(prompt);
    setNewTaskOpen(true);
  };

  usePullShortcut(snapshot.tasks);
  usePushShortcut(snapshot.tasks, setPushOpen);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex h-screen flex-col bg-background">
        <AppHeader
          view={view}
          setView={setView}
          openTask={openTask}
          setOpenTaskId={setOpenTaskId}
          attentionOpen={attentionOpen}
          toggleAttention={toggleAttention}
          connection={connection}
          connectionError={connectionError}
          onNewTask={() => startNewTask()}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden p-2">
          {showPersistent && railMounted && (
            <>
              <aside
                style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
                className="flex shrink-0 flex-col overflow-hidden"
                data-testid="persistent-sidebar"
              >
                <LiveAttentionRail onOpenTask={handleOpenTask} />
              </aside>
              <SidebarResizeHandle width={sidebarWidth} onWidthChange={setSidebarWidth} />
            </>
          )}
          <main className="min-h-0 flex-1 overflow-hidden">
            <ErrorBoundary>
              {openTask ? (
                <TaskDetail
                  key={openTask.id}
                  task={openTask}
                  snapshot={snapshot}
                  onClose={() => setOpenTaskId(null)}
                  onOpenTask={setOpenTaskId}
                  onOpenPush={() => setPushOpen(true)}
                />
              ) : view === "control" ? (
                <LiveMissionControl onOpenTask={setOpenTaskId} onNewTask={startNewTask} />
              ) : view === "board" ? (
                <Board snapshot={snapshot} onOpenTask={setOpenTaskId} onNewTask={startNewTask} />
              ) : (
                <Projects
                  snapshot={snapshot}
                  onOpenTask={setOpenTaskId}
                  onNewTask={startNewTask}
                  onProjectAdded={(name) => {
                    toast("Project added", {
                      description: `Run the setup wizard for ${name}`,
                      duration: Number.POSITIVE_INFINITY,
                      action: {
                        label: "Open wizard",
                        onClick: () => setWizardProject(name),
                      },
                    });
                  }}
                />
              )}
            </ErrorBoundary>
          </main>
        </div>

        {!isWide && (
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 top-11 z-20",
              attentionOpen ? "pointer-events-auto" : "pointer-events-none",
            )}
          >
            <button
              type="button"
              aria-label="Close sessions rail"
              className="absolute inset-0 cursor-default"
              disabled={!attentionOpen}
              onClick={toggleAttention}
            />
            <div
              aria-hidden={!attentionOpen}
              inert={!attentionOpen}
              className={cn(
                "absolute bottom-0 left-0 top-0 w-[340px] transition-transform duration-300 ease-in-out",
                attentionOpen ? "translate-x-0" : "-translate-x-full",
              )}
            >
              {railMounted && <LiveAttentionRail onOpenTask={handleOpenTask} />}
            </div>
          </div>
        )}

        {pushOpen && <PushDialog open onOpenChange={setPushOpen} task={openTask} />}
        {newTaskOpen && (
          <NewTaskDialog
            open
            onOpenChange={setNewTaskOpen}
            snapshot={snapshot}
            defaultProject={newTaskProject}
            initialPrompt={newTaskPrompt}
          />
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
                      useUi.getState().focusAttentionTask(taskId);
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
  );
}
