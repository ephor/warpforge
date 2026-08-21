import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { daemon } from "../daemon";
import { showContextMenu, useNativeContextMenu } from "../hooks/useNativeContextMenu";
import type { FileDiff } from "../protocol";
import { CommitBox } from "./changes/CommitBox";
import { FileTreeRow } from "./changes/FileTreeRow";
import {
  buildTree,
  collectFolderKeys,
  compact,
  flattenNode,
  leaves,
  type FlatRow,
  type Node,
} from "./changes/treeUtils";

/**
 * JetBrains-Air "Changes" rail: a grouped tree of changed files with per-file
 * (and per-folder) staging checkboxes and +adds/-dels counts, plus an inline
 * commit box at the bottom. Clicking a file selects it in the diff view.
 *
 * Performance: the tree is flattened into a virtual list — only visible rows
 * are mounted in the DOM, so 900+ files render without jank.
 */

const ROW_HEIGHT = 28;

/**
 * Git failures arrive with whatever the command printed attached, and a hook
 * that ran first can bury the reason under its own log. Git states why it gave
 * up on the last line, so lead with that and keep the log a click away.
 */
function reportGitFailure(title: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const lines = detail.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1]?.trim() ?? detail;
  const reason = last.length > 200 ? `${last.slice(0, 200)}…` : last;
  toast.error(title, {
    description: reason,
    duration: 10_000,
    action:
      reason === detail
        ? undefined
        : {
            label: "Copy",
            onClick: () => void navigator.clipboard.writeText(detail),
          },
  });
}

