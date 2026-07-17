import {
  Archive,
  Diff,
  Folder,
  GitCommitVertical,
  ListTodo,
  MessageSquare,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { memo, useState } from "react";

import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { TaskInfo } from "../protocol";
import { useUi } from "../store/ui";

export const TaskDetailActions = memo(function TaskDetailActions({
  onClose,
  task,
}: {
  onClose: () => void;
  task: TaskInfo;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showChat = useUi((state) => state.showChat);
  const showDiff = useUi((state) => state.showDiff);
  const rightPanel = useUi((state) => state.rightPanel);
  const runtimeOpen = useUi((state) => state.runtimeOpen);
  const toggleChat = useUi((state) => state.toggleChat);
  const toggleDiff = useUi((state) => state.toggleDiff);
  const setShowDiff = useUi((state) => state.setShowDiff);
  const setRightPanel = useUi((state) => state.setRightPanel);
  const setRuntimeOpen = useUi((state) => state.setRuntimeOpen);

  const togglePanel = (panel: "files" | "changes" | "subtasks") => {
    setShowDiff(true);
    setRightPanel(rightPanel === panel ? null : panel);
  };

  return (
    <div className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border bg-card/95 py-2 text-muted-foreground">
      <ActionButton
        label="Toggle chat"
        active={showChat}
        onClick={toggleChat}
        icon={<MessageSquare className="size-4" />}
      />
      <ActionButton
        label="Toggle diff"
        active={showDiff}
        onClick={toggleDiff}
        icon={<Diff className="size-4" />}
      />
      <div className="my-1 h-px w-5 bg-border" />
      <ActionButton
        label="Files"
        active={rightPanel === "files"}
        onClick={() => togglePanel("files")}
        icon={<Folder className="size-4" />}
      />
      <ActionButton
        label="Changes"
        active={rightPanel === "changes"}
        onClick={() => togglePanel("changes")}
        icon={<GitCommitVertical className="size-4" />}
      />
      {task.orchestrationGraph && task.orchestrationGraph.nodes.length > 0 && (
        <ActionButton
          label="Subtasks"
          active={rightPanel === "subtasks"}
          onClick={() => togglePanel("subtasks")}
          icon={<ListTodo className="size-4" />}
        />
      )}
      <ActionButton
        label="Runtime"
        active={runtimeOpen}
        onClick={() => setRuntimeOpen(!runtimeOpen)}
        icon={<SquareTerminal className="size-4" />}
      />
      <div className="mt-auto flex flex-col items-center gap-2">
        <ActionButton
          label="Archive task"
          onClick={() => {
            void daemon.archiveTask(task.id);
            onClose();
          }}
          icon={<Archive className="size-4" />}
        />
        <button
          type="button"
          aria-label="Delete task"
          title="Delete task"
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            void daemon.deleteTask(task.id);
            onClose();
          }}
          className={cn(
            "rounded-md p-1.5 hover:bg-destructive/20 hover:text-destructive",
            confirmDelete && "bg-destructive/20 text-destructive",
          )}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
});

function ActionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "rounded-md p-1.5 hover:bg-secondary hover:text-foreground",
        active && "bg-secondary text-foreground",
      )}
    >
      {icon}
    </button>
  );
}
