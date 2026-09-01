import { describe, expect, it } from "vitest";

import {
  countdown,
  describeSchedule,
  nextOccurrences,
  parseCron,
  presetCron,
  presetTimeFromCron,
} from "./automationSchedule";

const trigger = (cron: string) => ({ cron, preset: "custom" as const });

/** Wall-clock rendering of an instant in a zone, for readable assertions. */
function inZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "short",
    year: "numeric",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("weekday")}`;
}

describe("parseCron", () => {
  it("accepts the daemon's preset expressions", () => {
    const presets = ["0 * * * *", "0 9 * * *", "0 9 * * MON-FRI", "0 9 * * MON"];
    expect(presets.filter((cron) => parseCron(cron).ok)).toEqual(presets);
  });

  it("rejects what the daemon would reject", () => {
    expect(parseCron("nonsense").ok).toBe(false);
    expect(parseCron("61 * * * *").ok).toBe(false);
    expect(parseCron("0 9 * *").ok).toBe(false);
    // The cron crate numbers weekdays 1..7 with Sunday=1, so 0 is not a day.
    const zero = parseCron("0 9 * * 0");
    expect(zero.ok).toBe(false);
    expect(zero.ok === false && zero.error).toContain("1 = Sunday");
  });

  it("expands steps, ranges and lists", () => {
    const parsed = parseCron("*/15 9-11 * * MON,WED");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields.minutes).toEqual([0, 15, 30, 45]);
    expect(parsed.fields.hours).toEqual([9, 10, 11]);
    expect(parsed.fields.daysOfWeek).toEqual([2, 4]);
    expect(parsed.fields.everyWeekday).toBe(false);
  });
});

describe("nextOccurrences", () => {
  it("keeps a daily schedule at its local time across a DST shift", () => {
    // 2025-03-09 is the US spring-forward day.
    const after = Date.UTC(2025, 2, 9, 0, 0);
    const [first, second] = nextOccurrences(trigger("0 9 * * *"), "America/New_York", after, 2);
    expect(inZone(first!, "America/New_York")).toBe("2025-03-09 09:00 Sun");
    expect(inZone(second!, "America/New_York")).toBe("2025-03-10 09:00 Mon");
  });

  it("skips the weekend for the weekdays preset", () => {
    // 2026-01-16 is a Friday, 15:00 UTC — past that day's 09:00.
    const friday = Date.UTC(2026, 0, 16, 15, 0);
    const [next] = nextOccurrences(trigger("0 9 * * MON-FRI"), "UTC", friday, 1);
    expect(inZone(next!, "UTC")).toBe("2026-01-19 09:00 Mon");
  });

  it("walks hour and minute sets in order", () => {
    const after = Date.UTC(2026, 0, 16, 9, 20);
    const times = nextOccurrences(trigger("0,30 9-10 * * *"), "UTC", after, 3).map((ms) =>
      inZone(ms, "UTC"),
    );
    expect(times).toEqual(["2026-01-16 09:30 Fri", "2026-01-16 10:00 Fri", "2026-01-16 10:30 Fri"]);
  });

  it("returns nothing for a schedule that can never fire", () => {
    expect(nextOccurrences(trigger("0 9 30 2 *"), "UTC", Date.UTC(2026, 0, 1), 1)).toEqual([]);
  });
});

describe("describeSchedule", () => {
  it("phrases the schedules the pickers produce", () => {
    expect(describeSchedule(trigger("0 * * * *"))).toBe("every hour at :00");
    expect(describeSchedule(trigger("0 9 * * *"))).toBe("every day at 09:00");
    expect(describeSchedule(trigger("30 18 * * MON-FRI"))).toBe("weekdays at 18:30");
    expect(describeSchedule(trigger("0 9 * * MON"))).toBe("every Monday at 09:00");
    expect(describeSchedule(trigger("0 9 1 * *"))).toBe("day 1 of every month at 09:00");
  });

  it("falls back to the expression rather than inventing prose", () => {
    expect(describeSchedule(trigger("*/7 * * * *"))).toBe("cron */7 * * * *");
    expect(describeSchedule(trigger("bogus"))).toBe("bogus");
  });
});

describe("presets", () => {
  it("round-trips a preset time through its cron", () => {
    const cron = presetCron("weekly", { hour: 18, minute: 30, weekday: 6 });
    expect(cron).toBe("30 18 * * FRI");
    expect(presetTimeFromCron(cron)).toEqual({ hour: 18, minute: 30, weekday: 6 });
    expect(describeSchedule(trigger(cron))).toBe("every Friday at 18:30");
  });
});

describe("countdown", () => {
  it("reads as an interval, not a stopwatch", () => {
    const now = 1_700_000_000_000;
    expect(countdown(now - 1, now)).toBe("due now");
    expect(countdown(now + 30_000, now)).toBe("in under a minute");
    expect(countdown(now + 14 * 60_000, now)).toBe("in 14m");
    expect(countdown(now + (2 * 60 + 14) * 60_000, now)).toBe("in 2h 14m");
    expect(countdown(now + 3 * 86_400_000, now)).toBe("in 3d");
  });
});
