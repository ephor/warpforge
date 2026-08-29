import { Loader2, RefreshCcw } from "lucide-react";

import { AgentAccountLimitsRow } from "@/components/AgentAccountLimitsRow";
import { Button } from "@/components/ui/button";
import { useAgentLimits } from "@/hooks/useAgentLimits";
import { useAgentSpend } from "@/hooks/useAgentSpend";
import { SPEND_DISCLAIMER, spendForAccountCard } from "@/lib/agentLimits";

/**
 * Settings section: one card per account, in the OpenUsage menu-bar style.
 * Degraded state (daemon without the RPC, or nothing configured) says so
 * instead of pretending.
 */
export function AgentLimitsSection() {
  const { accounts, refresh, error, loaded } = useAgentLimits();
  const { agents: spend } = useAgentSpend();

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading rate limits…
      </div>
    );
  }

  if (accounts === null) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Rate-limit information is not available — the running daemon does not report it. Restart
        Warpforge once your daemon supports harness limits.
      </p>
    );
  }

  if (accounts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No agent accounts configured yet. Add one under Settings → Accounts.
      </p>
    );
  }

  // Agents with several logins get the login named on each card, so
  // per-account quota stays legible; a single-account harness reads like the
  // reference app. An unregistered live login (`<agent>:live`) renders the
  // same as any account.
  const accountsPerAgent = new Map<string, number>();
  for (const account of accounts) {
    accountsPerAgent.set(account.agentId, (accountsPerAgent.get(account.agentId) ?? 0) + 1);
  }

  return (
    <div className="p-4">
      <div className="space-y-3">
        {accounts.map((account) => (
          <AgentAccountLimitsRow
            key={account.accountId}
            account={account}
            showLabel={(accountsPerAgent.get(account.agentId) ?? 0) > 1}
            spend={spendForAccountCard(accounts, account, spend)}
          />
        ))}
      </div>
      {spend && spend.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground/80">{SPEND_DISCLAIMER}</p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void refresh()}
        >
          <RefreshCcw className="size-3" />
          Refresh
        </Button>
      </div>
    </div>
  );
}
