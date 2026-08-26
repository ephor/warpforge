import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { RefObject } from "react";

import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { ChangesRail } from "../../components/ChangesRail";
import type { EditHunk, FileDiff, HunkResolution, TaskDiff } from "../../protocol";
import type { DiffView } from "../../store/ui";
import { DiffWorkspace, type DiffWorkspaceHandle } from "./DiffWorkspace";

/**
 * Diff surface: `DiffWorkspace` plus `ChangesRail` side by side. The two
 * always render together here — Diff is no longer a tab shared with the
 * file editor, and the changes rail is no longer a separately-toggled panel.
 */
export function DiffSurface({
  diff,
  diffError,
  diffView,
  editable,
  localRes,
  onOpenFiles,
  onResolve,
  onSendToChat,
  onSetDiffView,
  taskId,
  project,
  selected,
  onSelect,
  commitExpanded,
  onCommitExpandedChange,
  onCommitted,
  onRefresh,
  diffWorkspaceRef,
}: {
  diff: TaskDiff | null;
  diffError: string | null;
  diffView: DiffView;
  editable: boolean;
  localRes: Record<string, HunkResolution>;
  onOpenFiles: () => void;
  onResolve: (file: string, hunkIndex: number, resolution: HunkResolution) => void;
  onSendToChat: (file: FileDiff) => void;
  onSetDiffView: (v: DiffView) => void;
  taskId: string;
  project: string;
  selected: string | null;
  onSelect: (path: string, hunks?: EditHunk[]) => void;
  commitExpanded: boolean;
  onCommitExpandedChange: (expanded: boolean) => void;
  onCommitted: () => void;
  onRefresh: () => void;
  diffWorkspaceRef: RefObject<DiffWorkspaceHandle | null>;
}) {
  const collapsed = useUi((s) => s.diffPanelCollapsed);
  const toggleCollapsed = useUi((s) => s.toggleDiffPanelCollapsed);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 items-center gap-2 border-b bg-background/25 px-2">
        {diff && (
          <span className="tnum text-xs text-muted-foreground">{diff.files.length} files</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border border-border/80 bg-background/30 p-0.5">
            {(["unified", "split"] as const).map((v) => (
              <button
                type="button"
                key={v}
                onClick={() => onSetDiffView(v)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs capitalize transition-colors",
                  diffView === v
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={collapsed ? "Expand changes panel" : "Collapse changes panel"}
            title={collapsed ? "Expand changes panel" : "Collapse changes panel"}
            onClick={toggleCollapsed}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {collapsed ? (
              <PanelRightOpen className="size-4" />
            ) : (
              <PanelRightClose className="size-4" />
            )}
          </button>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1">
          <DiffWorkspace
            ref={diffWorkspaceRef}
            diff={diff}
            diffError={diffError}
            diffView={diffView}
            editable={editable}
            localRes={localRes}
            onOpenFiles={onOpenFiles}
            onResolve={onResolve}
            onSendToChat={onSendToChat}
            taskId={taskId}
          />
        </div>
        {!collapsed && (
          <div className="w-64 shrink-0 border-l border-border/70">
            {diff ? (
              <ChangesRail
                project={project}
                files={diff.files}
                selected={selected}
                taskId={taskId}
                commitExpanded={commitExpanded}
                onCommitExpandedChange={onCommitExpandedChange}
                onCommitted={onCommitted}
                onRefresh={onRefresh}
                onSelect={onSelect}
              />
            ) : (
              <p className="p-3 text-sm text-muted-foreground">Loading changes…</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
