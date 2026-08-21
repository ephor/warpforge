import { ListTodo, TerminalSquare } from "lucide-react";

import { SurfaceTabs, type SurfaceTab } from "@/components/workspace";
import type { ProjectSurface } from "@/store/ui";

/**
 * The project page's surfaces, in the same bar the task workspace uses.
 * Files, Git and Pull Requests are planned neighbours; adding one is adding a
 * row here plus a panel, not another page.
 */
export const PROJECT_SURFACE_TABS: readonly SurfaceTab<ProjectSurface>[] = [
  { id: "backlog", label: "Backlog", icon: ListTodo },
  { id: "runtime", label: "Runtime", icon: TerminalSquare },
];

export interface ProjectSurfaceBarProps {
  activeSurface: ProjectSurface;
  onSurfaceChange: (surface: ProjectSurface) => void;
  tabs?: readonly SurfaceTab<ProjectSurface>[];
}

export function ProjectSurfaceBar({
  activeSurface,
  onSurfaceChange,
  tabs = PROJECT_SURFACE_TABS,
}: ProjectSurfaceBarProps) {
  return (
    <div className="flex h-9 min-w-0 items-center border-b border-border/70">
      <SurfaceTabs
        aria-label="Project surfaces"
        value={activeSurface}
        onValueChange={onSurfaceChange}
        tabs={tabs}
      />
    </div>
  );
}
