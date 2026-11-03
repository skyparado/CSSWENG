const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's calendar date (`YYYY-MM-DD`) in `timeZone`. */
export function todayInTimezone(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `YYYY-MM-DD` to a UTC-midnight Date, the form Prisma uses for `@db.Date`. */
export function toDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Add whole days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  return new Date(toDateOnly(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `due` to `today` (positive when `due` is in the past). */
export function daysOverdue(due: Date, today: string): number {
  return Math.round((toDateOnly(today).getTime() - due.getTime()) / DAY_MS);
}
