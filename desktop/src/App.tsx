import { useState, useSyncExternalStore } from "react";
import { daemon } from "./daemon";
import Board from "./views/Board";
import MissionControl from "./views/MissionControl";
import Projects from "./views/Projects";
import TaskDetail from "./views/TaskDetail";

type View = "control" | "board" | "projects";

const VIEWS: { id: View; label: string }[] = [
  { id: "control", label: "Mission Control" },
  { id: "board", label: "Board" },
  { id: "projects", label: "Projects" },
];

export default function App() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const [view, setView] = useState<View>("control");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const openTask = state.snapshot.tasks.find((t) => t.id === openTaskId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">⚒ warpforge</span>
        <nav>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={view === v.id && !openTask ? "active" : ""}
              onClick={() => {
                setView(v.id);
                setOpenTaskId(null);
              }}
            >
              {v.label}
            </button>
          ))}
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
        ) : view === "control" ? (
          <MissionControl state={state} onOpenTask={setOpenTaskId} />
        ) : view === "board" ? (
          <Board snapshot={state.snapshot} onOpenTask={setOpenTaskId} />
        ) : (
          <Projects snapshot={state.snapshot} />
        )}
      </main>
    </div>
  );
}