export function ChangesRail({
  project,
  files,
  selected,
  onSelect,
  taskId,
  commitExpanded: controlledCommitExpanded,
  onCommitExpandedChange,
  onCommitted,
  onRefresh,
}: {
  project: string;
  files: FileDiff[];
  selected: string | null;
  onSelect: (path: string) => void;
  taskId: string;
  commitExpanded?: boolean;
  onCommitExpandedChange?: (expanded: boolean) => void;
  onCommitted: () => void;
  onRefresh: () => void;
}) {
  const allPaths = useMemo(() => files.map((f) => f.path), [files]);
  const filesByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const [staged, setStaged] = useState<Set<string>>(() => new Set(allPaths));
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [localCommitExpanded, setLocalCommitExpanded] = useState(false);
  const commitExpanded = controlledCommitExpanded ?? localCommitExpanded;
  const setCommitExpanded = (expanded: boolean) => {
    setLocalCommitExpanded(expanded);
    onCommitExpandedChange?.(expanded);
  };
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const textGenAgentId = useUi((s) => s.textGenAgentId);
  const textGenModel = useUi((s) => s.textGenModel);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackConfirmation, setRollbackConfirmation] = useState<string | null>(null);
  // Small change sets: expand all folders. Large ones: start collapsed for performance.
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => {
    if (files.length <= 50) {
      const tree = compact(buildTree(files));
      const root = { children: tree.children, name: project } as Node;
      const all = new Set<string>();
      collectFolderKeys(root, "", all);
      return all;
    }
    return new Set();
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-sync selection as the diff's file set changes (keep prior choices).
  useEffect(() => {
    setStaged((prev) => {
      const next = new Set(allPaths.filter((p) => prev.has(p) || prev.size === 0));
      if (next.size === prev.size && [...next].every((path) => prev.has(path))) {
        return prev;
      }
      return next;
    });
  }, [allPaths]);

  const rollbackSelectionKey = useMemo(
    () => `${allPaths.join("\0")}\n${[...staged].sort().join("\0")}`,
    [allPaths, staged],
  );
  const rollbackConfirm = rollbackConfirmation === rollbackSelectionKey;

  // Wrap the project's files under a single root labelled with the project.
  const root = useMemo(() => {
    const tree = compact(buildTree(files));
    return { children: tree.children, name: project } as Node;
  }, [files, project]);

  // Flatten visible tree rows.
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flattenNode(root, 0, "", openFolders, out);
    return out;
  }, [root, openFolders]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_HEIGHT,
    getScrollElement: () => scrollRef.current,
    overscan: 20,
  });

  const toggleFolder = useCallback((fk: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fk)) {
        next.delete(fk);
      } else {
        next.add(fk);
      }
      return next;
    });
  }, []);

  const toggle = useCallback((paths: string[], on: boolean) => {
    setStaged((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) {
          next.add(p);
        } else {
          next.delete(p);
        }
      }
      return next;
    });
  }, []);

  const requestId = useRef(`changes-${taskId}`).current;
  const targetRef = useRef<{ kind: "file" | "folder"; path?: string; paths: string[] } | null>(
    null,
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent, row: FlatRow) => {
      e.preventDefault();
      e.stopPropagation();
      const path = row.node.path;
      if (path) {
        targetRef.current = { kind: "file", path, paths: [path] };
        void showContextMenu({
          requestId,
          items: [
            {
              type: "item",
              id: "toggle",
              label: staged.has(path) ? "Unstage" : "Stage",
            },
            { type: "item", id: "open", label: "Show Diff" },
            { type: "item", id: "jump", label: "Jump to Source" },
            { type: "separator" },
            { type: "item", id: "toggle", label: staged.has(path) ? "Unstage" : "Stage" },
            { type: "item", id: "rollback", label: "Rollback File" },
            { type: "separator" },
            { type: "item", id: "copy", label: "Copy Path" },
            { type: "item", id: "refresh", label: "Refresh" },
          ],
        });
        return;
      }
      const paths = leaves(row.node);
      targetRef.current = { kind: "folder", paths };
      const allStaged = paths.every((p) => staged.has(p));
      void showContextMenu({
        requestId,
        items: [
          { type: "item", id: "toggle", label: allStaged ? "Unstage folder" : "Stage folder" },
          { type: "separator" },
          { type: "item", id: "copy", label: "Copy Path" },
          { type: "item", id: "refresh", label: "Refresh" },
        ],
      });
    },
    [requestId, staged],
  );

  const menuHandlers = useMemo(
    () =>
      new Map<string, () => void>([
        [
          "toggle",
          () => {
            const t = targetRef.current;
            if (!t) return;
            const on =
              t.kind === "file" ? !staged.has(t.path!) : !t.paths.every((p) => staged.has(p));
            toggle(t.paths, on);
          },
        ],
        [
          "open",
          () => {
            const t = targetRef.current;
            if (t && t.path) onSelect(t.path);
          },
        ],
        [
          "jump",
          () => {
            const t = targetRef.current;
            if (t?.path) onSelect(t.path);
          },
        ],
        [
          "copy",
          () => {
            const t = targetRef.current;
            if (t) void navigator.clipboard.writeText(t.paths.join("\n"));
          },
        ],
        ["refresh", onRefresh],
        [
          "rollback",
          () => {
            const t = targetRef.current;
            if (!t?.path) return;
            const file = filesByPath.get(t.path);
            if (!file) return;
            const indices = file.status === "added" ? [0] : file.hunks.map((_, i) => i).reverse();
            void Promise.all(
              indices.map((hunkIndex) =>
                daemon.request("diff.resolveHunk", {
                  file: t.path,
                  hunk_index: hunkIndex,
                  resolution: "reject",
                  task_id: taskId,
                }),
              ),
            ).then(onRefresh);
          },
        ],
      ]),
    [filesByPath, onRefresh, onSelect, staged, taskId, toggle],
  );
  useNativeContextMenu(requestId, menuHandlers);

  const canCommit = !busy && staged.size > 0 && (message.trim().length > 0 || amend);

  /**
   * Turning on amend fills the box with the commit being rewritten, so the
   * message is there to edit instead of having to be retyped. Anything the user
   * wrote themselves is left alone, and unchecking only takes back a message we
   * put there ourselves.
   */
  const prefilledMessage = useRef<string | null>(null);
  const toggleAmend = async (next: boolean) => {
    setAmend(next);
    if (!next) {
      if (prefilledMessage.current !== null && message === prefilledMessage.current) {
        setMessage("");
      }
      prefilledMessage.current = null;
      return;
    }
    if (message.trim().length > 0) return;
    try {
      const last = await daemon.lastCommitMessage(taskId);
      if (!last) return;
      prefilledMessage.current = last;
      setMessage((current) => (current.trim().length > 0 ? current : last));
    } catch (e) {
      reportGitFailure("Could not read the last commit message", e);
    }
  };
  const canRollback = !rollbackBusy && staged.size > 0;

  const commit = async () => {
    setBusy(true);
    try {
      const all = staged.size === allPaths.length;
      await daemon.request("git.commit", {
        amend,
        files: all ? null : [...staged],
        message: message.trim(),
        task_id: taskId,
      });
      setMessage("");
      setAmend(false);
      setCommitExpanded(false);
      onCommitted();
    } catch (e) {
      reportGitFailure(amend ? "Could not amend the commit" : "Could not commit", e);
    } finally {
      setBusy(false);
    }
  };

  const generateMessage = async () => {
    if (!textGenAgentId || generating) {
      return;
    }
    setGenerating(true);
    try {
      const text = await daemon.generateText(
        taskId,
        textGenAgentId,
        "commit_message",
        textGenModel ?? undefined,
      );
      setMessage(text);
    } catch (e) {
      reportGitFailure("Could not draft a commit message", e);
    } finally {
      setGenerating(false);
    }
  };

  const rollbackChecked = async () => {
    if (!canRollback) {
      return;
    }
    if (!rollbackConfirm) {
      setRollbackConfirmation(rollbackSelectionKey);
      return;
    }
    setRollbackBusy(true);
    try {
      await Promise.all(
        [...staged].flatMap((path) => {
          const file = filesByPath.get(path);
          if (!file) return [];
          const indices = file.status === "added" ? [0] : file.hunks.map((_, i) => i).reverse();
          return indices.map((hunkIndex) =>
            daemon.request("diff.resolveHunk", {
              file: path,
              hunk_index: hunkIndex,
              resolution: "reject",
              task_id: taskId,
            }),
          );
        }),
      );
      setRollbackConfirmation(null);
      onRefresh();
    } catch (e) {
      reportGitFailure("Could not roll back the selected changes", e);
    } finally {
      setRollbackBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-11 items-center gap-2 border-b px-3 text-sm font-semibold">
        <span className="min-w-0 flex-1 truncate">Changes</span>
        <button
          type="button"
          aria-label="Refresh changes"
          title="Refresh changes"
          onClick={onRefresh}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={rollbackConfirm ? "Confirm rollback checked files" : "Rollback checked files"}
          title={
            rollbackConfirm ? "Click again to rollback checked files" : "Rollback checked files"
          }
          disabled={!canRollback}
          onClick={rollbackChecked}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40",
            rollbackConfirm && "text-destructive hover:text-destructive",
          )}
        >
          <Undo2 className="size-3.5" />
        </button>
      </div>
      <div className="flex h-8 items-center gap-2 border-b bg-secondary/55 px-3 text-xs text-muted-foreground">
        <input
          aria-label="Stage all files"
          type="checkbox"
          checked={staged.size === allPaths.length && allPaths.length > 0}
          disabled={allPaths.length === 0}
          ref={(el) => {
            if (el) el.indeterminate = staged.size > 0 && staged.size < allPaths.length;
          }}
          onChange={(e) => setStaged(e.target.checked ? new Set(allPaths) : new Set())}
          className="size-3 accent-primary"
        />
        <span className="tnum">
          {staged.size}/{allPaths.length} files
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1.5">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No changes.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <FileTreeRow
                  key={vi.key}
                  row={row}
                  vi={vi}
                  staged={staged}
                  selected={selected}
                  openFolders={openFolders}
                  onToggle={toggle}
                  onToggleFolder={toggleFolder}
                  onSelect={onSelect}
                  onContextMenu={handleContextMenu}
                />
              );
            })}
          </div>
        )}
      </div>

      {files.length > 0 && (
        <CommitBox
          commitExpanded={commitExpanded}
          setCommitExpanded={setCommitExpanded}
          stagedSize={staged.size}
          message={message}
          setMessage={setMessage}
          amend={amend}
          setAmend={(v) => void toggleAmend(v)}
          busy={busy}
          generating={generating}
          canCommit={canCommit}
          onCommit={commit}
          onGenerate={generateMessage}
          textGenAgentId={textGenAgentId}
        />
      )}
    </div>
  );
}
