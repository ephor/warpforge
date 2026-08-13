import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, FileText } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";

import { getFileIconUrl } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";

import {
  type ContextMenuItemOrSeparator,
  showContextMenu,
  useNativeContextMenu,
} from "../../hooks/useNativeContextMenu";
import type { ProjectFile } from "../../protocol";
import { FILE_REF_MIME } from "../../lib/composerMentions";
import { projectFileParentFolders } from "./projectFileTree";
import {
  FileSystemActionDialog,
  type FileSystemAction,
} from "./FileSystemActionDialog";

export interface ProjectTreeNode {
  name: string;
  path?: string;
  changed?: boolean;
  children: Map<string, ProjectTreeNode>;
}

export function buildProjectTree(files: ProjectFile[]): ProjectTreeNode {
  const root: ProjectTreeNode = { children: new Map(), name: "" };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), name: part };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.path = f.path;
        child.changed = f.changed;
      }
      node = child;
    });
  }
  return root;
}

function projectFolderKey(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

export interface ProjectFlatRow {
  key: string;
  node: ProjectTreeNode;
  depth: number;
  fKey?: string;
}

function flattenProjectTree(
  node: ProjectTreeNode,
  depth: number,
  parentPath: string,
  openFolders: Set<string>,
  out: ProjectFlatRow[],
): void {
  const kids = [...node.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
  for (const child of kids) {
    if (child.path) {
      out.push({ key: child.path, node: child, depth });
    } else {
      const fk = projectFolderKey(parentPath, child.name);
      out.push({ key: `f:${fk}`, node: child, depth, fKey: fk });
      if (openFolders.has(fk)) {
        flattenProjectTree(child, depth + 1, fk, openFolders, out);
      }
    }
  }
}

export const PROJECT_ROW_HEIGHT = 28;

export function ProjectFilesPanel({
  files,
  error,
  selected,
  onSelect,
  taskId,
  rootPath,
  onRefresh,
}: {
  files: ProjectFile[];
  error: string | null;
  selected: string | null;
  onSelect: (path: string) => void;
  taskId?: string;
  rootPath?: string;
  onRefresh?: () => void;
}) {
  const root = useMemo(() => buildProjectTree(files), [files]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastRevealedFileRef = useRef<string | null>(null);

  const rows = useMemo(() => {
    const out: ProjectFlatRow[] = [];
    flattenProjectTree(root, 0, "", openFolders, out);
    return out;
  }, [root, openFolders]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => PROJECT_ROW_HEIGHT,
    getScrollElement: () => scrollRef.current,
    overscan: 20,
  });

  useEffect(() => {
    if (!selected) return;
    const parents = projectFileParentFolders(selected);
    if (parents.length === 0) return;
    setOpenFolders((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const folder of parents) {
        if (!next.has(folder)) {
          next.add(folder);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [selected]);

  useEffect(() => {
    if (!selected || lastRevealedFileRef.current === selected) {
      return;
    }
    const index = rows.findIndex((row) => row.node.path === selected);
    if (index < 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(index, { align: "auto" });
      lastRevealedFileRef.current = selected;
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, selected, virtualizer]);

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

  const requestId = useRef(`project-files`).current;
  const targetRef = useRef<{ path?: string; fKey?: string }>({});
  const [fileAction, setFileAction] = useState<FileSystemAction | null>(null);

  const openExternalPath = useCallback(async (path: string, reveal: boolean) => {
    if (!("__TAURI_INTERNALS__" in window) || !rootPath) return;
    const absolute = `${rootPath.replace(/\/+$/, "")}/${path}`;
    const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
    if (reveal) await revealItemInDir(absolute);
    else await openPath(absolute);
  }, [rootPath]);

  const menuHandlers = useMemo(
    () =>
      new Map<string, () => void>([
        [
          "open",
          () => {
            const t = targetRef.current;
            if (t.path) onSelect(t.path);
          },
        ],
        [
          "copy",
          () => {
            const t = targetRef.current;
            if (t.path) void navigator.clipboard.writeText(t.path);
          },
        ],
        ["reveal", () => {
          const t = targetRef.current;
          if (t.path) void openExternalPath(t.path, true);
        }],
        ["terminal", () => {
          const t = targetRef.current;
          if (t.path) void openExternalPath(t.path, false);
        }],
        ["refresh", () => onRefresh?.()],
        ["new-file", () => {
          const t = targetRef.current;
          setFileAction({ kind: "create-file", parent: t.fKey ?? t.path?.split("/").slice(0, -1).join("/") ?? "" });
        }],
        ["new-folder", () => {
          const t = targetRef.current;
          setFileAction({ kind: "create-folder", parent: t.fKey ?? t.path?.split("/").slice(0, -1).join("/") ?? "" });
        }],
        ["rename", () => {
          const t = targetRef.current;
          if (t.path) setFileAction({ kind: "rename", path: t.path });
        }],
        ["delete", () => {
          const t = targetRef.current;
          if (t.path || t.fKey) setFileAction({ kind: "delete", path: t.path ?? t.fKey! });
        }],
        [
          "expand",
          () => {
            const t = targetRef.current;
            if (t.fKey && !openFolders.has(t.fKey)) toggleFolder(t.fKey);
          },
        ],
        [
          "collapse",
          () => {
            const t = targetRef.current;
            if (t.fKey && openFolders.has(t.fKey)) toggleFolder(t.fKey);
          },
        ],
      ]),
    [onRefresh, onSelect, openExternalPath, openFolders, toggleFolder],
  );
  useNativeContextMenu(requestId, menuHandlers);

  const onRowContextMenu = (e: MouseEvent, path?: string, fKey?: string) => {
    e.preventDefault();
    e.stopPropagation();
    targetRef.current = { path, fKey };
    const items: ContextMenuItemOrSeparator[] = path
      ? [
          { type: "item", id: "open", label: "Open" },
          { type: "item", id: "copy", label: "Copy Path" },
          { type: "item", id: "reveal", label: "Reveal in Finder" },
          { type: "item", id: "terminal", label: "Open in Default App" },
          { type: "separator" },
          { type: "item", id: "new-file", label: "New File…" },
          { type: "item", id: "new-folder", label: "New Folder…" },
          { type: "item", id: "rename", label: "Rename…" },
          { type: "item", id: "delete", label: "Delete…" },
          { type: "separator" },
          { type: "item", id: "refresh", label: "Refresh" },
        ]
      : fKey
        ? [
            {
              type: "item",
              id: openFolders.has(fKey) ? "collapse" : "expand",
              label: openFolders.has(fKey) ? "Collapse" : "Expand",
            },
            { type: "item", id: "copy", label: "Copy Path" },
            { type: "item", id: "reveal", label: "Reveal in Finder" },
            { type: "item", id: "terminal", label: "Open in Default App" },
            { type: "separator" },
            { type: "item", id: "new-file", label: "New File…" },
            { type: "item", id: "new-folder", label: "New Folder…" },
            { type: "item", id: "rename", label: "Rename…" },
            { type: "item", id: "delete", label: "Delete…" },
            { type: "separator" },
            { type: "item", id: "refresh", label: "Refresh" },
          ]
        : [];
    void showContextMenu({ requestId, items });
  };

  const onRowDragStart = (e: DragEvent, path: string) => {
    e.dataTransfer.setData(FILE_REF_MIME, path);
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "copy";
    const tile = document.createElement("div");
    tile.textContent = path.split("/").pop() ?? path;
    Object.assign(tile.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "9999",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "4px 10px",
      borderRadius: "6px",
      background: "var(--accent)",
      color: "var(--accent-foreground)",
      border: "1px solid var(--border)",
      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      fontSize: "12px",
      fontWeight: "500",
      fontFamily: "var(--font-mono, monospace)",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      userSelect: "none",
    });
    document.body.appendChild(tile);
    e.dataTransfer.setDragImage(tile, 12, 12);
    e.currentTarget.addEventListener("dragend", () => tile.remove(), { once: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 items-center border-b px-3 text-sm font-semibold">Files</div>
      {error && <p className="border-b px-3 py-2 text-xs text-destructive">{error}</p>}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1.5">
        {rows.length === 0 && !error ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No files found.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const pad = { paddingLeft: `${row.depth * 12 + 10}px` };

              if (row.node.path) {
                const iconUrl = getFileIconUrl(row.node.name);
                return (
                  <button
                    key={vi.key}
                    type="button"
                    style={{ ...pad, transform: `translateY(${vi.start}px)` }}
                    onClick={() => onSelect(row.node.path!)}
                    onContextMenu={(e) => onRowContextMenu(e, row.node.path)}
                    draggable
                    onDragStart={(e) => onRowDragStart(e, row.node.path!)}
                    title={row.node.path}
                    className={cn(
                      "absolute left-0 top-0 flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs",
                      selected === row.node.path
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                    )}
                  >
                    {iconUrl ? (
                      <img src={iconUrl} alt="" aria-hidden className="size-3.5 shrink-0" />
                    ) : (
                      <FileText
                        className={cn(
                          "size-3.5 shrink-0",
                          row.node.changed ? "text-info" : "text-muted-foreground",
                        )}
                      />
                    )}
                    <span className="truncate">{row.node.name}</span>
                  </button>
                );
              }

              const isOpen = openFolders.has(row.fKey!);
              return (
                <button
                  key={vi.key}
                  type="button"
                  style={{ ...pad, transform: `translateY(${vi.start}px)` }}
                  onClick={() => toggleFolder(row.fKey!)}
                  onContextMenu={(e) => onRowContextMenu(e, undefined, row.fKey)}
                  className="absolute left-0 top-0 flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      !isOpen && "-rotate-90",
                    )}
                  />
                  <span className="truncate">{row.node.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <FileSystemActionDialog
        action={fileAction}
        taskId={taskId ?? ""}
        onComplete={() => onRefresh?.()}
        onClose={() => setFileAction(null)}
      />
    </div>
  );
}
