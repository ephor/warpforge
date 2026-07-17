import { Bot, Circle, FolderTree, KanbanSquare, LayoutGrid, PanelLeft, Plus } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import AttentionRail from "./components/AttentionRail";
import ErrorBoundary from "./components/ErrorBoundary";
import UpdateControl from "./components/UpdateControl";
import { daemon } from "./daemon";
import type { DetectedAgent, GitOpResult } from "./protocol";
import { useUi } from "./store/ui";
import type { View } from "./store/ui";
import AgentSetupDialog from "./views/AgentSetupDialog";
import Board from "./views/Board";
import MissionControl from "./views/MissionControl";
import NewTaskDialog from "./views/NewTaskDialog";
import Projects from "./views/Projects";
import PushDialog from "./views/PushDialog";
import TaskDetail from "./views/TaskDetail";

const NAV: { id: View; label: string; icon: typeof LayoutGrid }[] = [
  { icon: LayoutGrid, id: "control", label: "Mission Control" },
  { icon: KanbanSquare, id: "board", label: "Board" },
  { icon: FolderTree, id: "projects", label: "Projects" },
];

export default function App() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const openTaskId = useUi((s) => s.openTaskId);
  const setOpenTaskId = useUi((s) => s.openTask);
  const attentionOpen = useUi((s) => s.attentionOpen);
  const toggleAttention = useUi((s) => s.toggleAttention);
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);
  const [newTaskPrompt, setNewTaskPrompt] = useState<string | undefined>(undefined);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [manualDetected, setManualDetected] = useState<DetectedAgent[] | null>(null);
  const [pushOpen, setPushOpen] = useState(false);

  const handleOpenTask = useCallback((id: string) => setOpenTaskId(id), [setOpenTaskId]);

  const openTask = state.snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  const startNewTask = (project?: string, prompt?: string) => {
    setNewTaskProject(project ?? null);
    setNewTaskPrompt(prompt);
    setNewTaskOpen(true);
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let disposed = false;
    let allowClose = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) {
          return;
        }
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (allowClose) {
            return;
          }
          event.preventDefault();

          const activeServices = daemon
            .getState()
            .snapshot.services.filter(
              (service) => service.status === "running" || service.status === "starting",
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
            if (!confirmed) {
              return;
            }
          }

          try {
            await daemon.stopRuntime();
          } catch {
            // The app is closing; if the daemon is already gone there is
            // Nothing useful to surface here.
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

  // Cmd+T / Ctrl+T → update current task's branch from upstream.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "t") {
        return;
      }
      const id = useUi.getState().openTaskId;
      if (!id) {
        return;
      }
      e.preventDefault();
      const task = state.snapshot.tasks.find((t) => t.id === id);
      if (!task) {
        return;
      }
      daemon
        .request("git.update", { task_id: id })
        .then((r) => {
          const res = r as GitOpResult;
          switch (res.status) {
            case "up_to_date":
              toast.info(res.message);
              break;
            case "ok":
              toast.success(res.message);
              break;
            case "conflict":
              toast.error(res.message, {
                description: res.conflicts.length > 0 ? res.conflicts.join(", ") : undefined,
              });
              break;
            case "error":
              toast.error(res.message);
              break;
          }
        })
        .catch((e: Error) => toast.error(e.message));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.snapshot.tasks]);

  // Cmd+Shift+K / Ctrl+Shift+K → review outgoing commits and push.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "k") {
        return;
      }
      e.preventDefault();
      const id = useUi.getState().openTaskId;
      if (!id || !state.snapshot.tasks.some((task) => task.id === id)) {
        toast.info("Open a task before pushing its branch");
        return;
      }
      setPushOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.snapshot.tasks]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex h-screen flex-col bg-background">
        <header className="flex h-11 items-center gap-3 border-b border-border/70 bg-card/80 px-2.5">
          <div className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-foreground">
            WARP<span className="text-primary">FORGE</span>
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

          <Button
            type="button"
            aria-label="New task"
            size="icon"
            variant="ghost"
            onClick={() => startNewTask()}
            className="size-7"
          >
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
            <UpdateControl daemonConnected={state.connection === "connected"} />
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                daemon
                  .detectAgents()
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
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5",
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
              {state.connectionError && state.connection !== "connected" && (
                <span
                  className="max-w-80 truncate text-warn"
                  role="status"
                  title={state.connectionError}
                >
                  {state.connectionError}
                </span>
              )}
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3">
          <main className="min-h-0 flex-1 overflow-hidden">
            <ErrorBoundary>
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
                <Board
                  snapshot={state.snapshot}
                  onOpenTask={setOpenTaskId}
                  onNewTask={startNewTask}
                />
              ) : (
                <Projects
                  snapshot={state.snapshot}
                  onOpenTask={setOpenTaskId}
                  onNewTask={startNewTask}
                />
              )}
            </ErrorBoundary>
          </main>
        </div>

        <div
          className={cn(
            "absolute bottom-0 left-0 top-11 z-20 w-[340px] p-3 pb-0 transition-transform duration-300 ease-in-out",
            attentionOpen ? "translate-x-0" : "-translate-x-full pointer-events-none",
          )}
        >
          <AttentionRail state={state} onOpenTask={handleOpenTask} />
        </div>

        <NewTaskDialog
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          snapshot={state.snapshot}
          defaultProject={newTaskProject}
          initialPrompt={newTaskPrompt}
        />
        <PushDialog open={pushOpen} onOpenChange={setPushOpen} task={openTask} />
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
