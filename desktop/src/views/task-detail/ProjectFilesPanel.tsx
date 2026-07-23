import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, FileText } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { getFileIconUrl } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";

import type { ProjectFile } from "../../protocol";

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
}: {
  files: ProjectFile[];
  error: string | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const root = useMemo(() => buildProjectTree(files), [files]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

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
                          row.node.changed ? "text-sky-400" : "text-muted-foreground",
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
    </div>
  );
}
