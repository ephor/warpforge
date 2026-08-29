import { LoaderCircle, RefreshCcw } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { AgentAccountLimitsRow } from "@/components/AgentAccountLimitsRow";
import { AgentLogo } from "@/components/AgentLogo";
import EmailBlur from "@/components/EmailBlur";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccountSwitch } from "@/hooks/useAccountSwitch";
import { useAgentLimits } from "@/hooks/useAgentLimits";
import { useAgentSpend } from "@/hooks/useAgentSpend";
import { buildAccountCards, SWITCH_NOTE, type AccountCard } from "@/lib/accounts";
import {
  headlineWindows,
  limitRamp,
  LIMIT_TEXT_RAMP_CLASSES,
  percentLeft,
  SPEND_DISCLAIMER,
} from "@/lib/agentLimits";
import { agentDisplayName } from "@/lib/agentNames";
import type { AccountInfo, AgentConfig, AgentLimitWindow, AgentSpend } from "@/protocol";

/**
 * The open task's harness, its account, and its quota — one control.
 *
 * These used to be two neighbouring dropdowns: a "N% left" pill listing every
 * harness's quota, and an account chip listing the same accounts to switch
 * between. But "which account should I move to" is decided *on* the quota, so
 * the numbers and the switch have to sit in one place or you close one popup to
 * open the other.
 *
 * The trigger doubles as the task's harness identity, so it renders even with
 * no quota data — logo and account label, quota appended only when the daemon
 * has reported some. The menu keeps every harness, not just this task's: a
 * Claude task can spawn Codex sub-agents, so the footprint is wider than the
 * task's own agent. It is merely *ordered*, this harness first.
 */
