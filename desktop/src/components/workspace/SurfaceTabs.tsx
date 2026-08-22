import {
  FileDiff,
  FolderTree,
  ListTodo,
  Server,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type WorkspaceSurface = "files" | "diff" | "runtime" | "terminal" | "pipeline";

/**
 * Generic over the tab id so the same bar can drive a different set of
 * surfaces (the project page has its own), while the task workspace keeps
 * `WorkspaceSurface` as the default and stays exactly as typed before.
 */
export interface SurfaceTab<T extends string = WorkspaceSurface> {
  id: T;
  label: string;
  icon: LucideIcon;
  count?: React.ReactNode;
  disabled?: boolean;
}

export const DEFAULT_SURFACE_TABS: readonly SurfaceTab[] = [
  { id: "files", label: "Files", icon: FolderTree },
  { id: "diff", label: "Diff", icon: FileDiff },
  // Runtime is the services/port-forwards board. The interactive shell sits
  // beside it rather than inside it: nesting a tab row within a surface put
  // two rows of tabs over one pane and hid the terminal a level down.
  { id: "runtime", label: "Runtime", icon: Server },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  // "Pipeline", not "Plan": `plan` is one of the stage kinds this surface
  // lists, so the old name labelled the whole thing after one of its rows.
  { id: "pipeline", label: "Pipeline", icon: ListTodo },
];

export interface SurfaceTabsProps<T extends string = WorkspaceSurface> extends Omit<
  React.ComponentPropsWithoutRef<typeof TabsList>,
  "children"
> {
  value: T;
  onValueChange: (value: T) => void;
  tabs?: readonly SurfaceTab<T>[];
}

export function SurfaceTabs<T extends string = WorkspaceSurface>({
  className,
  onValueChange,
  // Only sound for the default `T`; any other tab id set must pass `tabs`.
  tabs = DEFAULT_SURFACE_TABS as readonly SurfaceTab<T>[],
  value,
  ...props
}: SurfaceTabsProps<T>) {
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
