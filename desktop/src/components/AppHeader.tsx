import { Circle, FolderTree, KanbanSquare, LayoutGrid, PanelLeft, Plus, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import UpdateControl from "@/components/UpdateControl";
import type { ConnectionState } from "@/daemon";
import { cn } from "@/lib/utils";
import type { TaskInfo } from "@/protocol";
import type { View } from "@/store/ui";

const NAV: { id: View; label: string; icon: typeof LayoutGrid }[] = [
  { icon: LayoutGrid, id: "control", label: "Mission Control" },
  { icon: KanbanSquare, id: "board", label: "Board" },
  { icon: FolderTree, id: "projects", label: "Projects" },
];

interface AppHeaderProps {
  view: View;
  setView: (view: View) => void;
  openTask: TaskInfo | null;
  setOpenTaskId: (id: string | null) => void;
  attentionOpen: boolean;
  toggleAttention: () => void;
  connection: ConnectionState;
  connectionError: string | null;
  onNewTask: () => void;
  onOpenSettings: () => void;
}

export default function AppHeader({
  view,
  setView,
  openTask,
  setOpenTaskId,
  attentionOpen,
  toggleAttention,
  connection,
  connectionError,
  onNewTask,
  onOpenSettings,
}: AppHeaderProps) {
  return (
    <header className="flex h-10 items-center gap-3 border-b border-border/70 bg-card/80 px-2.5">
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
        onClick={onNewTask}
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
        <UpdateControl daemonConnected={connection === "connected"} />
        <Button
          size="icon"
          variant="ghost"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
          type="button"
          className="size-7"
        >
          <Settings className="size-4" />
        </Button>
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5",
              connection === "connected" ? "text-ok" : "text-warn",
            )}
          >
            <Circle
              className={cn(
                "size-2 fill-current",
                connection === "connected" ? "text-ok" : "text-warn",
              )}
            />
            {connection === "connected" ? "daemon" : connection}
          </span>
          {connectionError && connection !== "connected" && (
            <span
              className="max-w-80 truncate text-warn"
              role="status"
              title={connectionError}
            >
              {connectionError}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
