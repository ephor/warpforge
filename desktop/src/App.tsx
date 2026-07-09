import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Anvil,
  LayoutGrid,
  KanbanSquare,
  FolderTree,
  Plus,
  Circle,
  Bot,
  PanelLeft,
  PanelRight,
} from "lucide-react";
import { DetectedAgent } from "./protocol";
import { daemon } from "./daemon";
import { useUi, type View } from "./store/ui";
import AttentionRail from "./components/AttentionRail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Board from "./views/Board";
import MissionControl from "./views/MissionControl";
import Projects from "./views/Projects";
import TaskDetail from "./views/TaskDetail";
import NewTaskDialog from "./views/NewTaskDialog";
import AgentSetupDialog from "./views/AgentSetupDialog";

const NAV: { id: View; label: string; icon: typeof LayoutGrid }[] = [
  { id: "control", label: "Mission Control", icon: LayoutGrid },
  { id: "board", label: "Board", icon: KanbanSquare },
  { id: "projects", label: "Projects", icon: FolderTree },
];

export default function App() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const openTaskId = useUi((s) => s.openTaskId);
  const setOpenTaskId = useUi((s) => s.openTask);
  const attentionOpen = useUi((s) => s.attentionOpen);
  const toggleAttention = useUi((s) => s.toggleAttention);
  const rightPanel = useUi((s) => s.rightPanel);
  const setRightPanel = useUi((s) => s.setRightPanel);
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);
  const [newTaskPrompt, setNewTaskPrompt] = useState<string | undefined>(undefined);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [manualDetected, setManualDetected] = useState<DetectedAgent[] | null>(null);

  const openTask = state.snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  const startNewTask = (project?: string, prompt?: string) => {
    setNewTaskProject(project ?? null);
    setNewTaskPrompt(prompt);
    setNewTaskOpen(true);
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    let allowClose = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (allowClose) return;
          event.preventDefault();

          const activeServices = daemon
            .getState()
            .snapshot.services.filter((service) =>
              service.status === "running" || service.status === "starting",
            );

          if (activeServices.length > 0) {
            const preview = activeServices
              .slice(0, 4)
              .map((service) => `${service.project}/${service.name}`)
              .join(", ");
            const suffix =
              activeServices.length > 4 ? `, and ${activeServices.length - 4} more` : "";
            const confirmed = window.confirm(
              `You have ${activeServices.length} service${
                activeServices.length === 1 ? "" : "s"
              } still running:\n${preview}${suffix}\n\nStop them and quit Warpforge?`,
            );
            if (!confirmed) return;
          }

          try {
            await daemon.stopRuntime();
          } catch {
            // The app is closing; if the daemon is already gone there is
            // nothing useful to surface here.
          }

          allowClose = true;
          await appWindow.close();
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background">
        <header className="flex h-11 items-center gap-3 border-b border-border/70 bg-card/80 px-2.5">
          <div className="flex items-center gap-2 px-1 text-sm font-semibold">
            <Anvil className="size-4 text-primary" />
            warpforge
          </div>

          <Button
            size="icon"
            variant="ghost"
            onClick={toggleAttention}
            aria-label="Toggle attention sidebar"
            title="Toggle attention sidebar"
            type="button"
            className={cn("size-7", attentionOpen && "bg-secondary text-foreground")}
          >
            <PanelLeft className="size-4" />
          </Button>

          <Button type="button" aria-label="New task" size="icon" variant="ghost" onClick={() => startNewTask()} className="size-7">
            <Plus className="size-4" />
          </Button>

          <nav className="flex items-center gap-1 border-l border-border/70 pl-3">
            {NAV.map((n) => {
              const active = view === n.id && !openTask;
              return (
                <button
                  key={n.id}
                  onClick={() => {
                    setView(n.id);
                    setOpenTaskId(null);
                  }}
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <n.icon className="size-4" />
                  {n.label}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                daemon.detectAgents()
                  .then((detected) => setManualDetected(Array.isArray(detected) ? detected : []))
                  .catch(() => setManualDetected([]));
              }}
              aria-label="Manage agents"
              title="Manage agents"
              type="button"
              className="size-7"
            >
              <Bot className="size-4" />
            </Button>
            <Button type="button" size="sm" onClick={() => startNewTask()}>
              <Plus className="size-4" />
              New task
            </Button>
            <Button
              type="button"
              aria-label="Right tool window"
              size="icon"
              variant="ghost"
              title="Right tool window"
              disabled={!openTask}
              onClick={() => setRightPanel(rightPanel ? null : "changes")}
              className={cn("size-7", rightPanel && openTask && "bg-secondary text-foreground")}
            >
              <PanelRight className="size-4" />
            </Button>
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                state.connection === "connected" ? "text-ok" : "text-warn",
              )}
            >
              <Circle
                className={cn(
                  "size-2 fill-current",
                  state.connection === "connected" ? "text-ok" : "text-warn",
                )}
              />
              {state.connection === "connected" ? "daemon" : state.connection}
            </span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3">
          {attentionOpen && <AttentionRail state={state} onOpenTask={setOpenTaskId} />}
          <main className="min-h-0 flex-1 overflow-hidden">
            {openTask ? (
              <TaskDetail
                key={openTask.id}
                task={openTask}
                updates={state.sessionUpdates[openTask.id] ?? []}
                state={state}
                onClose={() => setOpenTaskId(null)}
              />
            ) : view === "control" ? (
              <MissionControl state={state} onOpenTask={setOpenTaskId} onNewTask={startNewTask} />
            ) : view === "board" ? (
              <Board snapshot={state.snapshot} onOpenTask={setOpenTaskId} onNewTask={startNewTask} />
            ) : (
              <Projects
                snapshot={state.snapshot}
                onOpenTask={setOpenTaskId}
                onNewTask={startNewTask}
              />
            )}
          </main>
        </div>

        <NewTaskDialog
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          snapshot={state.snapshot}
          defaultProject={newTaskProject}
          initialPrompt={newTaskPrompt}
        />
        {(state.pendingAgentSetup ?? manualDetected) && (
          <AgentSetupDialog
            detected={(state.pendingAgentSetup ?? manualDetected)!}
            onClose={() => {
              daemon.dismissAgentSetup();
              setManualDetected(null);
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
