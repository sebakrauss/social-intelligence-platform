/**
 * Comments 2.1 (Step 7B-17R) — how a time reads in the person's own time zone (their browser's), in the house form the
 * page already used for UTC (Manual §7 mono-s): short "08 NOV 20:14", exact "08 NOV 2026 · 20:14 GMT-3". Pure: the
 * instant, the reference "now", the time shown just above and the zone come in; nothing is read from the clock or the
 * page here. The server keeps every instant in UTC (and the <time dateTime> keeps the ISO instant); only the reading
 * changes. Without JavaScript the page keeps the UTC form it was rendered with.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const numeric = new Map<string, Intl.DateTimeFormat>();

/** The calendar parts of an instant in a zone (undefined zone: the runtime's own). */
function partsOf(date: Date, timeZone: string | undefined): LocalParts {
  const key = timeZone ?? "";
  let format = numeric.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    numeric.set(key, format);
  }
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(format.formatToParts(date).find((part) => part.type === type)?.value ?? "0");
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour") % 24, minute: value("minute") };
}

const two = (value: number): string => String(value).padStart(2, "0");
const sameDay = (a: LocalParts, b: LocalParts): boolean => a.year === b.year && a.month === b.month && a.day === b.day;
const clockOf = (parts: LocalParts): string => `${two(parts.hour)}:${two(parts.minute)}`;
const dayMonth = (parts: LocalParts): string => `${two(parts.day)} ${MONTHS[parts.month - 1] ?? "???"}`;

/** The zone's short name at that instant ("GMT-3", "GMT+5:30"); "UTC" for a zero offset. */
export function zoneLabel(date: Date, timeZone: string | undefined): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
  return name === "" || /^(GMT|UTC)([+-]0(:00)?)?$/.test(name) ? "UTC" : name;
}

/** The exact reading: date, year, minute and zone — "08 NOV 2026 · 20:14 GMT-3". */
export function localFull(date: Date, timeZone?: string): string {
  const parts = partsOf(date, timeZone);
  return `${dayMonth(parts)} ${String(parts.year)} · ${clockOf(parts)} ${zoneLabel(date, timeZone)}`;
}

/**
 * The short reading, as the UTC one behaved (Step 7B-15S/15U), but by the person's own calendar: only the clock when the
 * time shown just above was the same local day; the year unless it is the current local year.
 */
export function localShort(date: Date, now: Date, previous?: Date, timeZone?: string): string {
  const parts = partsOf(date, timeZone);
  if (previous !== undefined && sameDay(parts, partsOf(previous, timeZone))) return clockOf(parts);
  if (partsOf(now, timeZone).year === parts.year) return `${dayMonth(parts)} ${clockOf(parts)}`;
  return `${dayMonth(parts)} ${String(parts.year)} ${clockOf(parts)}`;
}

/**
 * The reading of one serialized instant now, in the runtime's own zone: `fallback` (the server's UTC reading) when the
 * instant cannot be read. `previous` is the instant shown just above, for the short form.
 */
export function localReading(iso: string, form: "short" | "full", fallback: string, previous?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  if (form === "full") return localFull(date);
  const before = previous === undefined ? undefined : new Date(previous);
  return localShort(date, new Date(), before !== undefined && !Number.isNaN(before.getTime()) ? before : undefined);
}
