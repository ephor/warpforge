import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Download,
  GitBranch,
  GitCommitVertical,
  Loader2,
  Search,
  Send,
} from "lucide-react";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { daemon } from "../../daemon";
import type { GitBranchList, GitOpResult } from "../../protocol";
import { daemonQuery } from "../../query";
import { useUi } from "../../store/ui";
import {
  buildBranchTree,
  defaultOpenFolders,
  flattenBranchTree,
  type BranchRow,
} from "./branchTree";
import { BranchActionsDialog, type BranchAction } from "./BranchActionsDialog";
import { BranchList } from "./BranchList";

function handleGitOpResult(r: GitOpResult) {
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

const handleGitOpError = (e: Error) => toast.error(e.message);

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>, taskId: string) {
  void queryClient.invalidateQueries({ queryKey: ["diff", taskId] });
  void queryClient.invalidateQueries({ queryKey: ["fileList", taskId] });
  void queryClient.invalidateQueries({ queryKey: ["branches", taskId] });
}

function GitMenuAction({
  disabled,
  icon,
  label,
  onClick,
  shortcut,
}: {
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  shortcut: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50 disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      <kbd className="font-sans text-[11px] text-muted-foreground">{shortcut}</kbd>
    </button>
  );
}

export function GitWorkspaceControls({
  taskId,
  branch,
  onOpenCommit,
  onOpenPush,
}: {
  taskId: string;
  branch: string | null;
  onOpenCommit: () => void;
  onOpenPush: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const repositoryOperation = useUi((s) => s.repositoryOperation);
  const setRepositoryOperation = useUi((s) => s.setRepositoryOperation);

  const branchesQuery = useQuery({
    enabled: open,
    queryFn: daemonQuery<GitBranchList>("git.branches", { task_id: taskId }),
    queryKey: ["branches", taskId],
  });
  const branchData = branchesQuery.data;
  const branches = useMemo(() => branchData?.branches ?? [], [branchData]);
  const normalizedSearch = search.trim().toLowerCase();
  const showSync =
    !normalizedSearch || "sync with remote update project".includes(normalizedSearch);
  const showCommit = !normalizedSearch || "commit changes".includes(normalizedSearch);
  const showPush = !normalizedSearch || "push changes".includes(normalizedSearch);

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const updateMut = useMutation({
    mutationFn: () => daemon.request("git.update", { task_id: taskId }) as Promise<GitOpResult>,
    onMutate: () => setRepositoryOperation({ kind: "pull", taskId }),
    onError: (e: Error) => handleGitOpError(e),
    onSettled: () => {
      const operation = useUi.getState().repositoryOperation;
      if (operation?.taskId === taskId && operation.kind === "pull") {
        setRepositoryOperation(null);
      }
    },
    onSuccess: (r) => {
      handleGitOpResult(r);
      invalidateAll(queryClient, taskId);
    },
  });
  const switchMut = useMutation({
    mutationFn: (target: string) =>
      daemon.request("git.switchBranch", {
        task_id: taskId,
        branch: target,
      }) as Promise<GitOpResult>,
    onError: (e: Error) => handleGitOpError(e),
    onSuccess: (r) => {
      handleGitOpResult(r);
      invalidateAll(queryClient, taskId);
    },
  });

  const updating =
    updateMut.isPending ||
    (repositoryOperation?.taskId === taskId && repositoryOperation.kind === "pull");
  const switching = switchMut.isPending ? switchMut.variables : null;
  const busy = Boolean(repositoryOperation) || updating || switchMut.isPending;

  const [action, setAction] = useState<BranchAction | null>(null);
  const actionRef = useRef<{ branch: string; remote: boolean }>(null);

  const remoteBranches = useMemo(() => branchData?.remotes ?? [], [branchData]);

  const openActionDialog = (a: BranchAction) => {
    setOpen(false);
    setAction(a);
  };

  const switchToRef = useRef<(target: string) => void>(() => {});
  const openActionDialogRef = useRef(openActionDialog);
  openActionDialogRef.current = openActionDialog;

  const menuHandlers = new Map<string, () => void>([
    ["checkout", () => switchToRef.current(actionRef.current?.branch ?? "")],
    [
      "checkout-as-remote",
      () => {
        const t = actionRef.current;
        if (!t) return;
        const localName = t.branch.split("/").slice(1).join("/") || "new-branch";
        openActionDialogRef.current({ kind: "create", from: t.branch, defaultName: localName });
      },
    ],
    [
      "create",
      () => {
        const t = actionRef.current;
        if (!t) return;
        openActionDialogRef.current({ kind: "create", from: t.branch });
      },
    ],
    [
      "checkout-rebase",
      () => {
        const t = actionRef.current;
        if (!t) return;
        openActionDialogRef.current({ kind: "checkout-rebase", branch: t.branch });
      },
    ],
    [
      "checkout-update",
      () => {
        const t = actionRef.current;
        if (!t) return;
        openActionDialogRef.current({ kind: "checkout-update", branch: t.branch });
      },
    ],
    [
      "compare",
      () => {
        const t = actionRef.current;
        if (!t) return;
        openActionDialogRef.current({ kind: "compare", branch: t.branch });
      },
    ],
    ["rebase", () => openActionDialogRef.current({ kind: "rebase" })],
    ["merge", () => openActionDialogRef.current({ kind: "merge" })],
    ["update", () => updateMut.mutate()],
    ["push", () => { setOpen(false); onOpenPush(); }],
    [
      "rename",
      () => {
        const t = actionRef.current;
        if (!t) return;
        openActionDialogRef.current({ kind: "rename", branch: t.branch });
      },
    ],
    [
      "delete",
      () => {
        const t = actionRef.current;
        if (!t) return;
        openActionDialogRef.current({ kind: "delete", branch: t.branch });
      },
    ],
  ]);
  const handleBranchAction = (actionId: string, item: string, remote: boolean) => {
    actionRef.current = { branch: item, remote };
    menuHandlers.get(actionId)?.();
  };

  const localTree = useMemo(() => buildBranchTree(branches), [branches]);
  const remoteTree = useMemo(() => buildBranchTree(remoteBranches), [remoteBranches]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const toggleFolder = useCallback((key: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  useEffect(() => {
    if (open && openFolders.size === 0) {
      setOpenFolders((prev) => {
        const next = new Set([
          ...prev,
          ...defaultOpenFolders(localTree),
          ...defaultOpenFolders(remoteTree),
        ]);
        return next.size === prev.size ? prev : next;
      });
    }
  }, [open, openFolders.size, localTree, remoteTree]);
  const localRows = useMemo(() => {
    const out: BranchRow[] = [];
    flattenBranchTree(localTree, 0, "", openFolders, out);
    return out;
  }, [localTree, openFolders]);
  const remoteRows = useMemo(() => {
    const out: BranchRow[] = [];
    flattenBranchTree(remoteTree, 0, "", openFolders, out);
    return out;
  }, [remoteTree, openFolders]);

  const filteredLocal = useMemo(
    () =>
      normalizedSearch
        ? branches.filter((item) => item.toLowerCase().includes(normalizedSearch))
        : [],
    [branches, normalizedSearch],
  );
  const filteredRemote = useMemo(
    () =>
      normalizedSearch
        ? remoteBranches.filter((item) => item.toLowerCase().includes(normalizedSearch))
        : [],
    [remoteBranches, normalizedSearch],
  );
  const searching = normalizedSearch.length > 0;
  const searchRows = useMemo(() => {
    if (!searching) return [];
    const out: BranchRow[] = [];
    for (const b of filteredLocal) {
      out.push({ key: b, depth: 0, label: b.split("/").pop()!, branch: b });
    }
    for (const b of filteredRemote) {
      out.push({ key: b, depth: 0, label: b.split("/").pop()!, branch: b, remote: true });
    }
    return out;
  }, [searching, filteredLocal, filteredRemote]);

  const switchTo = (target: string) => {
    setOpen(false);
    if (busy || target === branch) {
      return;
    }
    switchMut.mutate(target);
  };
  switchToRef.current = switchTo;

  return (
    <span className="flex min-w-0 items-center">
      <div ref={menuRef} className="relative min-w-0">
        <button
          type="button"
          disabled={!branch}
          onClick={() => setOpen((o) => !o)}
          title="Branches and Git actions"
          className="flex items-center gap-1 rounded px-1 font-mono hover:bg-secondary hover:text-foreground disabled:opacity-60"
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="max-w-40 truncate">{branch ?? "no-branch"}</span>
          {switching ? (
            <Loader2 className="size-2.5 animate-spin opacity-60" />
          ) : (
            branch && <ChevronDown className="size-2.5 opacity-60" />
          )}
        </button>
        {open && branch && (
          <div className="absolute bottom-full right-0 z-50 mb-1 flex max-h-[min(520px,calc(100vh-4rem))] w-[min(420px,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-popover shadow-xl">
            <div className="shrink-0 border-b p-2">
              <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background/60 px-2 focus-within:ring-1 focus-within:ring-ring">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setOpen(false);
                  }}
                  placeholder="Search branches and actions"
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>
            <div className="min-h-0 overflow-y-auto p-1.5">
              {(showSync || showCommit || showPush) && (
                <div className="space-y-0.5 pb-1.5">
                  {showSync && (
                    <GitMenuAction
                      icon={
                        updating ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Download className="size-4" />
                        )
                      }
                      label="Sync with remote"
                      shortcut="⌘T"
                      disabled={busy || !branch}
                      onClick={() => updateMut.mutate()}
                    />
                  )}
                  {showCommit && (
                    <GitMenuAction
                      icon={<GitCommitVertical className="size-4" />}
                      label="Commit…"
                      shortcut="⌘K"
                      onClick={() => {
                        setOpen(false);
                        onOpenCommit();
                      }}
                    />
                  )}
                  {showPush && (
                    <GitMenuAction
                      icon={<Send className="size-4" />}
                      label="Push…"
                      shortcut="⇧⌘K"
                      onClick={() => {
                        setOpen(false);
                        onOpenPush();
                      }}
                    />
                  )}
                </div>
              )}

              {(showSync || showCommit || showPush) && (
                <div className="mx-1 border-t" />
              )}
              <div className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Branches
              </div>
              {branchesQuery.isLoading && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
              )}
              {!branchesQuery.isLoading && (
                <BranchList
                  localRows={localRows}
                  remoteRows={remoteRows}
                  searching={searching}
                  searchRows={searchRows}
                  openFolders={openFolders}
                  current={branch}
                  onAction={handleBranchAction}
                  onToggleFolder={toggleFolder}
                />
              )}
              {!branchesQuery.isLoading &&
                searching &&
                searchRows.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    No matching branches
                  </p>
                )}
            </div>
          </div>
        )}
      </div>
      <BranchActionsDialog
        action={action}
        branches={branches}
        current={branch ?? ""}
        taskId={taskId}
        onComplete={() => invalidateAll(queryClient, taskId)}
        onClose={() => setAction(null)}
      />
    </span>
  );
}
