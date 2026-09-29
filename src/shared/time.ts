/** Calendar date, `YYYY-MM-DD`. A day, not an instant. */
export type CalendarDate = string;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Today in `timeZone`, never the server's zone. */
export function todayIn(clock: Clock, timeZone: string): CalendarDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock.now());
}

/** Calendar arithmetic in UTC, so DST can never shift a day. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not a calendar date: ${date}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** RFC 3339 UTC instant for storage. */
export function instant(clock: Clock): string {
  return clock.now().toISOString();
}

/** A stored instant as the UI shows it: Hungarian short date and time in `timeZone`. */
export const formatInstant = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("hu-HU", { dateStyle: "short", timeStyle: "short", timeZone }).format(
    new Date(iso),
  );

/** Throws (a RangeError) unless `timeZone` is a zone the runtime knows. */
export function assertKnownTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat("en-CA", { timeZone });
}
