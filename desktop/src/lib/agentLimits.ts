import type { AgentAccountLimits, AgentLimitWindow, AgentSpend } from "@/protocol";

export type LimitRamp = "neutral" | "warning" | "danger";

/** Colour ramp for a usage percent: neutral <70, warning 70–89, danger ≥90. */
export function limitRamp(percent: number): LimitRamp {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "neutral";
}

/** The Session and Weekly windows of an account. Either side may be missing. */
export interface HeadlineWindows {
  session: AgentLimitWindow | null;
  weekly: AgentLimitWindow | null;
}

/**
 * The two windows the header trigger stacks: Session on top, Weekly below.
 *
 * Matching is on the LABEL, not the id, because that is the one key all three
 * harnesses agree on — Claude's `five_hour`/`seven_day`, Codex's
 * `primary`/`secondary` and opencode's `rolling`/`weekly` are all normalised to
 * "Session" and "Weekly" before they reach us. The match is exact on purpose:
 * Claude also reports "Weekly (Opus)" and opencode a "Monthly", and neither
 * belongs on a two-line trigger.
 */
export function headlineWindows(windows: AgentLimitWindow[]): HeadlineWindows {
  return {
    session: windows.find((w) => w.label === "Session") ?? null,
    weekly: windows.find((w) => w.label === "Weekly") ?? null,
  };
}

/** The most-used window of an account, or null when it has no windows. */
export function worstWindow(windows: AgentLimitWindow[]): AgentLimitWindow | null {
  let worst: AgentLimitWindow | null = null;
  for (const window of windows) {
    if (!worst || window.usedPercent > worst.usedPercent) worst = window;
  }
  return worst;
}

/**
 * The account a task's agent currently runs on.
 *
 * `activeAccountId` comes from the account snapshot, which updates the moment
 * the user switches — the limits snapshot carries its own `active` flag but is
 * only refetched every 20 minutes, so trusting that one made the pill keep
 * showing the previous login's numbers after a switch. The flag is still the
 * fallback: a harness the user is signed into but has not registered reports
 * itself as `<agent>:live` and matches no account id.
 */
export function activeAccountForAgent(
  accounts: AgentAccountLimits[],
  agentId: string,
  activeAccountId?: string | null,
): AgentAccountLimits | null {
  const forAgent = accounts.filter((a) => a.agentId === agentId);
  if (activeAccountId) {
    const exact = forAgent.find((a) => a.accountId === activeAccountId);
    if (exact) return exact;
  }
  return forAgent.find((a) => a.active) ?? null;
}

/**
 * Worst window of the account a task's agent currently runs on — the pair the
 * header pill and the exhaustion banner must agree on. Null when there is no
 * active account or it reported no windows; a real 0% window is reported.
 */
export function activeAccountWorstWindow(
  accounts: AgentAccountLimits[],
  agentId: string,
  activeAccountId?: string | null,
): { account: AgentAccountLimits; window: AgentLimitWindow } | null {
  const account = activeAccountForAgent(accounts, agentId, activeAccountId);
  if (!account) return null;
  const window = worstWindow(account.windows);
  return window ? { account, window } : null;
}

