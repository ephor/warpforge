import {
  EllipsisVertical,
  FolderGit2,
  Pencil,
  Plus,
  Radio,
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

import { daemon } from "../../daemon";
import type { Snapshot } from "../../protocol";

interface ProjectListProps {
  projects: Snapshot["projects"];
  selected: string;
  onSelect: (name: string) => void;
  runningByProject: Map<string, number>;
  hoveredProject: string | null;
  onRowMouseEnter: (name: string) => void;
  onRowMouseLeave: () => void;
  openMenu: string | null;
  onMenuOpenChange: (name: string | null) => void;
  onAddProject: () => void;
}

export function ProjectList({
  projects,
  selected,
  onSelect,
  runningByProject,
  hoveredProject,
  onRowMouseEnter,
  onRowMouseLeave,
  openMenu,
  onMenuOpenChange,
  onAddProject,
}: ProjectListProps) {
  return (
    <Card className="flex min-h-0 flex-col rounded-md border-border/80 bg-card shadow-none">
      <div className="flex h-10 items-center px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Projects
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 p-1.5">
          {projects.map((p) => {
            const active = p.name === selected;
            const up = runningByProject.get(p.name) ?? 0;
            return (
              <div
                key={p.name}
                onMouseEnter={() => onRowMouseEnter(p.name)}
                onMouseLeave={onRowMouseLeave}
                className={cn(
                  "relative flex h-8 items-center rounded px-2 text-sm transition-colors",
                  active ? "bg-secondary text-foreground" : "hover:bg-secondary/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(p.name)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {up > 0 && (
                    <span className="tnum flex items-center gap-1 text-xs text-ok">
                      <Radio className="size-3" />
                      {up}
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
                        className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground"
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
                          void daemon.removeProject(p.name);
                        }}
                      >
                        <Trash2 className="size-4" />
                        Delete
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
        className="m-1.5 h-7 gap-1.5 text-muted-foreground"
        onClick={onAddProject}
      >
        <Plus className="size-4" />
        Add Project
      </Button>
    </Card>
  );
}
