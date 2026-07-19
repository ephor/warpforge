import { Archive, MoreHorizontal, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 />
            Delete task…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this task?</DialogTitle>
          <DialogDescription>
            This permanently deletes “{task.prompt}”. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void daemon.deleteTask(task.id);
              setDeleteOpen(false);
              onClose();
            }}
          >
            Delete task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
