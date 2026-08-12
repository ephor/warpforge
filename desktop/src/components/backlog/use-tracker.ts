import { useQuery } from "@tanstack/react-query";

import { daemon } from "@/daemon";
import type { TrackerStatus } from "@/protocol";

import type { WorkItemSource } from "./types";

const TRACKER_STATUS_KEY = ["tracker", "status"];
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

/** Whether a given source can currently be written to. */
export function useSourceEnabled(status: TrackerStatus | undefined) {
  return (source: WorkItemSource): boolean => {
    if (source === "local") return true;
    if (source === "linear") return status?.linear?.connected === true;
    return status?.github?.connected === true;
  };
}

export { TRACKER_STATUS_KEY };
