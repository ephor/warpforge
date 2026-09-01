/**
 * Cron maths for the Automations screen: validation, next-occurrence preview
 * and human-readable schedule text.
 *
 * This mirrors the daemon's parser (the `cron` crate, 5-field form, IANA zone)
 * closely enough that the preview is what will actually fire. Two of that
 * crate's quirks are load-bearing here and are NOT standard Unix cron:
 *   - day-of-week is 1..7 with **1 = Sunday**; `0` is rejected outright;
 *   - when both day-of-month and day-of-week are restricted they are AND-ed,
 *     where Unix cron OR-s them.
 * The daemon is still the authority — it re-validates on create/update — but a
 * preview that disagreed with it would be worse than no preview.
 */

import type { AutomationPreset, AutomationTrigger } from "@/protocol";

const DOW_NAMES: Record<string, number> = {
  sun: 1,
  sunday: 1,
  mon: 2,
  monday: 2,
  tue: 3,
  tues: 3,
  tuesday: 3,
  wed: 4,
  wednesday: 4,
  thu: 5,
  thurs: 5,
  thursday: 5,
  fri: 6,
  friday: 6,
  sat: 7,
  saturday: 7,
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Sunday-first, matching the cron crate's 1..7 day-of-week ordinals. */
export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MON_TO_FRI = [2, 3, 4, 5, 6];

interface FieldSpec {
  min: number;
  max: number;
  label: string;
  names?: Record<string, number>;
}

const FIELDS: FieldSpec[] = [
  { label: "minute", max: 59, min: 0 },
  { label: "hour", max: 23, min: 0 },
  { label: "day of month", max: 31, min: 1 },
  { label: "month", max: 12, min: 1, names: MONTH_NAMES },
  { label: "day of week", max: 7, min: 1, names: DOW_NAMES },
];

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  /** 1 = Sunday … 7 = Saturday. */
  daysOfWeek: number[];
  /** True when the day-of-week field was `*`, i.e. it does not restrict days. */
  everyWeekday: boolean;
  /** True when the day-of-month field was `*`. */
  everyDayOfMonth: boolean;
}

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string };

function parseValue(token: string, spec: FieldSpec): number | null {
  const named = spec.names?.[token.toLowerCase()];
  if (named != null) return named;
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  if (value < spec.min || value > spec.max) return null;
  return value;
}

function parseField(raw: string, spec: FieldSpec): number[] | string {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) return `empty ${spec.label}`;
    const [body, stepText, ...rest] = piece.split("/");
    if (rest.length > 0) return `${spec.label} "${piece}" has too many steps`;
    let step = 1;
    if (stepText != null) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        return `${spec.label} step "${stepText}" must be a positive number`;
      }
      step = Number(stepText);
    }
    if (body === "*") {
      for (const value of range(spec.min, spec.max, step)) out.add(value);
      continue;
    }
    const dash = body.indexOf("-");
    if (dash > 0) {
      const from = parseValue(body.slice(0, dash), spec);
      const to = parseValue(body.slice(dash + 1), spec);
      if (from == null || to == null) return `${spec.label} range "${body}" is out of range`;
      if (from > to) return `${spec.label} range "${body}" runs backwards`;
      for (const value of range(from, to, step)) out.add(value);
      continue;
    }
    const single = parseValue(body, spec);
    if (single == null) {
      return spec.label === "day of week" && body === "0"
        ? "day of week is 1–7 (1 = Sunday), not 0"
        : `${spec.label} "${body}" is out of range (${spec.min}–${spec.max})`;
    }
    // `5/2` means "from 5 to the maximum, every 2" — same as the cron crate.
    if (stepText != null) {
      for (const value of range(single, spec.max, step)) out.add(value);
    } else {
      out.add(single);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += step) out.push(value);
  return out;
}

