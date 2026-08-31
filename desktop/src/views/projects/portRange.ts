/**
 * Client-side validation for port-range input (`"4200-4299"` or a bare
 * `"4200"`). Immediate feedback only — the daemon re-parses the string and
 * remains the authority; its error is surfaced, never swallowed.
 */

const MAX_PORT = 65535;

/** Returns an error message, or null when the input is a valid range. */
export function portRangeInputError(input: string): string | null {
  const value = input.trim();
  if (!value) return "Enter a range like 4200-4299, or a single port.";
  const match = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(value);
  if (!match) {
    return "Use a range like 4200-4299, or a single port.";
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start > MAX_PORT || end > MAX_PORT) {
    return "Ports go up to 65535.";
  }
  if (end < start) {
    return "The end of the range must not come before its start.";
  }
  return null;
}

/** Normalized range string the daemon accepts, or null when invalid. */
export function normalizePortRange(input: string): string | null {
  if (portRangeInputError(input)) return null;
  const value = input.trim().replace(/\s*-\s*/, "-");
  if (/^\d+$/.test(value)) return value;
  const [start, end] = value.split("-").map(Number);
  if (end === start) return String(start);
  return `${start}-${end}`;
}
