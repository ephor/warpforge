import { limitRamp, LIMIT_BAR_RAMP_CLASSES, percentLeft, resetSentence } from "@/lib/agentLimits";
import type { AgentLimitWindow } from "@/protocol";

/**
 * Every quota window of one account on a single line: label, a bar filled
 * proportional to what is LEFT, and the percentage.
 *
 * The full breakdown — reset times spelled out, spend, staleness — is the
 * header's account menu, which is where you go when deciding to switch login.
 * In Settings the numbers answer a narrower question, "is there room here",
 * so they ride along the account they belong to instead of being repeated as
 * a second list of cards.
 */
export function AccountQuotaStrip({ windows }: { windows: AgentLimitWindow[] }) {
  if (windows.length === 0) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {windows.map((window) => {
        const left = percentLeft(window.usedPercent);
        // Ramp reads USED percent: full bar = plenty left, empty bar = spent.
        const ramp = limitRamp(window.usedPercent);
        return (
          <span
            key={window.id}
            className="flex items-center gap-1.5 text-[11px]"
            title={
              window.resetsAt !== undefined ? resetSentence(window.resetsAt, nowSec) : undefined
            }
          >
            <span className="text-muted-foreground">{window.label}</span>
            <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${LIMIT_BAR_RAMP_CLASSES[ramp]}`}
                style={{ width: `${left}%` }}
              />
            </span>
            <span
              className={
                ramp === "danger"
                  ? "font-medium tabular-nums text-red-600 dark:text-red-400"
                  : "tabular-nums text-muted-foreground"
              }
            >
              {left}%
            </span>
          </span>
        );
      })}
    </div>
  );
}
