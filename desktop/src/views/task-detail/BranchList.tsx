import { Check, ChevronRight, GitBranch, MoreHorizontal } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "@/lib/utils";

import type { BranchRow } from "./branchTree";

/**
 * WebStorm-style branch list: folders from `/`-separated names, local and
 * remote sections, and a hover-chevron that opens the action menu.
 */
export function BranchList({
  localRows,
  remoteRows,
  searching,
  searchRows,
  openFolders,
  current,
  onSwitch,
  onOpenMenu,
  onToggleFolder,
}: {
  localRows: BranchRow[];
  remoteRows: BranchRow[];
  searching: boolean;
  searchRows: BranchRow[];
  openFolders: Set<string>;
  current: string | null;
  onSwitch: (branch: string) => void;
  onOpenMenu: (e: MouseEvent, branch: string) => void;
  onToggleFolder: (key: string) => void;
}) {
  if (searching) {
    return (
      <div className="space-y-0.5">
        {searchRows.map((row) => (
          <BranchRowLine
            key={row.key}
            row={row}
            remote={row.remote}
            current={current}
            onSwitch={onSwitch}
            onOpenMenu={onOpenMenu}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <BranchSection
        title="Local branches"
        rows={localRows}
        openFolders={openFolders}
        onToggleFolder={onToggleFolder}
        current={current}
        onSwitch={onSwitch}
        onOpenMenu={onOpenMenu}
      />
      {remoteRows.length > 0 && (
        <BranchSection
          title="Remote branches"
          rows={remoteRows}
          openFolders={openFolders}
          onToggleFolder={onToggleFolder}
          remote
          current={current}
          onSwitch={onSwitch}
          onOpenMenu={onOpenMenu}
        />
      )}
    </div>
  );
}

function BranchSection({
  title,
  rows,
  openFolders,
  onToggleFolder,
  remote = false,
  current,
  onSwitch,
  onOpenMenu,
}: {
  title: string;
  rows: BranchRow[];
  openFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  remote?: boolean;
  current: string | null;
  onSwitch: (branch: string) => void;
  onOpenMenu: (e: MouseEvent, branch: string) => void;
}) {
  return (
    <div>
      <div className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">None</p>
      ) : (
        <div className="relative">
          {rows.map((row) => {
            if (!row.branch) {
              const isOpen = openFolders.has(row.fKey!);
              return (
                <button
                  type="button"
                  key={row.key}
                  onClick={() => onToggleFolder(row.fKey!)}
                  className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50"
                  style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
                >
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                  <span className="truncate">{row.label}</span>
                </button>
              );
            }
            return (
              <BranchRowLine
                key={row.key}
                row={row}
                remote={remote}
                current={current}
                onSwitch={onSwitch}
                onOpenMenu={onOpenMenu}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function BranchRowLine({
  row,
  remote = false,
  current,
  onSwitch,
  onOpenMenu,
}: {
  row: BranchRow;
  remote?: boolean;
  current: string | null;
  onSwitch: (branch: string) => void;
  onOpenMenu: (e: MouseEvent, branch: string) => void;
}) {
  const isCurrent = !remote && row.branch === current;
  return (
    <div
      className={cn(
        "group/row flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs",
        isCurrent ? "bg-accent text-foreground" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
      onContextMenu={(e) => row.branch && onOpenMenu(e, row.branch)}
    >
      {remote ? (
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground/60" />
      ) : (
        <Check
          className={cn(
            "size-3.5 shrink-0",
            isCurrent ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      <button
        type="button"
        disabled={remote}
        onClick={() => row.branch && !remote && onSwitch(row.branch)}
        title={row.branch}
        className="min-w-0 flex-1 truncate font-mono text-left disabled:cursor-default"
      >
        {row.label}
      </button>
      {row.branch && (
        <button
          type="button"
          aria-label={`Actions for ${row.branch}`}
          title="Actions"
          onClick={(e) => onOpenMenu(e, row.branch!)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground group-hover/row:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      )}
    </div>
  );
}