/** Text-only ramp colours, for numbers rendered bare rather than in a chip. */
export const LIMIT_TEXT_RAMP_CLASSES: Record<LimitRamp, string> = {
  neutral: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

export const LIMIT_BAR_RAMP_CLASSES: Record<LimitRamp, string> = {
  neutral: "bg-foreground/40",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

/** Remaining quota as a 0..100 integer: 95% used → 5% left. */
export function percentLeft(usedPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/** Duration text only, e.g. "4h 57m" or "3d 6h". "now" when already due. */
export function formatResetDuration(resetsAt: number, nowSec = Math.floor(Date.now() / 1000)) {
  return formatDuration(Math.round(resetsAt - nowSec));
}

/** Shared span formatting: "<1m", "45m", "4h 57m", "3d 6h", "now" at or below 0. */
function formatDuration(seconds: number) {
  const diffSec = seconds;
  if (diffSec <= 0) return "now";
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Human relative reset time, e.g. "resets in 2h 14m". `resetsAt` is unix
 * SECONDS, not milliseconds. A past reset reads as already due.
 */
export function formatResetRelative(resetsAt: number, nowSec = Math.floor(Date.now() / 1000)) {
  const duration = formatResetDuration(resetsAt, nowSec);
  return duration === "now" ? "resets now" : `resets in ${duration}`;
}

/** Capitalized variant for standalone display, e.g. "Resets in 4h 57m". */
export function resetSentence(resetsAt: number, nowSec = Math.floor(Date.now() / 1000)) {
  const duration = formatResetDuration(resetsAt, nowSec);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

/**
 * How often the daemon refetches harness usage (`LIMITS_INTERVAL` in
 * `src/daemon/actor.rs`). Quota windows are hours to days wide and the usage
 * endpoints answer 429 when polled harder, so this is deliberately slow.
 */
export const LIMITS_POLL_INTERVAL_SEC = 20 * 60;

/**
 * Age at which a snapshot is tagged "Outdated".
 *
 * A healthy account is always somewhere between 0 and one poll interval old,
 * so the threshold has to sit *past* a full cycle or every card would wear the
 * tag for half of normal operation. One cycle plus five minutes of slack (for
 * fetch time and clock skew) means the tag only appears when a refresh was
 * actually missed or failed — which is the whole point of showing it.
 */
export const LIMITS_OUTDATED_AFTER_SEC = LIMITS_POLL_INTERVAL_SEC + 5 * 60;

/**
 * Age of a snapshot in seconds. `fetchedAt` is unix SECONDS. A timestamp in
 * the future (clock skew between daemon and UI) reads as age 0, never as a
 * negative age that would format as "now" in the wrong direction.
 */
export function snapshotAgeSec(fetchedAt: number, nowSec = Math.floor(Date.now() / 1000)) {
  return Math.max(0, Math.round(nowSec - fetchedAt));
}

/** Whether a snapshot is old enough that its numbers should not be trusted as live. */
export function isSnapshotOutdated(fetchedAt: number, nowSec = Math.floor(Date.now() / 1000)) {
  return snapshotAgeSec(fetchedAt, nowSec) > LIMITS_OUTDATED_AFTER_SEC;
}

/** Precise age for the Outdated tooltip, e.g. "Last updated 3h 12m ago". */
export function lastUpdatedSentence(fetchedAt: number, nowSec = Math.floor(Date.now() / 1000)) {
  const age = snapshotAgeSec(fetchedAt, nowSec);
  if (age < 60) return "Last updated just now";
  return `Last updated ${formatDuration(age)} ago`;
}

/**
 * The one sentence that must sit next to every dollar figure we show. These
 * numbers are what the usage would have cost at API rates; on a subscription
 * plan nothing of the sort is billed, so the copy never says "billed",
 * "charged" or "spent".
 */
export const SPEND_DISCLAIMER = "Estimated at API rates — not what you were billed.";

/**
 * Dollars for display: cents below $1,000 (`$1.23`, `$567.89`), thousands
 * separators and no cents above it (`$1,234`). Anything that is not a finite
 * number — null, undefined, NaN — returns null so callers render nothing
 * instead of "$undefined" or "$NaN".
 */
export function formatUsd(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  // Decide on the rounded value: $999.995 belongs in the no-cents bucket, or it
  // would render as "$1,000.00".
  const digits = Math.round(abs * 100) / 100 >= 1000 ? 0 : 2;
  const amount = abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value < 0 ? "-" : ""}$${amount}`;
}

/**
 * Spend to show on one account's card, or null.
 *
 * Spend is reported per HARNESS — the cost stream carries no account id — so a
 * harness with several logins shows it once, on that harness's first card, and
 * never repeats the same dollars under each account as if they were separate.
 */
export function spendForAccountCard(
  accounts: AgentAccountLimits[],
  account: AgentAccountLimits,
  spend: AgentSpend[] | null,
): AgentSpend | null {
  if (!spend) return null;
  const first = accounts.find((a) => a.agentId === account.agentId);
  if (!first || first.accountId !== account.accountId) return null;
  return spend.find((s) => s.agentId === account.agentId) ?? null;
}
