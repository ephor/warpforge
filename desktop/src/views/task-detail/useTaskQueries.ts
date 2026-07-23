import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { FileDiff, FileDoc, ProjectFile, TaskDiff } from "../../protocol";
import { daemonQuery } from "../../query";

const EMPTY_PROJECT_FILES: ProjectFile[] = [];

export type ActiveTab = { kind: "changes" } | { kind: "file"; path: string };

export function useTaskQueries(
  taskId: string,
  activeFile: string | null,
  activeTab: ActiveTab,
  updatedAt: number,
) {
  const queryClient = useQueryClient();

  const diffQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<TaskDiff>("diff.get", { task_id: taskId }),
    queryKey: ["diff", taskId],
    refetchOnWindowFocus: "always",
  });
  const diff = diffQuery.data ?? null;

  const fileListQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<ProjectFile[]>("file.list", {
      include_ignored: true,
      task_id: taskId,
    }),
    queryKey: ["fileList", taskId, "all"],
  });
  const projectFiles = Array.isArray(fileListQuery.data) ? fileListQuery.data : EMPTY_PROJECT_FILES;
  const fileListError = fileListQuery.error?.message ?? null;

  const mentionFilesQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<ProjectFile[]>("file.list", { task_id: taskId }),
    queryKey: ["fileList", taskId, "tracked"],
  });
  const mentionFiles = Array.isArray(mentionFilesQuery.data)
    ? mentionFilesQuery.data
    : EMPTY_PROJECT_FILES;

  const fileContentsEnabled = Boolean(activeFile) && activeTab.kind === "file";
  const fileDocQuery = useQuery({
    enabled: fileContentsEnabled,
    placeholderData: keepPreviousData,
    queryFn: daemonQuery<FileDoc>("file.contents", {
      task_id: taskId,
      path: activeFile,
    }),
    queryKey: ["fileContents", taskId, activeFile],
    refetchOnWindowFocus: "always",
  });
  const fileDoc = fileContentsEnabled ? (fileDocQuery.data ?? null) : null;

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["diff", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["fileList", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["fileContents", taskId] });
  }, [queryClient, taskId, updatedAt]);

  return {
    diff,
    diffQuery,
    projectFiles,
    fileListError,
    mentionFiles,
    mentionFilesQuery,
    fileDoc,
    fileDocQuery,
    queryClient,
  };
}

export function useSplitFileQueries(
  taskId: string,
  files: FileDiff[],
  enabled: boolean,
  range: { start: number; end: number },
) {
  return useQueries({
    queries: files.map((file, index) => {
      const queryKey = ["fileContents", taskId, file.path] as const;
      const visible = index >= range.start && index <= range.end;
      return {
        enabled: enabled && visible,
        placeholderData: keepPreviousData,
        queryFn: daemonQuery<FileDoc>("file.contents", {
          task_id: taskId,
          path: file.path,
        }),
        queryKey,
        staleTime: 5 * 60 * 1000,
      };
    }),
  });
}
