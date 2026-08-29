import { useEffect, useState, useSyncExternalStore } from "react";

import { daemon } from "@/daemon";
import type { AgentSpend } from "@/protocol";

/**
 * Per-harness API-equivalent spend. There is no push event for it, so the
 * first mount asks once via `listAgentSpend` and the daemon store holds the
 * answer. An older daemon does not know the call at all — the hook then
 * settles on `null` agents and the UI renders nothing, never a fabricated
 * number or an endless spinner.
 */
export function useAgentSpend() {
  const agents = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().agentSpend ?? null,
    () => null,
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    daemon
      .listAgentSpend()
      .then(() => setError(null))
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { agents: agents as AgentSpend[] | null, error, loaded };
}
