import { useQuery } from "@tanstack/react-query";

import { daemon } from "@/daemon";
import type { ProjectSources, TrackerStatus } from "@/protocol";

import type { WorkItemSource } from "./types";

const TRACKER_STATUS_KEY = ["tracker", "status"];
const TRACKER_PROJECT_SOURCES_KEY = ["tracker", "projectSources"];

/** Connection state of both trackers. */
export function useTrackerStatus() {
  return useQuery({
    queryFn: () => daemon.trackerStatus(),
    queryKey: TRACKER_STATUS_KEY,
    // Connecting happens in Settings and is invalidated explicitly there;
    // nothing else changes this out from under us.
    staleTime: 60_000,
  });
}

/**
 * The signed-in identity, as trackers spell it. GitHub reports the same login
 * it writes into `assignee`, so the two match; Linear only tells us the
 * account's email, which no issue is ever assigned to — hence GitHub only.
 *
 * This is what "you" means across the backlog: the pinned entry in the
 * assignee filter, and the owner stamped on an item you create here.
 */
export function useMe(): string | null {
  return useTrackerStatus().data?.github?.login ?? null;
}

/**
 * Which sources *this* project can read and write. The global connection
 * state says nothing about a project: Linear only counts once a team is
 * mapped to it, GitHub only once its dir resolves to a repo. This is what
 * source filters and pickers should render against.
 */
export function useProjectSources(project: string) {
  return useQuery({
    queryFn: () => daemon.trackerProjectSources(project),
    queryKey: [...TRACKER_PROJECT_SOURCES_KEY, project],
    // Repo/team resolution costs daemon-side `gh` spawns; don't re-run on
    // every mount. Explicit invalidation covers connect/disconnect and
    // Linear-team changes.
    staleTime: 60_000,
  });
}

/** Whether a given source can currently be written to. */
export function useSourceEnabled(status: TrackerStatus | undefined) {
  return (source: WorkItemSource): boolean => {
    if (source === "local") return true;
    if (source === "linear") return status?.linear?.connected === true;
    return status?.github?.connected === true;
  };
}

/** Whether a given source exists for a project, per the availability probe. */
export function sourceAvailable(
  sources: ProjectSources | undefined,
  source: WorkItemSource,
): boolean {
  if (source === "local") return true;
  if (source === "linear") return sources?.linear === true;
  return sources?.github === true;
}

export { TRACKER_STATUS_KEY, TRACKER_PROJECT_SOURCES_KEY };
