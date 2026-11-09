/**
 * Clinic-local date helpers for the reports. All of Dr. Pacio's clinics keep
 * Philippine time (a fixed UTC+8, no daylight saving), but every function takes
 * the time zone so a clinic with another zone still groups correctly.
 */

/** The `YYYY-MM-DD` date of an instant on the wall clock of `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The instant at which `date` (`YYYY-MM-DD`) begins on the wall clock of `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(guess - (asLocal - guess));
}

/** Half-open UTC bounds `[start, end)` covering the inclusive local dates `from`..`to`. */
export function rangeBounds(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  const dayAfter = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: startOfLocalDay(from, timeZone), end: startOfLocalDay(dayAfter, timeZone) };
}
