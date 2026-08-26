import { AlertTriangle, PanelRightClose, PanelRightOpen } from "lucide-react";

/**
 * The Runtime toolbar row. It shows whichever service or port-forward is
 * selected rather than the word "Runtime": the tab above already says which
 * surface this is, so naming it again cost a row of height for nothing.
 */
export function RuntimeHeader({
  actionError,
  sidebarCollapsed,
  onToggleSidebar,
  children,
}: {
  actionError: string | null;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Identity of the selected target, from `RuntimeDetail`. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
      {children}
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
      <button
        type="button"
        className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-label={sidebarCollapsed ? "Expand runtime sidebar" : "Collapse runtime sidebar"}
        title={sidebarCollapsed ? "Expand runtime sidebar" : "Collapse runtime sidebar"}
        onClick={onToggleSidebar}
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
