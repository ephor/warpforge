import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, GitCommitVertical, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { FileDiff } from "../protocol";

/**
 * JetBrains-Air "Changes" rail: a grouped tree of changed files with per-file
 * (and per-folder) staging checkboxes and +adds/-dels counts, plus an inline
 * commit box at the bottom. Clicking a file selects it in the diff view.
 *
 * Performance: the tree is flattened into a virtual list — only visible rows
 * are mounted in the DOM, so 900+ files render without jank.
 */

interface Stat {
  adds: number;
  dels: number;
  status: FileDiff["status"];
}

function stat(f: FileDiff): Stat {
  let adds = 0;
  let dels = 0;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) {
        adds++;
      } else if (l.startsWith("-")) {
        dels++;
      }
    }
  }
  return { adds, dels, status: f.status };
}

interface Node {
  name: string;
  path?: string; // Set on leaves
  stat?: Stat;
  children: Map<string, Node>;
}

function buildTree(files: FileDiff[]): Node {
  const root: Node = { children: new Map(), name: "" };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), name: part };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.path = f.path;
        child.stat = stat(f);
      }
      node = child;
    });
  }
  return root;
}

/** Collapse single-child folder chains into one row (plans/sub). */
function compact(node: Node): Node {
  const children = [...node.children.values()].map(compact);
  if (!node.path && children.length === 1 && !children[0].path) {
    const only = children[0];
    return { ...only, name: node.name ? `${node.name}/${only.name}` : only.name };
  }
  const map = new Map<string, Node>();
  for (const c of children) {
    map.set(c.name, c);
  }
  return { ...node, children: map };
}

function leaves(node: Node): string[] {
  if (node.path) {
    return [node.path];
  }
  return [...node.children.values()].flatMap(leaves);
}

const STATUS: Record<FileDiff["status"], { glyph: string; color: string }> = {
  added: { color: "text-ok", glyph: "A" },
  deleted: { color: "text-destructive", glyph: "D" },
  modified: { color: "text-sky-400", glyph: "M" },
  renamed: { color: "text-warn", glyph: "R" },
};

function sortChildren(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
}

