import {
  EllipsisVertical,
  FolderGit2,
  Pencil,
  Plus,
  Radio,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import type { Snapshot } from "../../protocol";

interface ProjectListProps {
  projects: Snapshot["projects"];
  selected: string;
  onSelect: (name: string) => void;
  runningByProject: Map<string, number>;
  terminalCountsByProject: Map<string, number>;
  hoveredProject: string | null;
  onRowMouseEnter: (name: string) => void;
  onRowMouseLeave: () => void;
  openMenu: string | null;
  onMenuOpenChange: (name: string | null) => void;
  onAddProject: () => void;
  onRemoveProject: (name: string) => void;
}

export function ProjectList({
  projects,
  selected,
  onSelect,
  runningByProject,
  terminalCountsByProject,
  hoveredProject,
  onRowMouseEnter,
  onRowMouseLeave,
  openMenu,
  onMenuOpenChange,
  onAddProject,
  onRemoveProject,
}: ProjectListProps) {
  return (
    <Card className="flex min-h-0 flex-col rounded-md border-border/80 bg-card shadow-none">
      <div className="flex h-10 items-center gap-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Projects</span>
        <span className="tnum text-[11px] font-normal tracking-normal text-muted-foreground/70">
          {projects.length}
        </span>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 p-1.5" role="list" aria-label="Projects">
          {projects.map((p) => {
            const active = p.name === selected;
            const up = runningByProject.get(p.name) ?? 0;
            const terminalCount = terminalCountsByProject.get(p.name) ?? 0;
            return (
              <div
                key={p.name}
                role="listitem"
                onMouseEnter={() => onRowMouseEnter(p.name)}
                onMouseLeave={onRowMouseLeave}
                onFocus={() => onRowMouseEnter(p.name)}
                className={cn(
                  "group relative flex min-h-10 items-center rounded px-1.5 text-sm transition-colors",
                  active ? "bg-secondary text-foreground" : "hover:bg-secondary/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(p.name)}
                  aria-label={`Select project ${p.name}`}
                  aria-current={active ? "page" : undefined}
                  className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {up > 0 && (
                    <span
                      className="tnum flex items-center gap-1 text-xs text-ok"
                      aria-label={`${up} running service${up === 1 ? "" : "s"}`}
                    >
                      <Radio className="size-3" />
                      {up}
                    </span>
                  )}
                  {terminalCount > 0 && (
                    <span
                      className="tnum flex items-center gap-1 text-xs text-primary"
                      aria-label={`${terminalCount} active terminal${terminalCount === 1 ? "" : "s"}`}
                    >
                      <SquareTerminal className="size-3" />
                      {terminalCount}
                    </span>
                  )}
                </button>
                {(hoveredProject === p.name || openMenu === p.name) && (
                  <DropdownMenu
                    open={openMenu === p.name}
                    onOpenChange={(open) => onMenuOpenChange(open ? p.name : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Project menu"
                        title={`Actions for ${p.name}`}
                        className="ml-1 flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <EllipsisVertical className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="right">
                      <DropdownMenuItem disabled>
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => {
                          onMenuOpenChange(null);
                          onRemoveProject(p.name);
                        }}
                      >
                        <Trash2 className="size-4" />
                        Remove project
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <Separator />
      <Button
        variant="ghost"
        size="sm"
        className="m-1.5 h-8 gap-1.5 text-muted-foreground"
        onClick={onAddProject}
      >
        <Plus className="size-4" />
        Add Project
      </Button>
    </Card>
  );
}
