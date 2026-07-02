import { useState, useSyncExternalStore } from "react";
import { daemon } from "./daemon";
import Board from "./views/Board";
import Projects from "./views/Projects";
import TaskDetail from "./views/TaskDetail";

type View = "board" | "projects";

export default function App() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const [view, setView] = useState<View>("board");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const openTask = state.snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">⚒ warpforge</span>
        <nav>
          <button
            className={view === "board" ? "active" : ""}
            onClick={() => {
              setView("board");
              setOpenTaskId(null);
            }}
          >
            Board
          </button>
          <button
            className={view === "projects" ? "active" : ""}
            onClick={() => {
              setView("projects");
              setOpenTaskId(null);
            }}
          >
            Projects
          </button>
        </nav>
        <span className={`conn conn-${state.connection}`}>
          {state.connection === "connected" ? "● daemon" : `○ ${state.connection}`}
        </span>
      </header>

      <main>
        {openTask ? (
          <TaskDetail
            task={openTask}
            updates={state.sessionUpdates[openTask.id] ?? []}
            onClose={() => setOpenTaskId(null)}
          />
        ) : view === "board" ? (
          <Board snapshot={state.snapshot} onOpenTask={setOpenTaskId} />
        ) : (
          <Projects snapshot={state.snapshot} />
        )}
      </main>
    </div>
  );
}
