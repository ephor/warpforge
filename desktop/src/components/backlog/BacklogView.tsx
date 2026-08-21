import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { daemon } from "@/daemon";

import { BacklogList } from "./BacklogList";
import type { BacklogRowActions } from "./BacklogRow";
import { BacklogToolbar } from "./BacklogToolbar";
import { type BacklogParams, DEFAULT_BACKLOG_PARAMS, toWorkItem, type WorkItem } from "./types";

/**
 * ADR-0002: opening a project pulls its trackers once, gated by a staleness
 * window, and the Sync button is that same query refetched — so an automatic
 * pull and a manual refresh can never race into duplicate imports.
 */
const SYNC_STALE_MS = 5 * 60_000;

interface BacklogViewProps {
  project: string;
  onStartTask?: (item: WorkItem) => void;
  onOpenTask?: (taskId: string) => void;
  /** Row click: opens the item's details. */
  onOpenItem?: (item: WorkItem) => void;
}

export function BacklogView({ project, onStartTask, onOpenTask, onOpenItem }: BacklogViewProps) {
  const queryClient = useQueryClient();

  // Sorting and filtering are the daemon's job, so one object holds the whole
  // request and doubles as the query key. Storing the project alongside it
  // resets the view when the project changes, in the same render rather than
  // in an effect that would fire a request for the old filters first.
  const [state, setState] = React.useState({ project, params: DEFAULT_BACKLOG_PARAMS });
  if (state.project !== project) {
    setState({ project, params: DEFAULT_BACKLOG_PARAMS });
  }
  const params = state.params;

  /** Any change starts the listing over — the key changes, so page 0 is refetched. */
  const patch = React.useCallback((next: Partial<BacklogParams>) => {
    setState((current) => ({
      project: current.project,
      params: { ...current.params, ...next },
    }));
  }, []);
  const reset = React.useCallback(() => {
    setState((current) => ({ project: current.project, params: DEFAULT_BACKLOG_PARAMS }));
  }, []);

  const sync = useQuery({
    queryKey: ["backlog", project, "sync"],
    queryFn: () => daemon.importExternalWorkItems(project),
    staleTime: SYNC_STALE_MS,
    retry: false,
  });
  React.useEffect(() => {
    if (sync.error) {
      toast.error("Could not sync backlog", { description: sync.error.message });
    }
  }, [sync.error]);

  const list = useInfiniteQuery({
    queryKey: ["backlog", project, "list", params],
    queryFn: ({ pageParam }) =>
      daemon.listBacklog({
        project,
        page: pageParam,
        pageSize: params.pageSize,
        sortBy: params.sortBy,
        sortDesc: params.sortDesc,
        search: params.search,
        status: params.status ?? undefined,
        source: params.source ?? undefined,
        priority: params.priority ?? undefined,
      }),
    initialPageParam: 0,
    // The daemon reports whether more rows exist; trust that rather than
    // comparing counts, which a concurrent import would make wrong.
    getNextPageParam: (lastPage) => (lastPage.hasNextPage ? lastPage.page + 1 : undefined),
    // Wait for the pull to settle, so freshly imported rows are in the first
    // page rather than arriving as a second flash. `isFetched` is true after a
    // *failed* pull too: a dead tracker must not hide an existing backlog.
    enabled: sync.isFetched,
    staleTime: 10_000,
  });

  const syncNow = React.useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: ["backlog", project, "sync"] });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["backlog", project, "list"] }),
      queryClient.invalidateQueries({ queryKey: ["backlog", project, "count"] }),
    ]);
  }, [project, queryClient]);

  const items = React.useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.items.map(toWorkItem)),
    [list.data],
  );

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list;
  const loadMore = React.useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const actions = React.useMemo<BacklogRowActions>(
    () => ({
      onOpen: (item) => onOpenItem?.(item),
      onOpenTask,
      onStartTask,
    }),
    [onOpenItem, onOpenTask, onStartTask],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <BacklogToolbar
        project={project}
        params={params}
        onChange={patch}
        onReset={reset}
        onSync={() => void syncNow()}
        isSyncing={sync.isFetching}
      />
      <div className="min-h-0 flex-1">
        <BacklogList
          items={items}
          actions={actions}
          isLoading={list.isPending && !list.isError}
          isFetchingNextPage={isFetchingNextPage}
          hasNextPage={hasNextPage}
          onEndReached={loadMore}
          error={list.isError ? `Could not load backlog: ${list.error.message}` : undefined}
        />
      </div>
    </div>
  );
}
