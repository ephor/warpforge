import { Check, ChevronRight, GitBranch } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const [openBranch, setOpenBranch] = useState<string | null>(null);
  const toggleBranch = (branch: string | null) => {
    setOpenBranch((open) => (open === branch ? null : branch));
  };

  if (searching) {
    return (
      <div className="space-y-0.5">
        {searchRows.map((row) => (
          <BranchRowLine
            key={row.key}
            row={row}
            remote={row.remote}
            current={current}
            menuOpen={row.branch === openBranch}
            onAction={onAction}
            onToggleMenu={toggleBranch}
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
        openBranch={openBranch}
        onAction={onAction}
        onToggleMenu={toggleBranch}
      />
      {remoteRows.length > 0 && (
        <BranchSection
          title="Remote branches"
          rows={remoteRows}
          openFolders={openFolders}
          onToggleFolder={onToggleFolder}
          remote
          current={current}
          openBranch={openBranch}
          onAction={onAction}
          onToggleMenu={toggleBranch}
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
  openBranch,
  onAction,
  onToggleMenu,
}: {
  title: string;
  rows: BranchRow[];
  openFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  remote?: boolean;
  current: string | null;
  openBranch: string | null;
  onAction: (action: string, branch: string, remote: boolean) => void;
  onToggleMenu: (branch: string | null) => void;
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
                menuOpen={row.branch === openBranch}
                onAction={onAction}
                onToggleMenu={onToggleMenu}
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
  menuOpen,
  onAction,
  onToggleMenu,
}: {
  row: BranchRow;
  remote?: boolean;
  current: string | null;
  menuOpen: boolean;
  onAction: (action: string, branch: string, remote: boolean) => void;
  onToggleMenu: (branch: string | null) => void;
}) {
  const isCurrent = !remote && row.branch === current;
  const branch = row.branch ?? "";
  const openMenu = () => onToggleMenu(menuOpen ? null : branch);
  return (
    <div className="relative">
      <div
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
      <DropdownMenu
        open={menuOpen}
        modal={false}
        onOpenChange={(open) => onToggleMenu(open ? branch : null)}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={row.branch}
            className="absolute inset-0 z-10 cursor-pointer opacity-0"
            aria-label={`Actions for ${branch}`}
          />
        </DropdownMenuTrigger>
        <BranchActionSubmenu
          branch={branch}
          remote={remote}
          current={isCurrent}
          onAction={(action) => {
            onToggleMenu(null);
            onAction(action, branch, remote);
          }}
        />
      </DropdownMenu>
    </div>
  );
}

function BranchActionSubmenu({
  branch,
  remote,
  current,
  onAction,
}: {
  branch: string;
  remote: boolean;
  current: boolean;
  onAction: (action: string) => void;
}) {
  const actions = remote
    ? [
        ["checkout-as-remote", "Checkout as local…"],
        ["create", `New Branch from '${branch}'…`],
      ]
    : current
      ? [
          ["update", "Update"],
          ["rebase-main", "Rebase onto 'main'"],
          ["rebase", "Rebase onto…"],
          ["merge-main", "Merge 'main' into current"],
          ["merge", "Merge branch into…"],
          ["push", "Push…"],
          ["rename", "Rename…"],
        ]
      : [
          ["checkout", "Checkout"],
          ["create", `New Branch from '${branch}'…`],
          ["rebase-main", `Rebase '${branch}' onto 'main'`],
          ["rebase", `Rebase '${branch}' onto…`],
          ["checkout-update", "Checkout and Update"],
          ["push", "Push…"],
          ["rename", "Rename…"],
          ["delete", "Delete…"],
        ];
  return (
    <DropdownMenuPortal>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-72"
      >
        {actions.map(([id, label]) => (
          <DropdownMenuItem
            key={id}
            onSelect={() => onAction(id)}
            className={id === "delete" ? "text-destructive focus:text-destructive" : undefined}
          >
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuPortal>
  );
}
