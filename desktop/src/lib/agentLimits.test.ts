import { describe, expect, it } from "vitest";

import type { AgentAccountLimits, AgentLimitWindow } from "../protocol";
import {
  activeAccountWorstWindow,
  formatResetDuration,
  formatResetRelative,
  formatUsd,
  headlineWindows,
  isSnapshotOutdated,
  lastUpdatedSentence,
  limitRamp,
  LIMITS_OUTDATED_AFTER_SEC,
  percentLeft,
  resetSentence,
  snapshotAgeSec,
  worstWindow,
} from "./agentLimits";

const NOW = 1_700_000_000;

const window = (usedPercent: number, id = "five_hour", label = "Session"): AgentLimitWindow => ({
  id,
  label,
  usedPercent,
});

const account = (overrides: Partial<AgentAccountLimits>): AgentAccountLimits => ({
  accountId: "claude:personal",
  agentId: "claude",
  label: "Personal",
  active: true,
  windows: [],
  exhausted: false,
  fetchedAt: NOW,
  source: "api",
  ...overrides,
});

describe("formatUsd", () => {
  it("shows cents under $10", () => {
    expect(formatUsd(1.23)).toBe("$1.23");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(9.5)).toBe("$9.50");
  });

  it("shows two decimals from $10 to $999", () => {
    expect(formatUsd(10)).toBe("$10.00");
    expect(formatUsd(12.34)).toBe("$12.34");
    expect(formatUsd(567.891)).toBe("$567.89");
    expect(formatUsd(999.99)).toBe("$999.99");
  });

  it("groups thousands and drops cents from $1,000 up", () => {
    expect(formatUsd(1000)).toBe("$1,000");
    expect(formatUsd(1234.56)).toBe("$1,235");
    expect(formatUsd(1_234_567)).toBe("$1,234,567");
  });

  it("does not render $1,000.00 for a value that rounds up to the boundary", () => {
    expect(formatUsd(999.995)).toBe("$1,000");
  });

  it("returns null instead of NaN or $undefined", () => {
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(undefined)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps the sign outside the dollar mark", () => {
    expect(formatUsd(-1.5)).toBe("-$1.50");
  });
});

describe("percentLeft", () => {
  it("converts used to remaining", () => {
    expect(percentLeft(95)).toBe(5);
    expect(percentLeft(78)).toBe(22);
    expect(percentLeft(53)).toBe(47);
  });

  it("keeps the extremes", () => {
    expect(percentLeft(0)).toBe(100);
    expect(percentLeft(100)).toBe(0);
  });

  it("rounds and clamps", () => {
    expect(percentLeft(40.4)).toBe(60);
    expect(percentLeft(40.6)).toBe(59);
    expect(percentLeft(120)).toBe(0);
    expect(percentLeft(-10)).toBe(100);
  });
});

describe("limitRamp", () => {
  it("is keyed on USED percent — a 95%-used account is danger", () => {
    expect(limitRamp(95)).toBe("danger");
    expect(limitRamp(100)).toBe("danger");
  });

  it("does not invert: a healthy 5%-used account is neutral", () => {
    expect(limitRamp(5)).toBe("neutral");
  });

  it("is warning from 70 to below 90", () => {
    expect(limitRamp(70)).toBe("warning");
    expect(limitRamp(78)).toBe("warning");
    expect(limitRamp(89.9)).toBe("warning");
  });

  it("is danger from 90 up", () => {
    expect(limitRamp(90)).toBe("danger");
  });
});

