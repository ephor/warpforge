import { FocusButton, SurfaceTabs, type SurfaceTab } from "@/components/workspace";

import type { TaskSurface } from "../../store/ui";

export interface TaskSurfaceTabsProps {
  activeSurface: TaskSurface;
  onSurfaceChange: (surface: TaskSurface) => void;
  tabs?: readonly SurfaceTab[];
  focused: boolean;
  focusLabel: string;
  onToggleFocus: () => void;
}

/**
 * Compact surface bar for the task workspace pane: Files/Diff/Runtime/Plan
 * tabs (icons + optional counts) plus the maximize/restore control for the
 * pane. Presentational only — TaskDetail owns the surface data and layout.
 */
export function TaskSurfaceTabs({
  activeSurface,
  onSurfaceChange,
  tabs,
  focused,
  focusLabel,
  onToggleFocus,
}: TaskSurfaceTabsProps) {
  return (
    <div className="flex h-9 min-w-0 items-center gap-1 border-b border-border/70 pr-1">
      <div className="min-w-0 flex-1">
        <SurfaceTabs value={activeSurface} onValueChange={onSurfaceChange} tabs={tabs} />
      </div>
      <FocusButton focused={focused} label={focusLabel} onClick={onToggleFocus} />
    </div>
  );
}
