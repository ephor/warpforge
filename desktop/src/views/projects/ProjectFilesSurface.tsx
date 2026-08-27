import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { daemon } from "@/daemon";
import type { FileDoc } from "@/protocol";
import { daemonQuery, useProjectFilesQuery } from "@/query";

import { FilesSurface, type OpenFileTab } from "../task-detail/FilesSurface";

export interface ProjectFilesSurfaceProps {
  project: string;
  rootPath: string;
}

/**
 * Browsing a project's checkout with no task open.
 *
 * Same tab strip/tree/editor as the task Files surface, but now editable:
 * saves go straight to the project checkout via `file.save {project}` and
 * commits via `git.commit {project}`. The gutter shows WebStorm-style
 * change bars (green for added/modified, triangle for deleted) with
 * click-to-revert and per-hunk commit.
 */
export function ProjectFilesSurface({ project, rootPath }: ProjectFilesSurfaceProps) {
  const [open, setOpen] = useState<{ tabs: string[]; active: string | null }>({
    tabs: [],
    active: null,
  });
  const filesQuery = useProjectFilesQuery(project, false);
  const files = useMemo(
    () => (Array.isArray(filesQuery.data) ? filesQuery.data : []),
    [filesQuery.data],
  );

  const docQuery = useQuery({
    enabled: Boolean(open.active),
    queryFn: daemonQuery<FileDoc>("file.contents", { project, path: open.active }),
    queryKey: ["projectFileContents", project, open.active ?? ""],
  });

  const [gotoLocation, setGotoLocation] = useState<{ path: string; line: number; column: number } | null>(null);
  const openFile = useCallback((path: string, location?: { line: number; column: number }) => {
    setOpen(({ tabs }) => ({
      active: path,
      tabs: tabs.includes(path) ? tabs : [...tabs, path],
    }));
    setGotoLocation(location ? { path, ...location } : null);
  }, []);

  // Closing the active tab falls back to the one opened before it, so the
  // editor is never left showing a file that is no longer in the strip.
  const closeFile = useCallback((path: string) => {
    setOpen(({ tabs, active }) => {
      const remaining = tabs.filter((tab) => tab !== path);
      return {
        active: active === path ? (remaining[remaining.length - 1] ?? null) : active,
        tabs: remaining,
      };
    });
  }, []);

  const openTabs = useMemo<OpenFileTab[]>(
    () =>
      open.tabs.map((path) => ({
        changed: files.find((file) => file.path === path)?.changed ?? false,
        path,
      })),
    [files, open.tabs],
  );

  const handleSave = useCallback(
    (content: string) => {
      if (!open.active) return;
      void daemon.request("file.save", { project, path: open.active, content, task_id: "" });
    },
    [open.active, project],
  );

  const searchSymbol = useCallback(
    (query: string) =>
      daemon.request("file.search", { limit: 50, query, task_id: "", project }) as Promise<
        import("@/protocol").SymbolMatch[]
      >,
    [project],
  );

  const openSymbol = useCallback(
    (path: string, line: number, column: number) => openFile(path, { line, column }),
    [openFile],
  );

  return (
    <FilesSurface
      projectFiles={files}
      fileListError={filesQuery.error?.message ?? null}
      activeFilePath={open.active}
      onSelectTreeFile={openFile}
      openTabs={openTabs}
      onSelectTab={openFile}
      onCloseTab={closeFile}
      fileDoc={docQuery.data ?? null}
      fileDocError={docQuery.error?.message ?? null}
      editable={true}
      taskId=""
      project={project}
      onSave={handleSave}
      rootPath={rootPath}
      onRefresh={() => void filesQuery.refetch()}
      onGotoDefinition={searchSymbol}
      onOpenSymbol={openSymbol}
      gotoLocation={gotoLocation}
      onGotoLocationHandled={() => setGotoLocation(null)}
    />
  );
}
