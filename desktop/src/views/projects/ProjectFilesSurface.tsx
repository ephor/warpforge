import { useQuery } from "@tanstack/react-query";
import { FileText, PanelRightClose, PanelRightOpen } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import type { FileDoc } from "@/protocol";
import { daemonQuery, useProjectFilesQuery } from "@/query";
import { useUi } from "@/store/ui";

import { ProjectFilesPanel } from "../task-detail/ProjectFilesPanel";

const CodeEditor = lazy(async () => ({
  default: (await import("../../components/CodeEditor")).CodeEditor,
}));

const noop = () => {};

export interface ProjectFilesSurfaceProps {
  project: string;
  rootPath: string;
}

/**
 * Read-only file browser for a project that has no task open. Same layout as
 * the task workspace's Files surface — preview left, tree on the right —
 * and the same collapse toggle, so the two surfaces are one habit. Saving
 * belongs to a task, so the editor here never writes.
 */
export function ProjectFilesSurface({ project, rootPath }: ProjectFilesSurfaceProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const collapsed = useUi((s) => s.filesPanelCollapsed);
  const toggleCollapsed = useUi((s) => s.toggleFilesPanelCollapsed);
  const filesQuery = useProjectFilesQuery(project);
  const files = Array.isArray(filesQuery.data) ? filesQuery.data : [];

  const docQuery = useQuery({
    enabled: Boolean(selected),
    queryFn: daemonQuery<FileDoc>("file.contents", { project, path: selected }),
    queryKey: ["projectFileContents", project, selected ?? ""],
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-9 min-w-0 items-center gap-2 border-b bg-background/25 px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {selected ?? "No file open"}
        </span>
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
          {!selected ? (
            <EmptyPreview text="Select a file to preview it." />
          ) : docQuery.error ? (
            <EmptyPreview text={`Could not read ${selected}: ${docQuery.error.message}`} />
          ) : !docQuery.data ? (
            <EmptyPreview text={`Loading ${selected}…`} />
          ) : (
            <Suspense fallback={<EmptyPreview text="Loading editor…" />}>
              <CodeEditor
                key={selected}
                doc={docQuery.data}
                editable={false}
                taskId=""
                onSave={noop}
              />
            </Suspense>
          )}
        </div>
        {!collapsed && (
          <div className="w-64 shrink-0 border-l border-border/70">
            <ProjectFilesPanel
              files={files}
              error={filesQuery.error?.message ?? null}
              selected={selected}
              onSelect={setSelected}
              rootPath={rootPath}
              onRefresh={() => void filesQuery.refetch()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPreview({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
      <FileText className="size-5 opacity-50" />
      {text}
    </div>
  );
}
