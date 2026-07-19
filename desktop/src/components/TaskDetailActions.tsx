import {
  Diff,
  Folder,
  GitCommitVertical,
  ListTodo,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { memo } from "react";

import { cn } from "@/lib/utils";

import type { TaskInfo } from "../protocol";
import { useUi } from "../store/ui";

export const TaskDetailActions = memo(function TaskDetailActions({ task }: { task: TaskInfo }) {
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
    <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
      <ActionButton
        label="Toggle chat"
        active={showChat}
        onClick={toggleChat}
        icon={<MessageSquare className="size-3.5" />}
      />
      <ActionButton
        label="Toggle diff"
        active={showDiff}
        onClick={toggleDiff}
        icon={<Diff className="size-3.5" />}
      />
      <ActionButton
        label="Files"
        active={rightPanel === "files"}
        onClick={() => togglePanel("files")}
        icon={<Folder className="size-3.5" />}
      />
      <ActionButton
        label="Changes"
        active={rightPanel === "changes"}
        onClick={() => togglePanel("changes")}
        icon={<GitCommitVertical className="size-3.5" />}
      />
      {task.orchestrationGraph && task.orchestrationGraph.nodes.length > 0 && (
        <ActionButton
          label="Subtasks"
          active={rightPanel === "subtasks"}
          onClick={() => togglePanel("subtasks")}
          icon={<ListTodo className="size-3.5" />}
        />
      )}
      <ActionButton
        label="Terminal"
        active={runtimeOpen}
        onClick={() => setRuntimeOpen(!runtimeOpen)}
        icon={<SquareTerminal className="size-3.5" />}
      />
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
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-4 items-center justify-center rounded-sm hover:bg-secondary hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
    </button>
  );
}
