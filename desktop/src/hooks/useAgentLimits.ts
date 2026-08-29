import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { daemon } from "@/daemon";
import type { AgentAccountLimits } from "@/protocol";

/**
 * Per-account harness rate limits. Data comes from the daemon's store (kept
 * fresh by `agentLimits.updated` pushes); the first mount asks for it via
 * `listAgentLimits`. The daemon may not support the call at all — the hook
 * then settles on `null` accounts and the UI renders nothing, never a
 * fabricated number or an endless spinner.
 */
export function useAgentLimits() {
  const accounts = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().agentLimits ?? null,
    () => null,
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    daemon
      .listAgentLimits()
      .then(() => setError(null))
      .catch((e) => {
        // Unsupported or unreachable RPC: no data is the honest answer, but
        // the failure is surfaced (Settings shows it next to Refresh).
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      await daemon.listAgentLimits(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return { accounts: accounts as AgentAccountLimits[] | null, refresh, error, loaded };
}
