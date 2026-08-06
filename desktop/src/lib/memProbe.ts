import { daemon } from "../daemon";
import { queryClient } from "../query";

/**
 * Dev-only heap accounting. Safari's Timelines panel records no memory
 * instrument by default, so instead of hunting for a heap snapshot we ask the
 * two stores that actually retain payloads how much they are holding.
 *
 * Call `__wfMem()` from the console before and after browsing, and diff.
 */

function bytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function probe() {
  const sessionUpdates = daemon.getState().sessionUpdates;
  const taskIds = Object.keys(sessionUpdates);
  let updateCount = 0;
  let updateBytes = 0;
  const perTask: { task: string; updates: number; mb: string }[] = [];
  for (const id of taskIds) {
    const updates = sessionUpdates[id] ?? [];
    const size = bytes(updates);
    updateCount += updates.length;
    updateBytes += size;
    perTask.push({ task: id, updates: updates.length, mb: mb(size) });
  }

  const queries = queryClient.getQueryCache().getAll();
  let queryBytes = 0;
  const perQuery: { key: string; mb: string; bytes: number }[] = [];
  for (const query of queries) {
    const size = bytes(query.state.data);
    queryBytes += size;
    perQuery.push({ key: JSON.stringify(query.queryKey), mb: mb(size), bytes: size });
  }

  perTask.sort((a, b) => b.updates - a.updates);
  perQuery.sort((a, b) => b.bytes - a.bytes);

  // Leak classes that hold no payload of their own but grow while idle:
  // orphaned store subscribers, query observers, and detached-ish DOM.
  const internals = daemon as unknown as {
    listeners?: Set<unknown>;
    eventListeners?: Set<unknown>;
    terminalDataSubscribers?: Map<string, Set<unknown>>;
    pending?: Map<unknown, unknown>;
  };
  let terminalSubs = 0;
  internals.terminalDataSubscribers?.forEach((set) => {
    terminalSubs += set.size;
  });
  const counts = {
    storeListeners: internals.listeners?.size ?? -1,
    eventListeners: internals.eventListeners?.size ?? -1,
    terminalSubs,
    pendingRpc: internals.pending?.size ?? -1,
    queryObservers: queries.reduce((sum, q) => sum + q.getObserversCount(), 0),
    domNodes: document.querySelectorAll("*").length,
  };

  console.log(
    `sessionUpdates: ${taskIds.length} tasks, ${updateCount} updates, ${mb(updateBytes)}\n` +
      `reactQuery:     ${queries.length} entries, ${mb(queryBytes)}\n` +
      `total serialized: ${mb(updateBytes + queryBytes)}`,
  );
  console.table(counts);
  console.table(perTask.slice(0, 10));
  console.table(perQuery.slice(0, 15).map(({ key, mb: size }) => ({ key, mb: size })));

  return {
    tasks: taskIds.length,
    updateCount,
    updateBytes,
    queryCount: queries.length,
    queryBytes,
    ...counts,
  };
}

declare global {
  interface Window {
    __wfMem?: typeof probe;
  }
}

export function installMemProbe() {
  window.__wfMem = probe;
}
