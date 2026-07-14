import {
  ArrowRight,
  ChevronDown,
  FileCode2,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { GitOpResult, GitPushCommit, GitPushInfo, TaskInfo } from "../protocol";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: TaskInfo | null;
}

const statusTone: Record<string, string> = {
  A: "text-ok",
  C: "text-warn",
  D: "text-destructive",
  M: "text-primary",
  R: "text-warn",
};

export default function PushDialog({ open, onOpenChange, task }: Props) {
  const [info, setInfo] = useState<GitPushInfo | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState<"push" | "force" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id;
  const load = useCallback(async () => {
    if (!taskId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = (await daemon.request("git.pushInfo", {
        task_id: taskId,
      })) as GitPushInfo;
      setInfo(next);
      setSelectedHash((current) =>
        next.commits.some((commit) => commit.hash === current)
          ? current
          : (next.commits[0]?.hash ?? null),
      );
    } catch (reason) {
      setInfo(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!open) {
      setMenuOpen(false);
      return;
    }
    void load();
  }, [load, open]);

  const selected = useMemo(
    () => info?.commits.find((commit) => commit.hash === selectedHash) ?? null,
    [info, selectedHash],
  );

  const push = async (force: boolean) => {
    if (!task || pushing) {
      return;
    }
    setMenuOpen(false);
    setPushing(force ? "force" : "push");
    try {
      const result = (await daemon.request("git.push", {
        force,
        task_id: task.id,
      })) as GitOpResult;
      if (result.status === "ok") {
        toast.success(result.message);
        onOpenChange(false);
      } else if (result.status === "up_to_date") {
        toast.info(result.message);
        onOpenChange(false);
      } else {
        toast.error(result.message);
      }
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPushing(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pushing && onOpenChange(next)}>
      <DialogContent className="flex h-[72vh] max-h-[760px] w-[min(1050px,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">
              Push commits to {task?.project ?? "project"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Review outgoing commits and their files before pushing the current branch.
            </DialogDescription>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="ml-auto mr-8 size-8"
            disabled={loading || Boolean(pushing)}
            onClick={() => void load()}
            title="Refresh push preview"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 basis-[46%] flex-col border-r">
            {info && (
              <div className="flex h-11 shrink-0 items-center gap-2 border-b bg-primary/10 px-4 font-mono text-sm">
                <GitBranch className="size-4 shrink-0 text-primary" />
                <span className="truncate text-foreground">{info.branch}</span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-primary">{info.upstream}</span>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading && !info && <LoadingState label="Reading outgoing commits…" />}
              {error && (
                <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              {info && info.commits.length === 0 && (
                <EmptyState
                  title="Nothing to push"
                  detail={`${info.branch} is up to date with ${info.upstream}.`}
                />
              )}
              {info?.commits.map((commit) => (
                <CommitRow
                  key={commit.hash}
                  commit={commit}
                  selected={commit.hash === selectedHash}
                  onSelect={() => setSelectedHash(commit.hash)}
                />
              ))}
            </div>
          </section>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-sm text-muted-foreground">
              <FolderTree className="size-4" />
              <span className="font-medium text-foreground">Files</span>
              {selected && (
                <span>
                  {selected.files.length} {selected.files.length === 1 ? "file" : "files"}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {selected ? (
                <div className="space-y-0.5">
                  {selected.files.map((file) => (
                    <div
                      key={`${file.status}-${file.path}`}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-secondary/60"
                    >
                      <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                      <span
                        className={cn(
                          "w-5 text-center font-mono text-xs font-semibold",
                          statusTone[file.status] ?? "text-muted-foreground",
                        )}
                      >
                        {file.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                !loading && (
                  <EmptyState
                    title="Select a commit"
                    detail="Its changed files will appear here."
                  />
                )
              )}
            </div>
          </section>
        </div>

        <footer className="flex h-[72px] shrink-0 items-center border-t bg-card/50 px-5">
          <div className="min-w-0 text-xs text-muted-foreground">
            {info && !info.hasUpstream && info.commits.length > 0 && (
              <span>
                First push will create upstream{" "}
                <span className="font-mono text-foreground">{info.upstream}</span>.
              </span>
            )}
            {info?.hasUpstream && info.commits.length > 0 && (
              <span>
                {info.commits.length} outgoing {info.commits.length === 1 ? "commit" : "commits"}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(pushing)}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <div className="relative flex">
              <Button
                type="button"
                className="rounded-r-none px-4"
                disabled={!info?.commits.length || loading || Boolean(pushing)}
                onClick={() => void push(false)}
              >
                {pushing === "push" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                Push
              </Button>
              <Button
                type="button"
                size="icon"
                className="rounded-l-none border-l border-primary-foreground/20"
                disabled={!info?.commits.length || loading || Boolean(pushing)}
                aria-label="Push options"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <ChevronDown className="size-4" />
              </Button>
              {menuOpen && (
                <div className="absolute bottom-full right-0 z-20 mb-2 min-w-48 rounded-md border bg-popover p-1 shadow-xl">
                  <button
                    type="button"
                    className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => void push(true)}
                  >
                    <span className="block font-medium">Force Push</span>
                    <span className="block text-xs text-muted-foreground">
                      Uses force-with-lease
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: GitPushCommit;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors",
        selected ? "bg-primary/15 text-foreground" : "hover:bg-secondary/60",
      )}
    >
      <GitCommitHorizontal
        className={cn(
          "mt-0.5 size-4 shrink-0",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{commit.subject}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{commit.shortHash}</span>
          <span className="truncate">{commit.author}</span>
          <span className="ml-auto shrink-0">
            {commit.files.length} {commit.files.length === 1 ? "file" : "files"}
          </span>
        </span>
      </span>
    </button>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
