import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCoreRowModel,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";

import { daemon } from "@/daemon";

import { BacklogPagination } from "./BacklogPagination";
import { BacklogTable } from "./BacklogTable";
import { BacklogToolbar } from "./BacklogToolbar";
import { backlogColumns } from "./columns";
import {
  type BacklogParams,
  type BacklogSortKey,
  DEFAULT_BACKLOG_PARAMS,
  toWorkItem,
  type WorkItem,
} from "./types";

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
}

export function BacklogView({ project, onStartTask, onOpenTask }: BacklogViewProps) {
  const queryClient = useQueryClient();

  // Paging/sorting/filtering are all the daemon's job, so one object holds the
  // whole request and doubles as the query key. Storing the project alongside
  // it resets the view when the project changes, in the same render rather than
  // in an effect that would fire a request for the old page first.
  const [state, setState] = React.useState({ project, params: DEFAULT_BACKLOG_PARAMS });
  if (state.project !== project) {
    setState({ project, params: DEFAULT_BACKLOG_PARAMS });
  }
  const params = state.params;

  /** Every change but the page itself invalidates the page you are looking at. */
  const patch = React.useCallback((next: Partial<BacklogParams>) => {
    setState((current) => ({
      project: current.project,
      params: { ...current.params, page: 0, ...next },
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

  const list = useQuery({
    queryKey: ["backlog", project, "list", params],
    queryFn: () =>
      daemon.listBacklog({
        project,
        page: params.page,
        pageSize: params.pageSize,
        sortBy: params.sortBy,
        sortDesc: params.sortDesc,
        search: params.search,
        status: params.status ?? undefined,
        source: params.source ?? undefined,
        priority: params.priority ?? undefined,
      }),
    // Wait for the pull to settle, so freshly imported rows are in the first
    // page rather than arriving as a second flash. `isFetched` is true after a
    // *failed* pull too: a dead tracker must not hide an existing backlog.
    enabled: sync.isFetched,
    // Paging and sorting swap the key; keep the old rows visible underneath
    // instead of collapsing the grid to a spinner on every click.
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const syncNow = React.useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: ["backlog", project, "sync"] });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["backlog", project, "list"] }),
      queryClient.invalidateQueries({ queryKey: ["backlog", project, "count"] }),
    ]);
  }, [project, queryClient]);

  const data = React.useMemo(() => (list.data?.items ?? []).map(toWorkItem), [list.data]);
  const sorting = React.useMemo<SortingState>(
    () => [{ id: params.sortBy, desc: params.sortDesc }],
    [params.sortBy, params.sortDesc],
  );
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({
    number: false,
  });

  const table = useReactTable({
    data,
    columns: backlogColumns,
    meta: { onOpenTask, onStartTask },
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    // The daemon already returns exactly the rows to display; the client row
    // models would only re-sort and re-page what is on screen.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    // A header click always lands on a column, never on "no sort at all",
    // which the daemon has no way to represent.
    enableSortingRemoval: false,
    state: {
      sorting,
      columnVisibility,
      pagination: { pageIndex: params.page, pageSize: params.pageSize },
    },
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const [first] = next;
      patch({
        sortBy: (first?.id as BacklogSortKey) ?? DEFAULT_BACKLOG_PARAMS.sortBy,
        sortDesc: first?.desc ?? DEFAULT_BACKLOG_PARAMS.sortDesc,
      });
    },
  });

  return (
    <div className="flex w-full flex-col gap-2">
      <BacklogToolbar
        project={project}
        params={params}
        onChange={patch}
        onReset={reset}
        onSync={() => void syncNow()}
        isSyncing={sync.isFetching}
        table={table}
      />
      <BacklogTable
        table={table}
        isLoading={list.data === undefined && !list.isError}
        isRefreshing={list.isFetching && list.data !== undefined}
        error={list.isError ? `Could not load backlog: ${list.error.message}` : undefined}
      />
      {/* The pager is an input, so it shows the page that was *requested* — the
          dim is what says the rows are still catching up. Driving it from the
          response instead looks tidier and breaks it: mid-fetch the response is
          still the previous page, so "previous" computes its target from a
          stale number and disables itself at page 1 while the request for
          page 2 is in flight. */}
      <BacklogPagination
        page={params.page}
        pageSize={params.pageSize}
        total={list.data?.total ?? 0}
        onPageChange={(page) => patch({ page })}
        onPageSizeChange={(pageSize) => patch({ pageSize })}
      />
    </div>
  );
}
