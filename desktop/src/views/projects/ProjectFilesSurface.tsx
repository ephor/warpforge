import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type { FileDoc } from "@/protocol";
import { daemonQuery, useProjectFilesQuery } from "@/query";

import { FilesSurface, type OpenFileTab } from "../task-detail/FilesSurface";

const noop = () => {};

export interface ProjectFilesSurfaceProps {
  project: string;
  rootPath: string;
}

/**
 * Browsing a project's checkout with no task open.
 *
 * This is the task workspace's Files surface, given a project instead of a
 * task: same tab strip, same tree, same editor. Read-only on purpose — a save
 * belongs to a task — so `taskId` is empty, which is also what keeps the
 * tree's create/rename/delete actions out of the context menu.
 */
export function ProjectFilesSurface({ project, rootPath }: ProjectFilesSurfaceProps) {
  const [open, setOpen] = useState<{ tabs: string[]; active: string | null }>({
    tabs: [],
    active: null,
  });
  const filesQuery = useProjectFilesQuery(project);
  const files = useMemo(
    () => (Array.isArray(filesQuery.data) ? filesQuery.data : []),
    [filesQuery.data],
  );

  const docQuery = useQuery({
    enabled: Boolean(open.active),
    queryFn: daemonQuery<FileDoc>("file.contents", { project, path: open.active }),
    queryKey: ["projectFileContents", project, open.active ?? ""],
  });

  const openFile = useCallback((path: string) => {
    setOpen(({ tabs }) => ({
      active: path,
      tabs: tabs.includes(path) ? tabs : [...tabs, path],
    }));
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
      editable={false}
      taskId=""
      onSave={noop}
      rootPath={rootPath}
      onRefresh={() => void filesQuery.refetch()}
    />
  );
}
