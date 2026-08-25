import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { daemon } from "@/daemon";
import { useUi } from "@/store/ui";

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
  // request and doubles as the query key. It lives in the UI store, per
  // project and persisted: how you read a board is a stance you hold, not
  // something to restate on every visit.
  const params = useUi((state) => state.backlogParamsByProject[project]) ?? DEFAULT_BACKLOG_PARAMS;
  const patchParams = useUi((state) => state.patchBacklogParams);
  const resetParams = useUi((state) => state.resetBacklogParams);

  /** Any change starts the listing over — the key changes, so page 0 is refetched. */
  const patch = React.useCallback(
    (next: Partial<BacklogParams>) => patchParams(project, next),
    [patchParams, project],
  );
  const reset = React.useCallback(() => resetParams(project), [project, resetParams]);

  // Names accumulate as rows load, so they are per project and reset with it —
  // in the same render as the switch, not in an effect that would first offer
  // the previous project's people.
  const [seen, setSeen] = React.useState<{ project: string; names: string[] }>({
    project,
    names: [],
  });
  if (seen.project !== project) setSeen({ project, names: [] });
  const seenAssignees = seen.names;

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
        assignee: params.assignee ?? undefined,
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

  // Names accumulate rather than being derived from `items`, because `items`
  // is the *filtered* listing: reading the options out of it meant picking one
  // assignee narrowed the rows, which then emptied the list of everyone else.
  React.useEffect(() => {
    setSeen((current) => {
      const merged = new Set(current.names);
      for (const item of items) if (item.assignee) merged.add(item.assignee);
      return merged.size === current.names.length
        ? current
        : { project: current.project, names: [...merged].sort((a, b) => a.localeCompare(b)) };
    });
  }, [items]);

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
        assignees={seenAssignees}
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
