export interface SnoozePreset {
  id: string;
  label: string;
  until: number;
}

function toDate(input: Date | number): Date {
  return typeof input === "number" ? new Date(input) : input;
}

function localDateAt(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): number {
  return new Date(year, month, day, hours, minutes, 0, 0).getTime();
}

function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function snoozeOneHour(now: Date | number): number {
  const base = toDate(now).getTime();
  return toUnixSeconds(base + 60 * 60 * 1000);
}

export function snoozeThisEvening(now: Date | number): { until: number; label: string } {
  const d = toDate(now);
  const eveningMs = localDateAt(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0);
  if (eveningMs > d.getTime()) {
    return { until: toUnixSeconds(eveningMs), label: "This evening" };
  }
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 18, 0, 0, 0);
  return { until: toUnixSeconds(tomorrow.getTime()), label: "Tomorrow evening" };
}

export function snoozeTomorrowMorning(now: Date | number): number {
  const d = toDate(now);
  const ms = localDateAt(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0);
  return toUnixSeconds(ms);
}

export function snoozeNextMonday(now: Date | number): number {
  const d = toDate(now);
  const dayOfWeek = d.getDay();
  const daysAhead = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7;
  const ms = localDateAt(d.getFullYear(), d.getMonth(), d.getDate() + daysAhead, 9, 0);
  return toUnixSeconds(ms);
}

export function buildSnoozePresets(now: Date | number): SnoozePreset[] {
  const evening = snoozeThisEvening(now);
  return [
    { id: "one-hour", label: "1 hour", until: snoozeOneHour(now) },
    { id: "this-evening", label: evening.label, until: evening.until },
    { id: "tomorrow-morning", label: "Tomorrow morning", until: snoozeTomorrowMorning(now) },
    { id: "next-monday", label: "Next Monday", until: snoozeNextMonday(now) },
  ];
}
