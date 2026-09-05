import { Check, Loader2, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { AccountQuotaStrip } from "@/components/AccountQuotaStrip";
import { AgentLogo } from "@/components/AgentLogo";
import EmailBlur from "@/components/EmailBlur";
import { Button } from "@/components/ui/button";
import { daemon } from "@/daemon";
import { useAgentLimits } from "@/hooks/useAgentLimits";
import { useAgentSpend } from "@/hooks/useAgentSpend";
import {
  formatUsd,
  isSnapshotOutdated,
  lastUpdatedSentence,
  SPEND_DISCLAIMER,
} from "@/lib/agentLimits";
import { agentDisplayName } from "@/lib/agentNames";
import { cn } from "@/lib/utils";
import type { AgentAccountLimits, AgentSpend } from "@/protocol";

/** Agents that support several logins. Others simply have no accounts UI. */
const ACCOUNT_AGENTS = ["claude", "codex"];

/**
 * Register and switch between several logins for one agent, and see what quota
 * each of them has left.
 *
 * An import captures whatever that agent is authenticated as *right now*, so
 * adding a second account means signing into it first (`claude` / `codex login`
 * in a terminal) and then importing again.
 *
 * Identity and quota used to be two separate Settings sections listing the same
 * logins, so every account was drawn twice. They are one thing here: the login
 * you might remove is the login whose numbers you are reading.
 */
export default function AccountsPanel() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const { accounts: limits, refresh, error: limitsError } = useAgentLimits();
  const { agents: spend } = useAgentSpend();

  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const enabledAgents = (state.snapshot.agents ?? []).filter((a) => a.enabled);
  const accounts = state.snapshot.accounts ?? [];
  const limitsFor = new Map((limits ?? []).map((row) => [row.accountId, row]));
  const registered = new Set(accounts.map((a) => a.id));

  // Harnesses whose logins we manage, plus any harness the daemon reports quota
  // for: OpenCode has no account switching but still has a budget worth seeing,
  // and dropping it here would leave nowhere to check it without opening a task.
  const agentIds: string[] = enabledAgents
    .filter((a) => ACCOUNT_AGENTS.includes(a.id))
    .map((a) => a.id);
  for (const row of limits ?? []) if (!agentIds.includes(row.agentId)) agentIds.push(row.agentId);

  if (agentIds.length === 0) return null;

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col">
      {agentIds.map((agentId) => {
        const displayName = agentDisplayName(
          agentId,
          enabledAgents.find((a) => a.id === agentId)?.displayName,
        );
        const own = accounts.filter((a) => a.agentId === agentId);
        // A live login the user never imported reports itself as "<agent>:live".
        // It is real usage, so it gets a row; it just cannot be removed.
        const strays = (limits ?? []).filter(
          (row) => row.agentId === agentId && !registered.has(row.accountId),
        );
        const manageable = ACCOUNT_AGENTS.includes(agentId);
        const label = labels[agentId] ?? "";

        return (
          <section
            key={agentId}
            className="flex flex-col border-t border-border/60 first:border-t-0"
          >
            <header className="flex items-center gap-2 px-4 pb-1.5 pt-3 text-[13px] font-semibold">
              <AgentLogo agentId={agentId} displayName={displayName} />
              {displayName}
              <SpendSummary spend={spend?.find((s) => s.agentId === agentId) ?? null} />
            </header>

            {own.length === 0 && strays.length === 0 ? (
              <p className="px-4 pb-2 text-xs text-muted-foreground">
                No accounts yet. Sign in to {displayName}, then import the login below.
              </p>
            ) : (
              <ul className="flex flex-col">
                {own.map((account) => (
                  <AccountRow
                    key={account.id}
                    label={account.label || account.email || account.id}
                    detail={[account.email, account.plan].filter(Boolean).join(" · ")}
                    active={account.active}
                    limits={limitsFor.get(account.id) ?? null}
                    busy={busy === account.id}
                    disabled={busy !== null}
                    onActivate={() =>
                      void run(account.id, () =>
                        daemon.setActiveAccount(account.agentId, account.id),
                      )
                    }
                    onRemove={() => void run(account.id, () => daemon.removeAccount(account.id))}
                  />
                ))}
                {strays.map((row) => (
                  <AccountRow
                    key={row.accountId}
                    label={row.label}
                    detail={row.plan ?? ""}
                    active={row.active && !own.some((a) => a.active)}
                    limits={row}
                    busy={false}
                    disabled={busy !== null}
                  />
                ))}
              </ul>
            )}

            {manageable && (
              <form
                className="flex items-center gap-2 px-4 pb-3 pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!label.trim()) return;
                  void run(`import:${agentId}`, async () => {
                    await daemon.importAccount(agentId, label.trim());
                    setLabels((prev) => ({ ...prev, [agentId]: "" }));
                  });
                }}
              >
                <input
                  value={label}
                  onChange={(e) => setLabels((prev) => ({ ...prev, [agentId]: e.target.value }))}
                  placeholder="personal"
                  aria-label={`New ${displayName} account name`}
                  className="bg-deep-surface h-7 w-40 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  disabled={!label.trim() || busy !== null}
                >
                  {busy === `import:${agentId}` ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Plus className="size-3" />
                  )}
                  Import current login
                </Button>
              </form>
            )}
          </section>
        );
      })}

      {error && (
        <p className="border-t border-border/60 px-4 py-2 text-xs text-warn" role="status">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
        {spend && spend.length > 0 && (
          <span className="mr-auto text-[11px] text-muted-foreground/80">{SPEND_DISCLAIMER}</span>
        )}
        {limitsError && (
          <span className="text-xs text-red-600 dark:text-red-400">{limitsError}</span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1.5 text-xs"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void refresh().finally(() => setRefreshing(false));
          }}
        >
          <RefreshCcw className={cn("size-3", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

/**
 * API-equivalent spend for one harness, next to its name. Per harness, not per
 * account, so it is stated once by construction. The dollars describe what the
 * usage would have cost at API rates — a subscription is billed none of it —
 * hence the disclaimer under the list.
 */
function SpendSummary({ spend }: { spend: AgentSpend | null }) {
  if (!spend) return null;
  if (!spend.reported) {
    return (
      <span className="ml-auto text-[11px] font-normal text-muted-foreground/70">
        cost not reported
      </span>
    );
  }
  const today = formatUsd(spend.todayUsd);
  const total = formatUsd(spend.totalUsd);
  if (!today && !total) return null;
  return (
    <span
      className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground"
      title={SPEND_DISCLAIMER}
    >
      {[today && `${today} today`, total && `${total} total`].filter(Boolean).join(" · ")}
    </span>
  );
}

function AccountRow({
  label,
  detail,
  active,
  limits,
  busy,
  disabled,
  onActivate,
  onRemove,
}: {
  label: string;
  detail: string;
  active: boolean;
  /** Quota snapshot, or null when the daemon has never polled this login. */
  limits: AgentAccountLimits | null;
  busy: boolean;
  disabled: boolean;
  /** Absent for a live login that exists only in the quota snapshot: there is
   *  no registered account id the daemon would accept for either action. */
  onActivate?: () => void;
  onRemove?: () => void;
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const outdated = limits ? isSnapshotOutdated(limits.fetchedAt, nowSec) : false;
  return (
    <li className="flex items-center gap-2 px-4 py-1.5 hover:bg-muted/30">
      <button
        type="button"
        onClick={onActivate}
        disabled={disabled || active || !onActivate}
        aria-label={`Use ${label}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs disabled:cursor-default"
      >
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Check className={cn("size-3.5 shrink-0", !active && "invisible")} />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{label}</span>
            {outdated && limits && (
              <span
                title={lastUpdatedSentence(limits.fetchedAt, nowSec)}
                className="shrink-0 rounded-sm border border-amber-500/40 bg-amber-500/15 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
              >
                Outdated
              </span>
            )}
          </span>
          {detail && (
            <span className="truncate text-[11px] text-muted-foreground">
              <EmailBlur text={detail} />
            </span>
          )}
          {limits && <AccountQuotaStrip windows={limits.windows} />}
        </span>
      </button>
      {onRemove && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          disabled={disabled}
        >
          <Trash2 className="size-3" />
        </Button>
      )}
    </li>
  );
}
