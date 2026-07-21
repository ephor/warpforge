import { Archive, MoreHorizontal, Pin, PinOff, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { daemon } from "../daemon";
import type { TaskInfo } from "../protocol";

export function TaskMenu({
  onClose,
  onTogglePin,
  pinned,
  task,
}: {
  onClose: () => void;
  onTogglePin: () => void;
  pinned: boolean;
  task: TaskInfo;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Task actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={onTogglePin}>
          {pinned ? <PinOff /> : <Pin />}
          {pinned ? "Unpin from Mission Control" : "Pin to Mission Control"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void daemon.archiveTask(task.id);
            onClose();
          }}
        >
          <Archive />
          Archive task
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            if (window.confirm(`Delete "${task.prompt}"? This cannot be undone.`)) {
              void daemon.deleteTask(task.id);
              onClose();
            }
          }}
        >
          <Trash2 />
          Delete task
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
