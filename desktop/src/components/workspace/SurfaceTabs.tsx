import { FileDiff, FolderTree, ListTodo, TerminalSquare, type LucideIcon } from "lucide-react";
import * as React from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type WorkspaceSurface = "files" | "diff" | "runtime" | "pipeline";

export interface SurfaceTab {
  id: WorkspaceSurface;
  label: string;
  icon: LucideIcon;
  count?: React.ReactNode;
  disabled?: boolean;
}

export const DEFAULT_SURFACE_TABS: readonly SurfaceTab[] = [
  { id: "files", label: "Files", icon: FolderTree },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "runtime", label: "Runtime", icon: TerminalSquare },
  // "Pipeline", not "Plan": `plan` is one of the stage kinds this surface
  // lists, so the old name labelled the whole thing after one of its rows.
  { id: "pipeline", label: "Pipeline", icon: ListTodo },
];

export interface SurfaceTabsProps extends Omit<
  React.ComponentPropsWithoutRef<typeof TabsList>,
  "children"
> {
  value: WorkspaceSurface;
  onValueChange: (value: WorkspaceSurface) => void;
  tabs?: readonly SurfaceTab[];
}

export function SurfaceTabs({
  className,
  onValueChange,
  tabs = DEFAULT_SURFACE_TABS,
  value,
  ...props
}: SurfaceTabsProps) {
  const { "aria-label": ariaLabel, ...listProps } = props;

  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => {
        const tab = tabs.find((candidate) => candidate.id === nextValue);
        if (tab) onValueChange(tab.id);
      }}
      className="min-w-0"
    >
      <TabsList
        {...listProps}
        aria-label={ariaLabel ?? "Workspace surfaces"}
        className={cn(
          "flex h-9 min-w-0 justify-start gap-0 overflow-x-auto rounded-none border-0 bg-transparent p-0",
          className,
        )}
      >
        {tabs.map(({ count, disabled, icon: Icon, id, label }) => (
          <TabsTrigger
            key={id}
            value={id}
            disabled={disabled}
            className="group h-9 shrink-0 rounded-none border-b-2 border-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <Icon aria-hidden className="size-3.5" />
            {label}
            {count != null && (
              <span className="tnum text-[10px] text-muted-foreground group-data-[state=active]:text-primary">
                {count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
