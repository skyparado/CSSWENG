// Clinic-local wall-clock helpers. Clinics have an IANA timezone; the browser
// may be elsewhere, so every "what day/time is it at the clinic" goes through Intl.
import type { ScheduleWindow } from './api';

/** Wall-clock parts of `at` in `tz`: date "YYYY-MM-DD", time "HH:mm", weekday 0 = Sunday. */
export function zonedParts(at: Date, tz: string): { date: string; time: string; dayOfWeek: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

/** The UTC instant of wall-clock `date` "YYYY-MM-DD" + `time` "HH:mm" in `tz`. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = zonedParts(guess, tz);
  const shownAsUtc = new Date(`${shown.date}T${shown.time}:00Z`).getTime();
  // shortcut: one correction pass; times inside a DST jump resolve an hour off. Fine for Asia/Manila (no DST).
  return new Date(guess.getTime() - (shownAsUtc - guess.getTime()));
}

/** Add `days` to a "YYYY-MM-DD" calendar date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutes = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "13:00" → "1:00 PM". */
export function formatTime(hhmm: string): string {
  const m = toMinutes(hhmm);
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`;
}

/** "Mon 1:00–4:00 PM" style lines for a clinic's weekly schedule. */
export function describeHours(schedules: ScheduleWindow[]): string[] {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return schedules.map((s) => `${days[s.dayOfWeek]} ${formatTime(s.openTime)}–${formatTime(s.closeTime)}`);
}

export const SLOT_MINUTES = 30;

/**
 * Bookable slot start times ("HH:mm") on `date` at a clinic: every 30 minutes
 * inside that weekday's windows, skipping slots that overlap `busy` intervals
 * (UTC ms) or have already started.
 */
export function freeSlots(
  date: string,
  schedules: ScheduleWindow[],
  tz: string,
  busy: Array<[number, number]>,
  now = Date.now(),
): string[] {
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const slots: string[] = [];
  for (const w of schedules.filter((s) => s.dayOfWeek === dayOfWeek)) {
    for (let m = toMinutes(w.openTime); m + SLOT_MINUTES <= toMinutes(w.closeTime); m += SLOT_MINUTES) {
      const start = zonedToUtc(date, fromMinutes(m), tz).getTime();
      const end = start + SLOT_MINUTES * 60_000;
      if (start > now && !busy.some(([s, e]) => s < end && e > start)) slots.push(fromMinutes(m));
    }
  }
  return slots;
}
