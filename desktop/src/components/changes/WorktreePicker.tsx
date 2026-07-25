import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { WorktreeInfo } from "../../protocol";
import { daemonQuery } from "../../query";

/**
 * Compact worktree switcher for the Changes rail header. Lets the rail show the
 * diff from the main project checkout or any active git worktree. Selecting a
 * worktree passes its path up so the diff/file queries refetch from there.
 */
export function WorktreePicker({
  project,
  selectedPath,
  onSelect,
}: {
  project: string;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const { data } = useQuery({
    queryFn: daemonQuery<{ worktrees: WorktreeInfo[] }>("task.listWorktrees", { project }),
    queryKey: ["worktrees", project],
  });
  const worktrees = data?.worktrees ?? [];

  const selected = selectedPath ? worktrees.find((w) => w.path === selectedPath) : null;
  const label = selected ? selected.branch : "Working tree";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Worktree: ${label}`}
          title="Switch worktree"
          className="flex h-6 min-w-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <GitBranch className="size-3.5 shrink-0 text-primary" />
          <span className="max-w-28 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <span className="min-w-0 flex-1 truncate">Working tree</span>
          <Check className={cn("size-3.5", selectedPath === null ? "opacity-100" : "opacity-0")} />
        </DropdownMenuItem>
        {worktrees.map((wt) => (
          <DropdownMenuItem key={wt.path} onSelect={() => onSelect(wt.path)}>
            <span className="min-w-0 flex-1 truncate">{wt.branch}</span>
            <Check
              className={cn("size-3.5", selectedPath === wt.path ? "opacity-100" : "opacity-0")}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
