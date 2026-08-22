import { QueryClient, useQuery } from "@tanstack/react-query";

import { daemon } from "./daemon";
import type { ProjectFile } from "./protocol";

/**
 * TanStack Query is used ONLY for on-demand daemon *reads* — diff, file
 * contents/list, branches, service logs, sessions. The daemon's live state
 * (the snapshot + incremental events projected in daemon.ts) stays in the push
 * store: that is already a server-driven cache and does not belong here.
 *
 * Bridge between the two worlds: read keys bake in the task's server-side
 * `updatedAt`, so a `task.updated` event changes the key and refetches on its
 * own; mutations additionally invalidate the affected keys for immediacy.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Nothing to poll — the daemon pushes changes. A read stays fresh until
      // Its key changes (updatedAt) or a mutation invalidates it. Window focus
      // Still refetches, to catch edits made outside the app.
      staleTime: 5_000,
      retry: false,
      refetchOnWindowFocus: true,
    },
  },
});

/** A queryFn that calls a daemon RPC and returns its typed result. */
export const daemonQuery =
  <T>(method: string, params?: unknown) =>
  () =>
    daemon.request(method, params) as Promise<T>;

/** Project file list for a task, shared with the editor tree's query key so
 *  the quick-open palette and FilesSurface stay in the same cache. */
export function useProjectFileListQuery(taskId: string | null, includeIgnored = true) {
  return useQuery({
    enabled: Boolean(taskId),
    placeholderData: (prev: ProjectFile[] | undefined) => prev,
    queryFn: daemonQuery<ProjectFile[]>("file.list", {
      include_ignored: includeIgnored,
      task_id: taskId,
    }),
    queryKey: ["fileList", taskId ?? "", includeIgnored ? "all" : "tracked"],
  });
}

/** The same listing for a project with no task attached — the project page's
 *  Files surface reads the registered checkout directly. */
export function useProjectFilesQuery(project: string | null, includeIgnored = true) {
  return useQuery({
    enabled: Boolean(project),
    placeholderData: (prev: ProjectFile[] | undefined) => prev,
    queryFn: daemonQuery<ProjectFile[]>("file.list", {
      include_ignored: includeIgnored,
      project,
    }),
    queryKey: ["projectFileList", project ?? "", includeIgnored ? "all" : "tracked"],
  });
}
