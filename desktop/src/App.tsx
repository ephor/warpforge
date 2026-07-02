import { useState, useSyncExternalStore } from "react";
import { Anvil, LayoutGrid, KanbanSquare, FolderTree, Plus, Circle } from "lucide-react";
import { daemon } from "./daemon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Board from "./views/Board";
import MissionControl from "./views/MissionControl";
import Projects from "./views/Projects";
import TaskDetail from "./views/TaskDetail";
import NewTaskDialog from "./views/NewTaskDialog";

type View = "control" | "board" | "projects";

const NAV: { id: View; label: string; icon: typeof LayoutGrid }[] = [
  { id: "control", label: "Mission Control", icon: LayoutGrid },
  { id: "board", label: "Board", icon: KanbanSquare },
  { id: "projects", label: "Projects", icon: FolderTree },
];

export default function App() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const [view, setView] = useState<View>("control");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const openTask = state.snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  const startNewTask = (project?: string) => {
    setNewTaskProject(project ?? null);
    setNewTaskOpen(true);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col">
        <header className="flex items-center gap-4 border-b bg-card px-4 py-2">
          <div className="flex items-center gap-2 font-semibold">
            <Anvil className="size-4 text-primary" />
            warpforge
          </div>

          <nav className="flex items-center gap-1">
            {NAV.map((n) => {
              const active = view === n.id && !openTask;
              return (
                <button
                  key={n.id}
                  onClick={() => {
                    setView(n.id);
                    setOpenTaskId(null);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
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
            <Button size="sm" onClick={() => startNewTask()}>
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

        <main className="min-h-0 flex-1 overflow-hidden p-4">
          {openTask ? (
            <TaskDetail
              task={openTask}
              updates={state.sessionUpdates[openTask.id] ?? []}
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

        <NewTaskDialog
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          snapshot={state.snapshot}
          defaultProject={newTaskProject}
        />
      </div>
    </TooltipProvider>
  );
}
