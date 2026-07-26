import { describe, expect, it } from "vitest";

import {
  buildSnoozePresets,
  snoozeNextMonday,
  snoozeOneHour,
  snoozeThisEvening,
  snoozeTomorrowMorning,
} from "./snooze";

function localMs(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): number {
  return new Date(year, month, day, hours, minutes, 0, 0).getTime();
}

function localSeconds(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): number {
  return Math.floor(localMs(year, month, day, hours, minutes) / 1000);
}

describe("snoozeOneHour", () => {
  it("returns now + 3600 seconds", () => {
    const now = localMs(2026, 6, 15, 10, 0);
    const result = snoozeOneHour(now);
    expect(result).toBe(localSeconds(2026, 6, 15, 11, 0));
  });

  it("accepts a Date object", () => {
    const d = new Date(2026, 6, 15, 10, 0, 0, 0);
    expect(snoozeOneHour(d)).toBe(localSeconds(2026, 6, 15, 11, 0));
  });
});

describe("snoozeThisEvening", () => {
  it("returns today 18:00 with label 'This evening' when before 18:00", () => {
    const now = localMs(2026, 6, 15, 10, 0);
    const result = snoozeThisEvening(now);
    expect(result.label).toBe("This evening");
    expect(result.until).toBe(localSeconds(2026, 6, 15, 18, 0));
  });

  it("returns tomorrow 18:00 with label 'Tomorrow evening' when after 18:00", () => {
    const now = localMs(2026, 6, 15, 20, 0);
    const result = snoozeThisEvening(now);
    expect(result.label).toBe("Tomorrow evening");
    expect(result.until).toBe(localSeconds(2026, 6, 16, 18, 0));
  });

  it("returns tomorrow 18:00 when exactly at 18:00", () => {
    const now = localMs(2026, 6, 15, 18, 0);
    const result = snoozeThisEvening(now);
    expect(result.label).toBe("Tomorrow evening");
    expect(result.until).toBe(localSeconds(2026, 6, 16, 18, 0));
  });
});

describe("snoozeTomorrowMorning", () => {
  it("returns tomorrow 09:00", () => {
    const now = localMs(2026, 6, 15, 10, 0);
    expect(snoozeTomorrowMorning(now)).toBe(localSeconds(2026, 6, 16, 9, 0));
  });

  it("returns tomorrow 09:00 even when already past 09:00", () => {
    const now = localMs(2026, 6, 15, 23, 0);
    expect(snoozeTomorrowMorning(now)).toBe(localSeconds(2026, 6, 16, 9, 0));
  });
});

describe("snoozeNextMonday", () => {
  it("from Monday returns next week Monday (7 days)", () => {
    const monday = localMs(2026, 6, 13, 10, 0);
    const d = new Date(monday);
    expect(d.getDay()).toBe(1);
    expect(snoozeNextMonday(monday)).toBe(localSeconds(2026, 6, 20, 9, 0));
  });

  it("from Sunday returns tomorrow Monday (1 day)", () => {
    const sunday = localMs(2026, 6, 12, 10, 0);
    const d = new Date(sunday);
    expect(d.getDay()).toBe(0);
    expect(snoozeNextMonday(sunday)).toBe(localSeconds(2026, 6, 13, 9, 0));
  });

  it("from Saturday returns Monday (2 days)", () => {
    const saturday = localMs(2026, 6, 11, 10, 0);
    const d = new Date(saturday);
    expect(d.getDay()).toBe(6);
    expect(snoozeNextMonday(saturday)).toBe(localSeconds(2026, 6, 13, 9, 0));
  });

  it("from Tuesday returns Monday (6 days)", () => {
    const tuesday = localMs(2026, 6, 14, 10, 0);
    const d = new Date(tuesday);
    expect(d.getDay()).toBe(2);
    expect(snoozeNextMonday(tuesday)).toBe(localSeconds(2026, 6, 20, 9, 0));
  });
});

describe("buildSnoozePresets", () => {
  it("returns four presets with stable ids", () => {
    const now = localMs(2026, 6, 15, 10, 0);
    const presets = buildSnoozePresets(now);
    expect(presets.map((p) => p.id)).toStrictEqual([
      "one-hour",
      "this-evening",
      "tomorrow-morning",
      "next-monday",
    ]);
  });

  it("all presets are strictly future", () => {
    const nowMs = localMs(2026, 6, 15, 10, 0);
    const nowSec = Math.floor(nowMs / 1000);
    const presets = buildSnoozePresets(nowMs);
    for (const preset of presets) {
      expect(preset.until).toBeGreaterThan(nowSec);
    }
  });

  it("calendar presets have seconds=0 and ms=0", () => {
    const now = localMs(2026, 6, 15, 10, 30);
    const presets = buildSnoozePresets(now);
    for (const preset of presets) {
      const ms = preset.until * 1000;
      const d = new Date(ms);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMilliseconds()).toBe(0);
    }
  });

  it("calendar presets use local time components (DST-safe)", () => {
    const now = localMs(2026, 6, 15, 10, 0);
    const presets = buildSnoozePresets(now);

    const evening = presets.find((p) => p.id === "this-evening")!;
    const eveningDate = new Date(evening.until * 1000);
    expect(eveningDate.getHours()).toBe(18);
    expect(eveningDate.getMinutes()).toBe(0);

    const tomorrow = presets.find((p) => p.id === "tomorrow-morning")!;
    const tomorrowDate = new Date(tomorrow.until * 1000);
    expect(tomorrowDate.getHours()).toBe(9);
    expect(tomorrowDate.getMinutes()).toBe(0);
    expect(tomorrowDate.getDate()).toBe(new Date(now).getDate() + 1);

    const monday = presets.find((p) => p.id === "next-monday")!;
    const mondayDate = new Date(monday.until * 1000);
    expect(mondayDate.getDay()).toBe(1);
    expect(mondayDate.getHours()).toBe(9);
    expect(mondayDate.getMinutes()).toBe(0);
  });

  it("evening label changes after 18:00", () => {
    const before = buildSnoozePresets(localMs(2026, 6, 15, 10, 0));
    expect(before.find((p) => p.id === "this-evening")!.label).toBe("This evening");

    const after = buildSnoozePresets(localMs(2026, 6, 15, 20, 0));
    expect(after.find((p) => p.id === "this-evening")!.label).toBe("Tomorrow evening");
  });
});
