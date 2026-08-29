import { useCallback, useState } from "react";

import { daemon } from "@/daemon";

/**
 * Switching an agent's active account, with the two bits of state every caller
 * needs: which account is mid-switch (spinner) and why the last one failed.
 *
 * Shared by the global account chip and the task header's account menu so the
 * two cannot drift into disagreeing about what a failed switch looks like.
 */
export function useAccountSwitch() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback(async (agentId: string, accountId: string) => {
    setPending(accountId);
    setError(null);
    try {
      await daemon.setActiveAccount(agentId, accountId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, []);

  return { pending, error, select };
}
