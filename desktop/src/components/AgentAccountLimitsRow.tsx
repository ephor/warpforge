import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { AgentLogo } from "@/components/AgentLogo";
import {
  formatUsd,
  isSnapshotOutdated,
  lastUpdatedSentence,
  limitRamp,
  LIMIT_BAR_RAMP_CLASSES,
  percentLeft,
  resetSentence,
  SPEND_DISCLAIMER,
} from "@/lib/agentLimits";
import { agentDisplayName } from "@/lib/agentNames";
import type { AgentAccountLimits, AgentLimitWindow, AgentSpend } from "@/protocol";

/**
 * One account rendered as a card, in the OpenUsage menu-bar style: harness
 * name + plan in the header, then one block per usage window — window label,
 * a bar filled proportional to quota LEFT, and "N% left · Resets in …" on a
 * shared line. `label` is whatever the harness reports (a warpforge account
 * name, a live login's email, or "Signed in") — rendered verbatim, never
 * assumed to be a managed account.
 *
 * A failed refresh never wipes the card: the daemon keeps serving the last
 * good numbers, so those stay on screen and the failure is only a small amber
 * triangle by the name (hover for the message). What makes old numbers
 * obvious is the "Outdated" tag, not a red paragraph — a throttled refresh is
 * a delay, not proof the figures are wrong. An account that has an error and
 * no windows at all has nothing to show, so it says so in words.
 */
export function AgentAccountLimitsRow({
  account,
  showLabel,
  spend,
  action,
}: {
  account: AgentAccountLimits;
  /** When an agent has several accounts, name which login the numbers belong to. */
  showLabel: boolean;
  /** API-equivalent spend for this harness. Per harness, not per account, so
   *  the caller passes it only for the harness's first card. */
  spend?: AgentSpend | null;
  /** Optional control at the card's foot (the header menu puts "Use this
   *  account" there). Deliberately not a click target on the card itself:
   *  switching account is global and retires live sessions. */
  action?: ReactNode;
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const hasWindows = account.windows.length > 0;
  const outdated = isSnapshotOutdated(account.fetchedAt, nowSec);
  return (
    <div className="space-y-3 rounded-md border border-border/80 bg-card p-4">
      <div className="flex items-center gap-2">
        <AgentLogo
          agentId={account.agentId}
          displayName={agentDisplayName(account.agentId)}
          className="size-4 shrink-0"
        />
        <span className="text-[13px] font-semibold text-foreground">
          {agentDisplayName(account.agentId)}
          {showLabel && (
            <span className="font-medium text-muted-foreground"> · {account.label}</span>
          )}
        </span>
        {account.error && hasWindows && (
          <span
            role="img"
            aria-label={`Last refresh failed: ${account.error}`}
            title={account.error}
            className="inline-flex shrink-0 text-amber-500 dark:text-amber-400"
          >
            <AlertTriangle className="size-3.5" aria-hidden="true" />
          </span>
        )}
        {outdated && (
          <span
            title={lastUpdatedSentence(account.fetchedAt, nowSec)}
            className="shrink-0 rounded-sm border border-amber-500/40 bg-amber-500/15 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
          >
            Outdated
          </span>
        )}
        {account.plan && (
          <span className="rounded-sm border border-border bg-muted/50 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {account.plan}
          </span>
        )}
        {account.active && (
          <span className="rounded-sm border border-primary/40 bg-primary/15 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-primary">
            active
          </span>
        )}
      </div>

      {hasWindows ? (
        <div className="space-y-3">
          {account.windows.map((window) => (
            <WindowBlock key={window.id} window={window} error={account.error} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {account.error ?? "No usage windows reported."}
        </p>
      )}

      {spend && <SpendBlock spend={spend} />}

      {/* The timestamp lives down here, not in the header: harness name, account
          label and badges already fill that row and pushed it onto a second
          line. Always rendered, so the separator is consistent across cards and
          the action — present only where switching is meaningful — has a fixed
          place on the right. Staleness worth acting on is the header's
          "Outdated" tag; this is just the raw age. */}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
        <span className="text-[10px] text-muted-foreground/70" title={`source: ${account.source}`}>
          updated {formatFetched(account.fetchedAt, nowSec)}
        </span>
        {action}
      </div>
    </div>
  );
}

/**
 * API-equivalent spend at the foot of a card. The dollars describe what the
 * usage would have cost at API rates — a subscription is billed none of it —
 * so the disclaimer rides along in the tooltip and the panel repeats it once.
 * A harness that never reports cost says so; one that reports nothing yet
 * renders nothing, rather than a misleading $0.00.
 */
function SpendBlock({ spend }: { spend: AgentSpend }) {
  if (!spend.reported) {
    return (
      <div
        className="flex items-center gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground"
        title={SPEND_DISCLAIMER}
      >
        <span>Spend</span>
        <span className="ml-auto">not reported</span>
      </div>
    );
  }

  const today = formatUsd(spend.todayUsd);
  const total = formatUsd(spend.totalUsd);
  if (!today && !total) return null;

  return (
    <div className="space-y-1 border-t border-border/60 pt-2" title={SPEND_DISCLAIMER}>
      {today && <SpendLine label="Today" value={today} />}
      {total && <SpendLine label="Total" value={total} />}
    </div>
  );
}

function SpendLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function WindowBlock({ window, error }: { window: AgentLimitWindow; error?: string }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const left = percentLeft(window.usedPercent);
  // Ramp reads USED percent: full bar = plenty left, empty bar = spent.
  const ramp = limitRamp(window.usedPercent);
  const rateLimited = window.id === "rate_limited";
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{window.label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${LIMIT_BAR_RAMP_CLASSES[ramp]}`}
          style={{ width: `${left}%` }}
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span
          className={
            ramp === "danger"
              ? "font-medium text-red-600 dark:text-red-400"
              : "tabular-nums text-foreground"
          }
        >
          {left}% left
        </span>
        {rateLimited && (
          <span
            className="rounded-sm border border-red-500/40 bg-red-500/15 px-1.5 py-px text-[10px] font-medium text-red-600 dark:text-red-400"
            title={error ?? "The harness asked us to back off"}
          >
            Limit reached
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {window.resetsAt !== undefined ? resetSentence(window.resetsAt, nowSec) : ""}
        </span>
      </div>
    </div>
  );
}

function formatFetched(fetchedAt: number, nowSec: number): string {
  const ageSec = Math.max(0, nowSec - fetchedAt);
  if (ageSec < 90) return "just now";
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}
