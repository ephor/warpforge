import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import AppHeader from "@/components/AppHeader";
import AttentionRail from "@/components/AttentionRail";
import AttentionToast from "@/components/AttentionToast";
import BootstrapWizard from "@/components/BootstrapWizard";
import ErrorBoundary from "@/components/ErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { daemon } from "@/daemon";
import { useUi } from "@/store/ui";

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
      setAttentionOpen(false);
    },
    [setAttentionOpen, setOpenTaskId],
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

        <div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
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