describe("reset formatting", () => {
  it("resetSentence capitalizes and reads like the reference", () => {
    expect(resetSentence(NOW + (4 * 60 + 57) * 60, NOW)).toBe("Resets in 4h 57m");
    expect(resetSentence(NOW + (3 * 24 * 60 + 6 * 60) * 60, NOW)).toBe("Resets in 3d 6h");
  });

  it("resetSentence handles a past reset", () => {
    expect(resetSentence(NOW - 120, NOW)).toBe("Resets now");
  });

  it("formatResetDuration is the bare duration", () => {
    expect(formatResetDuration(NOW + (2 * 60 + 14) * 60, NOW)).toBe("2h 14m");
    expect(formatResetDuration(NOW - 5, NOW)).toBe("now");
  });

  it("formatResetRelative keeps its lowercase sentence form", () => {
    expect(formatResetRelative(NOW + 5 * 60, NOW)).toBe("resets in 5m");
    expect(formatResetRelative(NOW - 120, NOW)).toBe("resets now");
  });

  it("does not treat resetsAt as milliseconds", () => {
    // 1_700_000_060_000 would be year 54xxx if misread as ms; seconds path
    // gives 1 minute.
    expect(formatResetRelative(NOW + 60, NOW)).toBe("resets in 1m");
  });
});

describe("snapshot age", () => {
  it("is not outdated just under the threshold", () => {
    expect(isSnapshotOutdated(NOW - (LIMITS_OUTDATED_AFTER_SEC - 1), NOW)).toBe(false);
    expect(isSnapshotOutdated(NOW - LIMITS_OUTDATED_AFTER_SEC, NOW)).toBe(false);
  });

  it("is outdated just over the threshold", () => {
    expect(isSnapshotOutdated(NOW - (LIMITS_OUTDATED_AFTER_SEC + 1), NOW)).toBe(true);
    expect(isSnapshotOutdated(NOW - 3 * 3600, NOW)).toBe(true);
  });

  it("leaves fresh data untagged", () => {
    expect(isSnapshotOutdated(NOW, NOW)).toBe(false);
    expect(isSnapshotOutdated(NOW - 60, NOW)).toBe(false);
  });

  it("phrases the age in minutes, hours and days", () => {
    expect(lastUpdatedSentence(NOW - 45 * 60, NOW)).toBe("Last updated 45m ago");
    expect(lastUpdatedSentence(NOW - 3 * 3600, NOW)).toBe("Last updated 3h ago");
    expect(lastUpdatedSentence(NOW - (3 * 3600 + 12 * 60), NOW)).toBe("Last updated 3h 12m ago");
    expect(lastUpdatedSentence(NOW - (2 * 86400 + 4 * 3600), NOW)).toBe("Last updated 2d 4h ago");
  });

  it("says just now for a snapshot under a minute old", () => {
    expect(lastUpdatedSentence(NOW - 5, NOW)).toBe("Last updated just now");
  });

  it("treats a fetchedAt in the future as age zero, not a negative age", () => {
    // Clock skew between daemon and UI must not read as "outdated" or as a
    // duration counting the wrong way.
    expect(snapshotAgeSec(NOW + 3600, NOW)).toBe(0);
    expect(isSnapshotOutdated(NOW + 3600, NOW)).toBe(false);
    expect(lastUpdatedSentence(NOW + 3600, NOW)).toBe("Last updated just now");
  });
});

