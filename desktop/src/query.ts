import { QueryClient } from "@tanstack/react-query";

import { daemon } from "./daemon";

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