export function TaskAccountMenu({
  agentId,
  agents,
  accounts,
}: {
  agentId: string;
  agents: AgentConfig[];
  accounts: AccountInfo[];
}) {
  const { accounts: limits, refresh } = useAgentLimits();
  const { agents: spend } = useAgentSpend();
  const { pending, error, select } = useAccountSwitch();

  const cards = useMemo(
    () => buildAccountCards(accounts, limits, agentId),
    [accounts, limits, agentId],
  );

  const displayName = agentDisplayName(agentId, agents.find((a) => a.id === agentId)?.displayName);
  const activeCard = cards.find((card) => card.agentId === agentId && card.active) ?? null;
  // Session over Weekly, both at a glance — one number could not tell you
  // whether the hour or the week is the thing about to run out.
  const headline = activeCard?.limits ? headlineWindows(activeCard.limits.windows) : null;
  const shown = [headline?.session, headline?.weekly].filter(
    (window): window is AgentLimitWindow => window != null,
  );

  if (cards.length === 0) {
    // Nothing signed in for this harness yet. Still say which harness the task
    // runs on, at the same footprint as the chip, so the row doesn't jump once
    // a first account appears.
    return (
      <span
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground"
        title={displayName}
      >
        <AgentLogo agentId={agentId} displayName={displayName} />
        <span className="max-w-28 truncate">{displayName}</span>
      </span>
    );
  }

  const label = activeCard ? activeCard.label : "Select account";
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label={`${displayName} account`}
          title={`${displayName}: ${label}${shown.map((w) => ` · ${w.label}: ${quotaSentence(w)}`).join("")}`}
        >
          <AgentLogo agentId={agentId} displayName={displayName} />
          <span className="max-w-28 truncate">
            <EmailBlur text={label} />
          </span>
          {shown.length > 0 && (
            <span className="flex flex-col items-end text-[10px] font-medium leading-[1.1] tabular-nums">
              {shown.map((window) => (
                <span
                  key={window.id}
                  className={LIMIT_TEXT_RAMP_CLASSES[limitRamp(window.usedPercent)]}
                >
                  {quotaDigits(window)}
                </span>
              ))}
            </span>
          )}
          {pending !== null && <LoaderCircle className="size-3 animate-spin" />}
        </DropdownMenuTrigger>
        {/* Capped to the viewport so a machine with several harnesses signed in
            scrolls instead of running off a short screen. */}
        <DropdownMenuContent
          align="end"
          className="max-h-[min(80vh,32rem)] w-80 space-y-2 overflow-y-auto p-2"
        >
          {cards.map((card) => (
            <AccountCardItem
              key={card.id}
              card={card}
              spend={
                card.showSpend ? (spend?.find((s) => s.agentId === card.agentId) ?? null) : null
              }
              pending={pending}
              onSelect={select}
            />
          ))}
          {spend && spend.length > 0 && (
            <p className="px-1 text-[10px] text-muted-foreground/80">{SPEND_DISCLAIMER}</p>
          )}
          <p className="px-1 text-[11px] leading-snug text-muted-foreground">{SWITCH_NOTE}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex w-full items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <RefreshCcw className="size-3" />
            Refresh
          </button>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Outside the dropdown on purpose: the menu can close on the same frame a
          switch fails, and an error rendered inside it would go with it. */}
      {error && (
        <span className="max-w-64 truncate text-[11px] text-warn" role="status" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The trigger's two lines are numbers only — "73%" over "67%" — so both fit the
 * header row. They are quota LEFT, matching the cards behind them; the tooltip
 * spells that out in words, since a bare percent could be read either way.
 */
function quotaDigits(window: AgentLimitWindow): string {
  return window.usedPercent >= 100 ? "exhausted" : `${percentLeft(window.usedPercent)}%`;
}

function quotaSentence(window: AgentLimitWindow): string {
  return window.usedPercent >= 100 ? "exhausted" : `${percentLeft(window.usedPercent)}% left`;
}

function AccountCardItem({
  card,
  spend,
  pending,
  onSelect,
}: {
  card: AccountCard;
  spend: AgentSpend | null;
  pending: string | null;
  onSelect: (agentId: string, accountId: string) => void;
}) {
  // No action on the account already in use — the header's ACTIVE badge says so,
  // and a live login nobody registered has no id the daemon would accept. Null
  // rather than a component that returns null, so the foot row can tell.
  const action =
    card.active || !card.account ? null : (
      <AccountAction card={card} account={card.account} pending={pending} onSelect={onSelect} />
    );
  if (!card.limits) return <PlainAccountCard card={card} action={action} />;
  return (
    <AgentAccountLimitsRow
      // Identity comes from the account list: the limits snapshot carries its
      // own `active` flag but is 20 minutes stale, so it would still point at
      // the login you just switched away from.
      account={{ ...card.limits, active: card.active, label: card.label }}
      showLabel={card.showLabel}
      spend={spend}
      action={action}
    />
  );
}

/**
 * Switching is global for the harness and resumes open sessions elsewhere, so
 * it is an explicit control rather than a click on the card — a mis-click on
 * something you opened to *read* must not move your task's account.
 */
function AccountAction({
  card,
  account,
  pending,
  onSelect,
}: {
  card: AccountCard;
  account: AccountInfo;
  pending: string | null;
  onSelect: (agentId: string, accountId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Use ${card.label}`}
      disabled={pending !== null}
      onClick={() => onSelect(card.agentId, account.id)}
      className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
    >
      {pending === account.id && <LoaderCircle className="size-3 animate-spin" />}
      Use this account
    </button>
  );
}

/** An account the daemon has never polled: no numbers to show, still switchable. */
function PlainAccountCard({ card, action }: { card: AccountCard; action: ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border border-border/80 bg-card p-4">
      <div className="flex items-center gap-2">
        <AgentLogo
          agentId={card.agentId}
          displayName={agentDisplayName(card.agentId)}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {agentDisplayName(card.agentId)}
          {card.showLabel && (
            <span className="font-medium text-muted-foreground">
              {" · "}
              <EmailBlur text={card.label} />
            </span>
          )}
        </span>
        {card.plan && (
          <span className="rounded-sm border border-border bg-muted/50 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {card.plan}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">No usage reported for this account yet.</p>
      {/* Never polled, so there is no timestamp to sit on the left of this row —
          only the action, and nothing at all when it is the active account. */}
      {action && (
        <div className="flex items-center justify-end border-t border-border/60 pt-2">{action}</div>
      )}
    </div>
  );
}