describe("headlineWindows", () => {
  it("picks Session and Weekly out of a Claude account", () => {
    const found = headlineWindows([window(33), window(41, "seven_day", "Weekly")]);
    expect(found.session?.usedPercent).toBe(33);
    expect(found.weekly?.usedPercent).toBe(41);
  });

  it("matches on label, so Codex's primary/secondary ids resolve too", () => {
    const found = headlineWindows([
      window(12, "primary", "Session"),
      window(60, "secondary", "Weekly"),
    ]);
    expect(found.session?.id).toBe("primary");
    expect(found.weekly?.id).toBe("secondary");
  });

  it("reports Session alone when that is all there is", () => {
    const found = headlineWindows([window(33)]);
    expect(found.session?.usedPercent).toBe(33);
    expect(found.weekly).toBeNull();
  });

  it("reports Weekly alone when that is all there is", () => {
    const found = headlineWindows([window(70, "seven_day", "Weekly")]);
    expect(found.session).toBeNull();
    expect(found.weekly?.usedPercent).toBe(70);
  });

  it("is both-null for no windows at all", () => {
    expect(headlineWindows([])).toEqual({ session: null, weekly: null });
  });

  it("takes Session and Weekly from opencode's three windows, ignoring Monthly", () => {
    const found = headlineWindows([
      window(20, "rolling", "Session"),
      window(50, "weekly", "Weekly"),
      window(80, "monthly", "Monthly"),
    ]);
    expect(found.session?.id).toBe("rolling");
    expect(found.weekly?.id).toBe("weekly");
    // The busiest window of the three, and deliberately not on the trigger.
    expect([found.session?.id, found.weekly?.id]).not.toContain("monthly");
  });

  it("does not mistake Claude's per-model Weekly for the plain one", () => {
    const found = headlineWindows([
      window(90, "seven_day_opus", "Weekly (Opus)"),
      window(30, "seven_day", "Weekly"),
    ]);
    expect(found.weekly?.id).toBe("seven_day");
  });
});

describe("worstWindow", () => {
  it("picks the highest used window", () => {
    const windows = [window(10), window(80, "seven_day", "Weekly"), window(40)];
    expect(worstWindow(windows)?.id).toBe("seven_day");
  });

  it("returns null with no windows", () => {
    expect(worstWindow([])).toBeNull();
  });
});

describe("activeAccountWorstWindow", () => {
  it("reports the active account's worst window, not other accounts'", () => {
    // The exact bug this guards against: an idle second account sitting near
    // its weekly limit must not make the header show 95% while the task runs
    // on the active account at 5%.
    const accounts = [
      account({ label: "Personal", windows: [window(5)] }),
      account({
        accountId: "claude:work",
        label: "Work",
        active: false,
        windows: [window(95, "seven_day", "Weekly")],
      }),
    ];
    const worst = activeAccountWorstWindow(accounts, "claude");
    expect(worst?.account.accountId).toBe("claude:personal");
    expect(worst?.window.usedPercent).toBe(5);
  });

  it("follows a just-switched account before the limits snapshot catches up", () => {
    // Limits are refetched every 20 minutes, so right after a switch their
    // `active` flag still names the previous login. The account snapshot is
    // current, so its id wins — otherwise both logins show the same number.
    const accounts = [
      account({ label: "Personal", windows: [window(31)] }),
      account({
        accountId: "claude:work",
        label: "Work",
        active: false,
        windows: [window(72, "seven_day", "Weekly")],
      }),
    ];
    const worst = activeAccountWorstWindow(accounts, "claude", "claude:work");
    expect(worst?.account.accountId).toBe("claude:work");
    expect(worst?.window.usedPercent).toBe(72);
  });

  it("falls back to the reported flag for an unregistered live login", () => {
    const accounts = [
      account({ accountId: "codex:live", agentId: "codex", windows: [window(42)] }),
    ];
    // "codex:live" matches no registered account id, so no id is passed.
    const worst = activeAccountWorstWindow(accounts, "codex", null);
    expect(worst?.account.accountId).toBe("codex:live");
  });

  it("takes the worst window within the active account", () => {
    const accounts = [
      account({ label: "Personal", windows: [window(40), window(81, "seven_day", "Weekly")] }),
    ];
    expect(activeAccountWorstWindow(accounts, "claude")?.window.label).toBe("Weekly");
  });

  it("returns null with no active account, but reports a real 0%", () => {
    expect(
      activeAccountWorstWindow([account({ active: false, windows: [window(50)] })], "claude"),
    ).toBeNull();
    expect(
      activeAccountWorstWindow([account({ windows: [window(0)] })], "claude")?.window.usedPercent,
    ).toBe(0);
    expect(activeAccountWorstWindow([account({ windows: [] })], "claude")).toBeNull();
  });
});
