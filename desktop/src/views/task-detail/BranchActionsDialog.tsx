import { Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { daemon } from "../../daemon";
import type { GitOpResult } from "../../protocol";

export type BranchAction =
  | { kind: "rename"; branch: string }
  | { kind: "delete"; branch: string }
  | { kind: "rebase" }
  | { kind: "merge" };

function handleOpResult(r: GitOpResult) {
  switch (r.status) {
    case "up_to_date":
      toast.info(r.message);
      break;
    case "ok":
      toast.success(r.message);
      break;
    case "conflict":
      toast.error(r.message, {
        description: r.conflicts.length > 0 ? r.conflicts.join(", ") : undefined,
      });
      break;
    case "error":
      toast.error(r.message);
      break;
  }
}

const handleOpError = (e: Error) => toast.error(e.message);

export function BranchActionsDialog({
  action,
  branches,
  current,
  taskId,
  onResult,
  onClose,
}: {
  action: BranchAction | null;
  branches: string[];
  current: string;
  taskId: string;
  onResult: (r: GitOpResult) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [target, setTarget] = useState("");

  const mutate = useMutation<GitOpResult, Error>({
    mutationFn: async () => {
      if (!action) throw new Error("no action");
      switch (action.kind) {
        case "rename":
          return (await daemon.request("git.branchRename", {
            task_id: taskId,
            branch: action.branch,
            new_name: newName.trim(),
          })) as GitOpResult;
        case "delete":
          return (await daemon.request("git.branchDelete", {
            task_id: taskId,
            branch: action.branch,
          })) as GitOpResult;
        case "rebase":
          return (await daemon.request("git.rebase", {
            task_id: taskId,
            target,
          })) as GitOpResult;
        case "merge":
          return (await daemon.request("git.merge", {
            task_id: taskId,
            target,
          })) as GitOpResult;
      }
    },
    onError: handleOpError,
    onSuccess: (r) => {
      handleOpResult(r);
      onResult(r);
    },
    onSettled: () => {
      setNewName("");
      setTarget("");
      onClose();
    },
  });

  if (!action) {
    return null;
  }

  const candidates = branches.filter((b) => b !== current);
  const canRun =
    action.kind === "rename"
      ? newName.trim().length > 0 && newName.trim() !== action.branch
      : action.kind === "delete" || target.length > 0;

  const title =
    action.kind === "rename"
      ? `Rename branch`
      : action.kind === "delete"
        ? `Delete branch`
        : action.kind === "rebase"
          ? `Rebase onto`
          : `Merge into ${current}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {action.kind === "rename" && (
              <>
                Rename <span className="font-mono">{action.branch}</span> to a new name.
              </>
            )}
            {action.kind === "delete" && (
              <>
                Permanently delete <span className="font-mono">{action.branch}</span>? This
                cannot be undone.
              </>
            )}
            {action.kind === "rebase" && (
              <>
                Rebase the current branch (<span className="font-mono">{current}</span>) onto
                another branch.
              </>
            )}
            {action.kind === "merge" && (
              <>
                Merge another branch into{" "}
                <span className="font-mono">{current}</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {action.kind === "rename" && (
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canRun && mutate.mutate()}
            placeholder={action.branch}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        )}

        {(action.kind === "rebase" || action.kind === "merge") && (
          <>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a branch" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((b) => (
                  <SelectItem key={b} value={b}>
                    <span className="flex items-center gap-2 font-mono">{b}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {candidates.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other local branches to {action.kind} into.
              </p>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action.kind === "delete" ? "destructive" : "default"}
            disabled={!canRun || mutate.isPending}
            onClick={() => mutate.mutate()}
          >
            {mutate.isPending && <Loader2 className="size-4 animate-spin" />}
            {action.kind === "rename"
              ? "Rename"
              : action.kind === "delete"
                ? "Delete"
                : action.kind === "rebase"
                  ? "Rebase"
                  : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}