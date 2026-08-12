import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { AgentLogo } from "@/components/AgentLogo";
import EmailBlur from "@/components/EmailBlur";
import { Button } from "@/components/ui/button";
import { daemon } from "@/daemon";
import { cn } from "@/lib/utils";
import type { AccountInfo } from "@/protocol";

/** Agents that support several logins. Others simply have no accounts UI. */
const ACCOUNT_AGENTS = ["claude", "codex"];

/**
 * Register and switch between several logins for one agent.
 *
 * An import captures whatever that agent is authenticated as *right now*, so
 * adding a second account means signing into it first (`claude` / `codex login`
 * in a terminal) and then importing again.
 */
export default function AccountsPanel() {
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const agents = (state.snapshot.agents ?? []).filter(
    (a) => a.enabled && ACCOUNT_AGENTS.includes(a.id),
  );
  const accounts = state.snapshot.accounts ?? [];

  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (agents.length === 0) return null;

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
    <div className="flex flex-col gap-4">
      {agents.map((agent) => {
        const agentAccounts = accounts.filter((a) => a.agentId === agent.id);
        const label = labels[agent.id] ?? "";
        return (
          <section key={agent.id} className="flex flex-col gap-2">
            <header className="flex items-center gap-2 text-sm font-medium">
              <AgentLogo agentId={agent.id} displayName={agent.displayName} />
              {agent.displayName}
            </header>

            {agentAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No accounts yet. Sign in to {agent.displayName}, then import the login below.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {agentAccounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
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
              </ul>
            )}

            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!label.trim()) return;
                void run(`import:${agent.id}`, async () => {
                  await daemon.importAccount(agent.id, label.trim());
                  setLabels((prev) => ({ ...prev, [agent.id]: "" }));
                });
              }}
            >
              <input
                value={label}
                onChange={(e) => setLabels((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                placeholder="personal"
                aria-label={`New ${agent.displayName} account name`}
                className="bg-deep-surface h-7 w-40 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                disabled={!label.trim() || busy !== null}
              >
                {busy === `import:${agent.id}` ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Plus className="size-3" />
                )}
                Import current login
              </Button>
            </form>
          </section>
        );
      })}

      {error && (
        <p className="text-xs text-warn" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

function AccountRow({
  account,
  busy,
  disabled,
  onActivate,
  onRemove,
}: {
  account: AccountInfo;
  busy: boolean;
  disabled: boolean;
  onActivate: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border px-2 py-1.5">
      <button
        type="button"
        onClick={onActivate}
        disabled={disabled || account.active}
        aria-label={`Use ${account.label}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs disabled:cursor-default"
      >
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Check className={cn("size-3.5 shrink-0", !account.active && "invisible")} />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{account.label}</span>
          {(account.email || account.plan) && (
            <span className="truncate text-[11px] text-muted-foreground">
              <EmailBlur text={[account.email, account.plan].filter(Boolean).join(" · ")} />
            </span>
          )}
        </span>
      </button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={`Remove ${account.label}`}
        onClick={onRemove}
        disabled={disabled}
      >
        <Trash2 className="size-3" />
      </Button>
    </li>
  );
}
