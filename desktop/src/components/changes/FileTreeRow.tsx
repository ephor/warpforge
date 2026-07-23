import type { VirtualItem } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { leaves, STATUS, type FlatRow } from "./treeUtils";

interface FileTreeRowProps {
  row: FlatRow;
  vi: VirtualItem;
  staged: Set<string>;
  selected: string | null;
  openFolders: Set<string>;
  onToggle: (paths: string[], on: boolean) => void;
  onToggleFolder: (fk: string) => void;
  onSelect: (path: string) => void;
}

export function FileTreeRow({
  row,
  vi,
  staged,
  selected,
  openFolders,
  onToggle,
  onToggleFolder,
  onSelect,
}: FileTreeRowProps) {
  const pad = { paddingLeft: `${row.depth * 12 + 8}px` };

  if (row.node.path) {
    const st = row.node.stat!;
    const s = STATUS[st.status];
    const on = staged.has(row.node.path);
    return (
      <div
        key={vi.key}
        className={cn(
          "group absolute left-0 top-0 flex h-7 w-full items-center gap-1.5 pr-2 text-xs",
          selected === row.node.path ? "bg-secondary text-foreground" : "hover:bg-secondary/50",
        )}
        style={{ ...pad, transform: `translateY(${vi.start}px)` }}
      >
        <input
          aria-label={`Stage ${row.node.path}`}
          type="checkbox"
          checked={on}
          onChange={() => onToggle([row.node.path!], !on)}
          className="size-3 shrink-0 accent-primary"
        />
        <span
          className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", s.color)}
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

  const paths = leaves(row.node);
  const folderStaged = paths.filter((p) => staged.has(p)).length;
  const state = folderStaged === 0 ? "off" : folderStaged === paths.length ? "on" : "some";
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
        ref={(el) => {
          if (el) el.indeterminate = state === "some";
        }}
        onChange={() => onToggle(paths, state !== "on")}
        className="size-3 shrink-0 accent-primary"
      />
      <button
        type="button"
        onClick={() => onToggleFolder(row.fKey!)}
        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")}
        />
        <span className="truncate">{row.node.name}</span>
        <span className="ml-1 shrink-0 text-[10px] text-muted-foreground/70">
          {paths.length} files
        </span>
      </button>
    </div>
  );
}
