import { FileText, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { lazy, Suspense } from "react";

import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import type { FileDoc, FileRange, ProjectFile, SymbolMatch } from "../../protocol";
import { ProjectFilesPanel } from "./ProjectFilesPanel";

const CodeEditor = lazy(async () => ({
  default: (await import("../../components/CodeEditor")).CodeEditor,
}));

function EditorLoading() {
  return (
    <div className="flex h-full items-center px-4 text-sm text-muted-foreground">
      Loading editor…
    </div>
  );
}

export interface OpenFileTab {
  path: string;
  changed: boolean;
}

/**
 * Files surface: `ProjectFilesPanel` plus `CodeEditor` side by side, with a
 * tab strip for files opened from the tree, diff, or chat mentions.
 */
export function FilesSurface({
  projectFiles,
  fileListError,
  activeFilePath,
  onSelectTreeFile,
  openTabs,
  onSelectTab,
  onCloseTab,
  fileDoc,
  editable,
  taskId,
  onSave,
  rootPath,
  onRefresh,
  onGotoDefinition,
  onOpenSymbol,
  gotoLocation,
  onGotoLocationHandled,
  onAskFile,
}: {
  projectFiles: ProjectFile[];
  fileListError: string | null;
  activeFilePath: string | null;
  onSelectTreeFile: (path: string) => void;
  openTabs: OpenFileTab[];
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  fileDoc: FileDoc | null;
  editable: boolean;
  taskId: string;
  onSave: (content: string) => void;
  rootPath?: string;
  onRefresh: () => void;
  onGotoDefinition?: (query: string) => Promise<SymbolMatch[]>;
  onOpenSymbol?: (path: string, line: number, column: number) => void;
  gotoLocation?: { path: string; line: number; column: number } | null;
  onGotoLocationHandled?: () => void;
  /** Send a selected editor line range to the task chat as a file reference. */
  onAskFile?: (path: string, range: FileRange) => void;
}) {
  const collapsed = useUi((s) => s.filesPanelCollapsed);
  const toggleCollapsed = useUi((s) => s.toggleFilesPanelCollapsed);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-9 min-w-0 items-center gap-2 border-b bg-background/25 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {openTabs.length === 0 ? (
            <span className="px-1 text-xs text-muted-foreground">No file open</span>
          ) : (
            openTabs.map((f) => {
              const name = f.path.split("/").pop() ?? f.path;
              const active = activeFilePath === f.path;
              return (
                <div
                  key={f.path}
                  title={f.path}
                  className={cn(
                    "flex h-7 max-w-[240px] shrink-0 items-center overflow-hidden rounded-md border font-mono text-xs",
                    active
                      ? "border-border bg-secondary text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectTab(f.path)}
                    className="flex min-w-0 items-center gap-1.5 px-2"
                  >
                    <FileText
                      className={cn(
                        "size-3.5 shrink-0",
                        f.changed ? "text-info" : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate">{name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${name}`}
                    onClick={() => onCloseTab(f.path)}
                    className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <button
          type="button"
          aria-label={collapsed ? "Expand file panel" : "Collapse file panel"}
          title={collapsed ? "Expand file panel" : "Collapse file panel"}
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
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {!activeFilePath ? (
            <p className="p-3 text-sm text-muted-foreground">Select a file to open it.</p>
          ) : fileDoc ? (
            <Suspense fallback={<EditorLoading />}>
              <CodeEditor
                key={`${fileDoc.path}:${editable}`}
                doc={fileDoc}
                editable={editable}
                taskId={taskId}
                onSave={onSave}
                onGotoDefinition={onGotoDefinition}
                onOpenSymbol={onOpenSymbol}
                gotoLocation={gotoLocation?.path === fileDoc.path ? gotoLocation : undefined}
                onGotoLocationHandled={onGotoLocationHandled}
                onAskFile={onAskFile}
              />
            </Suspense>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">Loading file…</p>
          )}
        </div>
        {!collapsed && (
          <div className="w-64 shrink-0 border-l border-border/70">
            <ProjectFilesPanel
              files={projectFiles}
              error={fileListError}
              selected={activeFilePath}
              onSelect={onSelectTreeFile}
              rootPath={rootPath}
              onRefresh={onRefresh}
              taskId={taskId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
