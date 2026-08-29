import type { AccountInfo, AgentAccountLimits } from "@/protocol";

/**
 * A running agent process cannot change account: Codex reads CODEX_HOME once at
 * spawn, and Claude caches the credentials it authenticated with. The daemon
 * therefore retires live sessions on a switch and resumes them in a fresh
 * process on the next message — which is worth saying, because the alternative
 * reading ("my task just died") is the wrong one.
 */
export const SWITCH_NOTE = "Open sessions resume on the new account with your next message.";

export function accountLabel(account: AccountInfo): string {
  return account.label || account.email || account.id;
}

/** One account as the header menu shows it: identity from the account list, numbers from limits. */
export interface AccountCard {
  /** Account id, or the limits row's id for a login that was never registered. */
  id: string;
  agentId: string;
  label: string;
  email?: string;
  plan?: string;
  active: boolean;
  /** Quota snapshot, or null when the daemon has never polled this account. */
  limits: AgentAccountLimits | null;
  /** The registered account to switch to; null for a live login that exists
   *  only in the limits snapshot and has no id the daemon would accept. */
  account: AccountInfo | null;
  /** Name the login on the card — this harness has more than one. */
  showLabel: boolean;
  /** This card carries the harness's (per-harness, not per-account) spend. */
  showSpend: boolean;
}

/**
 * Join the account list with the limits snapshot into the cards the task
 * header's menu renders, this task's harness first.
 *
 * The two sources answer different questions and neither can stand in for the
 * other: the account list says what exists and which login is live (it updates
 * the instant you switch), limits say what the numbers are (refetched every 20
 * minutes, and absent entirely for an account nobody has polled yet). Driving
 * the list off limits alone would hide a freshly added account; driving it off
 * accounts alone would hide a signed-in login the user never registered.
 *
 * Other harnesses stay in the list on purpose: a Claude task can spawn Codex
 * sub-agents, so the task's real resource footprint spans harnesses.
 */
export function buildAccountCards(
  accounts: AccountInfo[],
  limits: AgentAccountLimits[] | null,
  firstAgentId: string,
): AccountCard[] {
  const limitsFor = new Map((limits ?? []).map((row) => [row.accountId, row]));
  const registered = new Set(accounts.map((a) => a.id));

  const agentIds: string[] = [firstAgentId];
  for (const source of [accounts, limits ?? []]) {
    for (const row of source) if (!agentIds.includes(row.agentId)) agentIds.push(row.agentId);
  }

  const cards: AccountCard[] = [];
  for (const agentId of agentIds) {
    const own = accounts.filter((a) => a.agentId === agentId);
    // A live login the user never imported reports itself as "<agent>:live".
    // It is real usage, so it gets a card; it just cannot be switched to.
    const strays = (limits ?? []).filter(
      (row) => row.agentId === agentId && !registered.has(row.accountId),
    );
    const hasActiveAccount = own.some((a) => a.active);
    const showLabel = own.length + strays.length > 1;

    const group: AccountCard[] = [
      ...own.map((account) => ({
        id: account.id,
        agentId,
        label: accountLabel(account),
        email: account.email,
        plan: account.plan,
        active: account.active,
        limits: limitsFor.get(account.id) ?? null,
        account,
        showLabel,
        showSpend: false,
      })),
      ...strays.map((row) => ({
        id: row.accountId,
        agentId,
        label: row.label,
        plan: row.plan,
        active: row.active && !hasActiveAccount,
        limits: row,
        account: null,
        showLabel,
        showSpend: false,
      })),
    ];

    // Spend is reported per harness, so it rides on that harness's first card
    // with numbers rather than repeating under every login.
    const carrier = group.find((card) => card.limits !== null);
    if (carrier) carrier.showSpend = true;
    cards.push(...group);
  }
  return cards;
}
