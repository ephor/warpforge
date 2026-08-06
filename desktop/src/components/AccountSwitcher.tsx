import { Check, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { AgentLogo } from "@/components/AgentLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { daemon } from "@/daemon";
import { cn } from "@/lib/utils";
import type { AccountInfo, AgentConfig } from "@/protocol";

/**
 * A running agent process cannot change account: Codex reads CODEX_HOME once at
 * spawn, and Claude caches the credentials it authenticated with. The daemon
 * therefore retires live sessions on a switch and resumes them in a fresh
 * process on the next message — which is worth saying, because the alternative
 * reading ("my task just died") is the wrong one.
 */
const SWITCH_NOTE =
  "Open sessions resume on the new account with your next message.";

function accountLabel(account: AccountInfo): string {
  return account.label || account.email || account.id;
}

export default function AccountSwitcher({
  agents,
  accounts,
}: {
  agents: AgentConfig[];
  accounts: AccountInfo[];
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One chip per enabled agent that has something to switch between. A single
  // account needs no switcher — it is not a choice.
  const switchable = agents
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      agent,
      accounts: accounts.filter((account) => account.agentId === agent.id),
    }))
    .filter((entry) => entry.accounts.length > 1);

  if (switchable.length === 0) return null;

  async function select(agentId: string, accountId: string) {
    setPending(accountId);
    setError(null);
    try {
      await daemon.setActiveAccount(agentId, accountId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {switchable.map(({ agent, accounts: agentAccounts }) => {
        const active = agentAccounts.find((a) => a.active);
        return (
          <DropdownMenu key={agent.id}>
            <DropdownMenuTrigger
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={`${agent.displayName} account`}
              title={`${agent.displayName}: ${active ? accountLabel(active) : "no account selected"}`}
            >
              <AgentLogo agentId={agent.id} displayName={agent.displayName} />
              <span className="max-w-28 truncate">
                {active ? accountLabel(active) : "Select account"}
              </span>
              {pending !== null && agentAccounts.some((a) => a.id === pending) && (
                <LoaderCircle className="size-3 animate-spin" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {agent.displayName} account
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {agentAccounts.map((account) => (
                <DropdownMenuItem
                  key={account.id}
                  onSelect={() => void select(agent.id, account.id)}
                  disabled={pending !== null}
                  className="gap-2"
                >
                  <Check
                    className={cn("size-3.5 shrink-0", !account.active && "invisible")}
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{accountLabel(account)}</span>
                    {(account.email || account.plan) && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {[account.email, account.plan].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground">
                {SWITCH_NOTE}
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {/* Outside the dropdown on purpose: selecting an item closes the menu, so
          an error rendered inside it would vanish in the same frame it appeared. */}
      {error && (
        <span className="max-w-64 truncate text-[11px] text-warn" role="status" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