/** Parse a 5-field cron the way the daemon would, or explain why it cannot. */
export function parseCron(expression: string): CronParse {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    return {
      error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
      ok: false,
    };
  }
  const parsed: number[][] = [];
  for (let i = 0; i < FIELDS.length; i++) {
    const spec = FIELDS[i]!;
    const result = parseField(parts[i]!, spec);
    if (typeof result === "string") return { error: result, ok: false };
    if (result.length === 0) return { error: `${spec.label} matches nothing`, ok: false };
    parsed.push(result);
  }
  return {
    fields: {
      daysOfMonth: parsed[2]!,
      daysOfWeek: parsed[4]!,
      everyDayOfMonth: parts[2] === "*",
      everyWeekday: parts[4] === "*",
      hours: parsed[1]!,
      minutes: parsed[0]!,
      months: parsed[3]!,
    },
    ok: true,
  };
}

// ── Timezone maths ──────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timeZone || undefined,
    year: "numeric",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

export function runtimeTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimezone(timeZone: string): boolean {
  if (!timeZone) return true;
  try {
    const probe = new Intl.DateTimeFormat("en-US", { timeZone });
    return !!probe;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zoneParts(epochMs: number, timeZone: string): WallClock & { second: number } {
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    day: read("day"),
    // Intl's h23 hour cycle reports midnight as 24 in some engines.
    hour: read("hour") % 24,
    minute: read("minute"),
    month: read("month"),
    second: read("second"),
    year: read("year"),
  };
}

function wallClockOf(epochMs: number, timeZone: string): WallClock {
  const { year, month, day, hour, minute } = zoneParts(epochMs, timeZone);
  return { day, hour, minute, month, year };
}

/** How far ahead of UTC `timeZone` is at that instant. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const { year, month, day, hour, minute, second } = zoneParts(epochMs, timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms for a wall-clock time in `timeZone`. Two passes so a time on the
 *  far side of a DST shift resolves with the offset that actually applies. */
function wallClockToEpoch(wall: WallClock, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const firstGuess = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(firstGuess, timeZone);
}

/** 1 = Sunday … 7 = Saturday, matching the daemon's day-of-week ordinals. */
function weekdayOrdinal(wall: WallClock): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function afterWallClock(a: WallClock, b: WallClock): boolean {
  const key = (w: WallClock) =>
    w.year * 100000000 + w.month * 1000000 + w.day * 10000 + w.hour * 100 + w.minute;
  return key(a) > key(b);
}

const SEARCH_DAYS = 400;

/**
 * The next `count` occurrences strictly after `afterMs`, in epoch ms.
 * Returns fewer (or none) when the expression is invalid or matches nothing in
 * the search window — a cron can legitimately never fire again (Feb 30).
 */
export function nextOccurrences(
  trigger: AutomationTrigger,
  timezone: string,
  afterMs: number,
  count = 1,
): number[] {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok) return [];
  const zone = timezone || runtimeTimezone();
  const fields = parsed.fields;
  const from = wallClockOf(afterMs, zone);
  const out: number[] = [];
  const cursor = { day: from.day, month: from.month, year: from.year };

  for (let dayIndex = 0; dayIndex < SEARCH_DAYS && out.length < count; dayIndex++) {
    const { day, month, year } = cursor;
    const dayMatches =
      fields.months.includes(month) &&
      fields.daysOfMonth.includes(day) &&
      (fields.everyWeekday ||
        fields.daysOfWeek.includes(weekdayOrdinal({ ...cursor, hour: 0, minute: 0 })));
    if (dayMatches) {
      for (const hour of fields.hours) {
        for (const minute of fields.minutes) {
          const candidate: WallClock = { day, hour, minute, month, year };
          if (!afterWallClock(candidate, from)) continue;
          out.push(wallClockToEpoch(candidate, zone));
          if (out.length >= count) break;
        }
        if (out.length >= count) break;
      }
    }
    // Advance the calendar day, not the clock: a DST shift must not skip a day.
    if (cursor.day < daysInMonth(cursor.year, cursor.month)) {
      cursor.day += 1;
    } else if (cursor.month < 12) {
      cursor.day = 1;
      cursor.month += 1;
    } else {
      cursor.day = 1;
      cursor.month = 1;
      cursor.year += 1;
    }
  }
  return out;
}

// ── Presets ─────────────────────────────────────────────────────────────────

export interface PresetTime {
  hour: number;
  minute: number;
  /** 1 = Sunday … 7 = Saturday. Only read by the `weekly` preset. */
  weekday: number;
}

