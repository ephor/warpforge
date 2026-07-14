import { useEffect, useState, useSyncExternalStore } from "react";
import {
  LayoutGrid,
  KanbanSquare,
  FolderTree,
  Plus,
  Circle,
  Bot,
  PanelLeft,
} from "lucide-react";
import { toast } from "sonner";
import { DetectedAgent, GitOpResult } from "./protocol";
import { daemon } from "./daemon";
import { useUi, type View } from "./store/ui";
import AttentionRail from "./components/AttentionRail";
import ErrorBoundary from "./components/ErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Board from "./views/Board";
import MissionControl from "./views/MissionControl";
import Projects from "./views/Projects";
import TaskDetail from "./views/TaskDetail";
import NewTaskDialog from "./views/NewTaskDialog";
import AgentSetupDialog from "./views/AgentSetupDialog";
import PushDialog from "./views/PushDialog";

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
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);
  const [newTaskPrompt, setNewTaskPrompt] = useState<string | undefined>(undefined);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [manualDetected, setManualDetected] = useState<DetectedAgent[] | null>(null);
  const [pushOpen, setPushOpen] = useState(false);

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

  // Cmd+T / Ctrl+T → update current task's branch from upstream.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "t") return;
      const id = useUi.getState().openTaskId;
      if (!id) return;
      e.preventDefault();
      const task = state.snapshot.tasks.find((t) => t.id === id);
      if (!task) return;
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
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "k") return;
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
      <div className="flex h-screen flex-col bg-background">
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
                <Board snapshot={state.snapshot} onOpenTask={setOpenTaskId} onNewTask={startNewTask} />
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
