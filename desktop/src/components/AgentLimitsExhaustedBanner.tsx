import { AlertTriangle, X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { daemon } from "@/daemon";
import { activeAccountForAgent, formatResetRelative, worstWindow } from "@/lib/agentLimits";

/**
 * Full-width notice when the account backing the open task has spent its
 * quota: which window is exhausted and when it resets. If another account of
 * the same agent still has quota, that is named as a suggestion — switching
 * stays manual (AccountSwitcher). Dismissal is keyed on the exhausted
 * account+window, so a new exhaustion resurfaces the banner.
 */
export function AgentLimitsExhaustedBanner({ agentId }: { agentId: string }) {
  const accounts = useSyncExternalStore(
    daemon.subscribe,
    () => daemon.getState().agentLimits ?? null,
    () => null,
  );
  const activeAccountId = useSyncExternalStore(
    daemon.subscribe,
    () =>
      daemon.getState().snapshot.accounts?.find((a) => a.agentId === agentId && a.active)?.id ??
      null,
    () => null,
  );
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (accounts === null) return null;
  const account = activeAccountForAgent(accounts, agentId, activeAccountId);
  if (!account?.exhausted) return null;

  const exhaustedWindow = worstWindow(account.windows.filter((w) => w.usedPercent >= 100));
  if (!exhaustedWindow) return null;

  const key = `${account.accountId}:${exhaustedWindow.id}`;
  if (dismissed === key) return null;

  const suggestion = accounts.find(
    (a) => a.agentId === agentId && a.accountId !== account.accountId && !a.exhausted && !a.error,
  );

  const resetText =
    exhaustedWindow.resetsAt !== undefined
      ? ` It resets ${formatResetRelative(exhaustedWindow.resetsAt).replace("resets ", "")}.`
      : "";

  return (
    <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {account.label}'s quota is spent — {exhaustedWindow.label.toLowerCase()} limit exhausted
        </p>
        <p className="mt-0.5 text-muted-foreground">
          New prompts will fail until the window clears.{resetText}
          {suggestion && (
            <>
              {" "}
              Another {agentId} account, <span className="font-medium">{suggestion.label}</span>,
              still has quota.
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => setDismissed(key)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
