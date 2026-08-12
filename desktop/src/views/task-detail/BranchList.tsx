import { Check, ChevronRight, GitBranch } from "lucide-react";
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
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
  onAction,
  onToggleFolder,
}: {
  localRows: BranchRow[];
  remoteRows: BranchRow[];
  searching: boolean;
  searchRows: BranchRow[];
  openFolders: Set<string>;
  current: string | null;
  onAction: (action: string, branch: string, remote: boolean) => void;
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
            onAction={onAction}
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
        onAction={onAction}
      />
      {remoteRows.length > 0 && (
        <BranchSection
          title="Remote branches"
          rows={remoteRows}
          openFolders={openFolders}
          onToggleFolder={onToggleFolder}
          remote
          current={current}
          onAction={onAction}
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
  onAction,
}: {
  title: string;
  rows: BranchRow[];
  openFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  remote?: boolean;
  current: string | null;
  onAction: (action: string, branch: string, remote: boolean) => void;
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
                onAction={onAction}
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
  onAction,
}: {
  row: BranchRow;
  remote?: boolean;
  current: string | null;
  onAction: (action: string, branch: string, remote: boolean) => void;
}) {
  const isCurrent = !remote && row.branch === current;
  const [menuOpen, setMenuOpen] = useState(false);
  const branch = row.branch ?? "";
  const rowRef = useRef<HTMLDivElement>(null);
  const openMenu = () => setMenuOpen((open) => !open);
  return (
    <div className="relative">
      <div
        ref={rowRef}
        className={cn(
          "group/row flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs",
          isCurrent ? "bg-accent text-foreground" : "hover:bg-accent/50",
        )}
        style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu();
        }}
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
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform", menuOpen && "rotate-90")}
        />
        <button
          type="button"
          onClick={openMenu}
          title={row.branch}
          className="min-w-0 flex-1 truncate font-mono text-left"
        >
          {row.label}
        </button>
      </div>
      {menuOpen && row.branch && (
        <BranchActionSubmenu
          branch={branch}
          anchorRef={rowRef}
          remote={remote}
          current={isCurrent}
          onAction={(action) => {
            setMenuOpen(false);
            onAction(action, branch, remote);
          }}
        />
      )}
    </div>
  );
}

function BranchActionSubmenu({
  branch,
  anchorRef,
  remote,
  current,
  onAction,
}: {
  branch: string;
  anchorRef: RefObject<HTMLDivElement | null>;
  remote: boolean;
  current: boolean;
  onAction: (action: string) => void;
}) {
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    const left = rect.right + 6 + width <= window.innerWidth
      ? rect.right + 6
      : Math.max(8, rect.left - width - 6);
    const top = Math.min(rect.top, Math.max(8, window.innerHeight - 420));
    setPosition({ top, left });
  }, [anchorRef]);

  const actions = remote
    ? [
        ["checkout-as-remote", "Checkout as local…"],
        ["create", `New Branch from '${branch}'…`],
        ["compare", "Compare or Show Diff with…"],
      ]
    : current
      ? [
          ["update", "Update"],
          ["rebase", "Rebase onto…"],
          ["merge", "Merge branch into…"],
          ["push", "Push…"],
          ["rename", "Rename…"],
        ]
      : [
          ["checkout", "Checkout"],
          ["create", `New Branch from '${branch}'…`],
          ["checkout-rebase", "Checkout and Rebase onto…"],
          ["checkout-update", "Checkout and Update"],
          ["compare", "Compare or Show Diff with…"],
          ["push", "Push…"],
          ["rename", "Rename…"],
          ["delete", "Delete…"],
        ];
  return createPortal(
    <div
      data-branch-submenu
      className="fixed z-[100] max-h-[min(420px,calc(100vh-1rem))] w-70 overflow-y-auto rounded-md border border-border bg-popover px-1 py-1 shadow-2xl"
      style={position}
    >
      {actions.map(([id, label]) => (
        <button
          type="button"
          key={id}
          onClick={() => onAction(id)}
          className={cn(
            "block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
            id === "delete" && "text-destructive hover:text-destructive",
          )}
        >
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