export const DEFAULT_PRESET_TIME: PresetTime = { hour: 9, minute: 0, weekday: 2 };

/** Expand a preset plus a time-of-day into the cron the daemon stores. */
export function presetCron(preset: AutomationPreset, time: PresetTime): string {
  const { hour, minute, weekday } = time;
  switch (preset) {
    case "hourly":
      return `${minute} * * * *`;
    case "every5":
      return "*/5 * * * *";
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * MON-FRI`;
    case "weekly":
      return `${minute} ${hour} * * ${WEEKDAY_SHORT[weekday - 1]?.toUpperCase() ?? "MON"}`;
    case "custom":
      return "0 9 * * *";
  }
}

/** Read a time-of-day back out of a cron so editing a preset keeps its time. */
export function presetTimeFromCron(cron: string, fallback = DEFAULT_PRESET_TIME): PresetTime {
  const parsed = parseCron(cron);
  if (!parsed.ok) return fallback;
  const { hours, minutes, daysOfWeek, everyWeekday } = parsed.fields;
  return {
    hour: hours.length === 1 ? hours[0]! : fallback.hour,
    minute: minutes.length === 1 ? minutes[0]! : fallback.minute,
    weekday: !everyWeekday && daysOfWeek.length === 1 ? daysOfWeek[0]! : fallback.weekday,
  };
}

// ── Human-readable text ─────────────────────────────────────────────────────

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function sameSet(values: number[], expected: number[]): boolean {
  return values.length === expected.length && expected.every((value) => values.includes(value));
}

/**
 * Plain-language schedule, e.g. "every day at 09:00" or "weekdays at 18:00".
 * Anything the phrasebook does not cover falls back to the cron itself, which
 * is honest: a made-up sentence for a schedule nobody can read is worse.
 */
export function describeSchedule(trigger: AutomationTrigger): string {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok) return trigger.cron;
  const { minutes, hours, daysOfMonth, months, daysOfWeek, everyWeekday, everyDayOfMonth } =
    parsed.fields;
  const everyMonth = months.length === 12;
  const everyHour = hours.length === 24;

  if (minutes.length === 1 && everyHour && everyDayOfMonth && everyWeekday && everyMonth) {
    return `every hour at :${String(minutes[0]).padStart(2, "0")}`;
  }
  if (everyHour && everyDayOfMonth && everyWeekday && everyMonth && trigger.cron === "*/5 * * * *") {
    return "every 5 minutes";
  }
  if (minutes.length !== 1 || hours.length !== 1 || !everyMonth) return `cron ${trigger.cron}`;

  const at = `at ${clock(hours[0]!, minutes[0]!)}`;
  if (everyDayOfMonth && everyWeekday) return `every day ${at}`;
  if (everyDayOfMonth && sameSet(daysOfWeek, MON_TO_FRI)) return `weekdays ${at}`;
  if (everyDayOfMonth && daysOfWeek.length === 1) {
    return `every ${WEEKDAY_LABELS[daysOfWeek[0]! - 1]} ${at}`;
  }
  if (everyDayOfMonth && daysOfWeek.length <= 4) {
    return `${daysOfWeek.map((day) => WEEKDAY_SHORT[day - 1]).join(", ")} ${at}`;
  }
  if (everyWeekday && daysOfMonth.length === 1) {
    return `day ${daysOfMonth[0]} of every month ${at}`;
  }
  return `cron ${trigger.cron}`;
}

/** "in 2h 14m" / "in 3d 4h" / "due now". Coarse on purpose: a schedule is not
 *  a stopwatch, and a seconds counter on a card only invites re-reading it. */
export function countdown(targetMs: number, nowMs: number): string {
  const delta = targetMs - nowMs;
  if (delta <= 0) return "due now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `in ${days}d` : `in ${days}d ${restHours}h`;
}

/** Wall-clock time of an instant in a specific zone, e.g. "09:00". */
export function clockInZone(epochMs: number, timezone: string): string {
  const wall = wallClockOf(epochMs, timezone || runtimeTimezone());
  return clock(wall.hour, wall.minute);
}
