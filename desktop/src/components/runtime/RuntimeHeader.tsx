import { AlertTriangle, PanelRightClose, PanelRightOpen, Server, TerminalSquare } from "lucide-react";

import { TabsList, TabsTrigger } from "../ui/tabs";

export function RuntimeHeader({
  actionError,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  actionError: string | null;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <TerminalSquare className="size-3.5 text-muted-foreground" />
      <span className="text-xs font-medium text-muted-foreground">Runtime</span>
      {actionError && (
        <span
          role="alert"
          aria-live="assertive"
          className="flex items-center gap-1 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive"
          title={actionError}
        >
          <AlertTriangle className="size-3" />
          <span className="max-w-40 truncate">{actionError}</span>
        </span>
      )}
      <div className="ml-auto">
        <TabsList>
          <TabsTrigger value="services">
            <Server className="size-3.5" />
            Services
          </TabsTrigger>
          <TabsTrigger value="terminal">
            <TerminalSquare className="size-3.5" />
            Terminal
          </TabsTrigger>
        </TabsList>
      </div>
      <button
        type="button"
        aria-label={sidebarCollapsed ? "Expand runtime sidebar" : "Collapse runtime sidebar"}
        title={sidebarCollapsed ? "Expand runtime sidebar" : "Collapse runtime sidebar"}
        onClick={onToggleSidebar}
        className="ml-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {sidebarCollapsed ? (
          <PanelRightOpen className="size-4" />
        ) : (
          <PanelRightClose className="size-4" />
        )}
      </button>
    </div>
  );
}