/** Folder key: unique identifier for open/closed tracking. */
function folderKey(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

/** Collect all folder keys in the tree (for initial "expand all" state). */
function collectFolderKeys(node: Node, parentPath: string, out: Set<string>): void {
  for (const child of node.children.values()) {
    if (!child.path) {
      const fk = folderKey(parentPath, child.name);
      out.add(fk);
      collectFolderKeys(child, fk, out);
    }
  }
}

/** One row in the flattened tree. */
interface FlatRow {
  key: string;
  node: Node;
  depth: number;
  /** For folders: the folder's unique key in the openFolders set. */
  fKey?: string;
}

/** Recursively flatten a tree into visible rows based on which folders are open. */
function flattenNode(
  node: Node,
  depth: number,
  parentPath: string,
  openFolders: Set<string>,
  out: FlatRow[],
): void {
  const kids = sortChildren(node);
  for (const child of kids) {
    if (child.path) {
      out.push({ key: child.path, node: child, depth });
    } else {
      const fk = folderKey(parentPath, child.name);
      out.push({ key: `f:${fk}`, node: child, depth, fKey: fk });
      if (openFolders.has(fk)) {
        flattenNode(child, depth + 1, fk, openFolders, out);
      }
    }
  }
}

const ROW_HEIGHT = 28; // h-7

export function ChangesRail({
  project,
  files,
  selected,
  onSelect,
  taskId,
  onCommitted,
  onRefresh,
}: {
  project: string;
  files: FileDiff[];
  selected: string | null;
  onSelect: (path: string) => void;
  taskId: string;
  onCommitted: () => void;
  onRefresh: () => void;
}) {
  const allPaths = useMemo(() => files.map((f) => f.path), [files]);
  const filesByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const [staged, setStaged] = useState<Set<string>>(() => new Set(allPaths));
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    setRollbackConfirm((current) => (current ? false : current));
  }, [allPaths, staged.size]);

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

  const canCommit = !busy && staged.size > 0 && (message.trim().length > 0 || amend);
  const canRollback = !rollbackBusy && staged.size > 0;

  const commit = async () => {
    setBusy(true);
    setError(null);
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
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rollbackChecked = async () => {
    if (!canRollback) {
      return;
    }
    if (!rollbackConfirm) {
      setRollbackConfirm(true);
      return;
    }
    setRollbackBusy(true);
    setError(null);
    try {
      for (const path of [...staged]) {
        const file = filesByPath.get(path);
        if (!file) {
          continue;
        }
        const indices = file.status === "added" ? [0] : file.hunks.map((_, i) => i).reverse();
        for (const hunkIndex of indices) {
          await daemon.request("diff.resolveHunk", {
            file: path,
            hunk_index: hunkIndex,
            resolution: "reject",
            task_id: taskId,
          });
        }
      }
      setRollbackConfirm(false);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          ref={(el) => el && (el.indeterminate = staged.size > 0 && staged.size < allPaths.length)}
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
              const pad = { paddingLeft: `${row.depth * 12 + 8}px` };

              if (row.node.path) {
                // Leaf (file) row
                const st = row.node.stat!;
                const s = STATUS[st.status];
                const on = staged.has(row.node.path);
                return (
                  <div
                    key={vi.key}
                    className={cn(
                      "group absolute left-0 top-0 flex h-7 w-full items-center gap-1.5 pr-2 text-xs",
                      selected === row.node.path
                        ? "bg-secondary text-foreground"
                        : "hover:bg-secondary/50",
                    )}
                    style={{ ...pad, transform: `translateY(${vi.start}px)` }}
                  >
                    <input
                      aria-label={`Stage ${row.node.path}`}
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle([row.node.path!], !on)}
                      className="size-3 shrink-0 accent-primary"
                    />
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono text-[11px] font-semibold",
                        s.color,
                      )}
                    >
                      {s.glyph}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelect(row.node.path!)}
                      title={row.node.path}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="truncate">{row.node.name}</span>
                      <span className="tnum ml-auto shrink-0 font-mono text-[10px]">
                        {st.adds > 0 && <span className="text-ok">+{st.adds}</span>}
                        {st.adds > 0 && st.dels > 0 && " "}
                        {st.dels > 0 && <span className="text-destructive">-{st.dels}</span>}
                      </span>
                    </button>
                  </div>
                );
              }

              // Folder row
              const paths = leaves(row.node);
              const folderStaged = paths.filter((p) => staged.has(p)).length;
              const state =
                folderStaged === 0 ? "off" : folderStaged === paths.length ? "on" : "some";
              const isOpen = openFolders.has(row.fKey!);
              return (
                <div
                  key={vi.key}
                  className="absolute left-0 top-0 flex h-7 w-full items-center gap-1.5 pr-2 text-xs text-muted-foreground"
                  style={{ ...pad, transform: `translateY(${vi.start}px)` }}
                >
                  <input
                    aria-label={`Stage ${row.node.name}`}
                    type="checkbox"
                    checked={state === "on"}
                    ref={(el) => el && (el.indeterminate = state === "some")}
                    onChange={() => toggle(paths, state !== "on")}
                    className="size-3 shrink-0 accent-primary"
                  />
                  <button
                    type="button"
                    onClick={() => toggleFolder(row.fKey!)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        isOpen && "rotate-90",
                      )}
                    />
                    <span className="truncate">{row.node.name}</span>
                    <span className="ml-1 shrink-0 text-[10px] text-muted-foreground/70">
                      {paths.length} files
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t bg-background/30 p-2.5">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          rows={3}
          className="min-h-20 w-full resize-none rounded-md border bg-background/70 px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/80 focus:ring-1 focus:ring-ring"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
              className="size-3 accent-primary"
            />
            amend
          </label>
          <Button
            type="button"
            size="sm"
            className="ml-auto h-7"
            disabled={!canCommit}
            onClick={commit}
          >
            <GitCommitVertical className="size-3.5" />
            {busy ? "…" : amend ? "Amend" : "Commit"}
          </Button>
        </div>
      </div>
    </div>
  );
}
