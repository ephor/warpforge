import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
  | { kind: "create"; from: string; defaultName?: string }
  | { kind: "rebase" }
  | { kind: "merge" }
  | { kind: "checkout-rebase"; branch: string }
  | { kind: "checkout-update"; branch: string }

interface DialogProps {
  action: BranchAction | null;
  branches: string[];
  current: string;
  taskId: string;
  onComplete: () => void;
  onClose: () => void;
}

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
  onComplete,
  onClose,
}: DialogProps) {
  const [newName, setNewName] = useState("");
  const [target, setTarget] = useState("");

  useEffect(() => {
    setNewName(action?.kind === "create" ? action.defaultName ?? "" : "");
    setTarget("");
  }, [action]);

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
            force: true,
          })) as GitOpResult;
        case "create":
          return (await daemon.request("git.branchCreate", {
            task_id: taskId,
            name: newName.trim(),
            from: action.from,
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
        case "checkout-rebase": {
          const switched = (await daemon.request("git.switchBranch", {
            task_id: taskId,
            branch: action.branch,
          })) as GitOpResult;
          if (switched.status === "error" || switched.status === "conflict") {
            return switched;
          }
          return (await daemon.request("git.rebase", {
            task_id: taskId,
            target,
          })) as GitOpResult;
        }
        case "checkout-update": {
          const switched = (await daemon.request("git.switchBranch", {
            task_id: taskId,
            branch: action.branch,
          })) as GitOpResult;
          if (switched.status === "error" || switched.status === "conflict") {
            return switched;
          }
          return (await daemon.request("git.update", {
            task_id: taskId,
          })) as GitOpResult;
        }
      }
    },
    onError: handleOpError,
    onSuccess: (result) => {
      if (!action) return;
      handleOpResult(result as GitOpResult);
      onComplete();
      setNewName("");
      setTarget("");
      onClose();
    },
  });

  if (!action) {
    return null;
  }

  const targetBranch = action.kind === "checkout-rebase" ? action.branch : current;
  const candidates = branches.filter((b) => b !== targetBranch);
  const needsTarget =
    action.kind === "rebase" || action.kind === "merge" || action.kind === "checkout-rebase";
  const canRun =
    action.kind === "rename"
      ? newName.trim().length > 0 && newName.trim() !== action.branch
      : action.kind === "delete"
        ? true
        : action.kind === "create"
          ? newName.trim().length > 0
          : needsTarget
            ? target.length > 0
            : true;

  const title = getTitle(action);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{getDescription(action, current)}</DialogDescription>
        </DialogHeader>

        {(action.kind === "rename" || action.kind === "create") && (
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canRun && mutate.mutate()}
            placeholder={action.kind === "create" ? action.defaultName ?? "new-branch" : action.branch}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        )}

        {needsTarget && (
          <>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a branch" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((b) => (
                  <SelectItem key={b} value={b}>
                    <span className="font-mono">{b}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {candidates.length === 0 && (
              <p className="text-xs text-muted-foreground">No other local branches available.</p>
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
            {getConfirmLabel(action)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getTitle(action: BranchAction): string {
  switch (action.kind) {
    case "rename":
      return "Rename branch";
    case "delete":
      return "Delete branch";
    case "create":
      return "New branch";
    case "rebase":
      return "Rebase onto";
    case "merge":
      return "Merge into current";
    case "checkout-rebase":
      return "Checkout and rebase";
    case "checkout-update":
      return "Checkout and update";
  }
}

function getDescription(action: BranchAction, current: string): ReactNode {
  switch (action.kind) {
    case "rename":
      return <>Rename <span className="font-mono">{action.branch}</span>.</>;
    case "delete":
      return (
        <>
          Permanently delete <span className="font-mono">{action.branch}</span>? This cannot be
          undone.
        </>
      );
    case "create":
      return (
        <>
          Create a new branch off <span className="font-mono">{action.from}</span> and check it out.
        </>
      );
    case "rebase":
      return (
        <>
          Rebase the current branch (<span className="font-mono">{current}</span>) onto another.
        </>
      );
    case "merge":
      return (
        <>
          Merge another branch into <span className="font-mono">{current}</span>.
        </>
      );
    case "checkout-rebase":
      return (
        <>
          Checkout <span className="font-mono">{action.branch}</span> and rebase it onto another.
        </>
      );
    case "checkout-update":
      return (
        <>
          Checkout <span className="font-mono">{action.branch}</span> and update from its upstream.
        </>
      );
  }
}

function getConfirmLabel(action: BranchAction): string {
  switch (action.kind) {
    case "rename":
      return "Rename";
    case "delete":
      return "Delete";
    case "create":
      return "Create";
    case "rebase":
      return "Rebase";
    case "merge":
      return "Merge";
    case "checkout-rebase":
      return "Checkout and rebase";
    case "checkout-update":
      return "Checkout and update";
  }
}
