import { timeToMinutes, type TimeOfDay } from '@clinic/schemas';

export interface ScheduleWindow {
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday
  openTime: TimeOfDay; // "HH:mm"
  closeTime: TimeOfDay; // "HH:mm"
}

/**
 * The wall-clock day-of-week and minute-of-day for an instant in a given IANA
 * timezone. Uses Intl so no external tz library is needed.
 */
export function wallClock(
  at: Date,
  timezone: string,
): { dayOfWeek: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  let dayOfWeek = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') dayOfWeek = map[p.value] ?? 0;
    else if (p.type === 'hour') hour = p.value === '24' ? 0 : Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
  }
  return { dayOfWeek, minutes: hour * 60 + minute };
}

export type OperatingHoursResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check that an appointment [startsAt, endsAt) fits entirely inside one of the
 * clinic's operating windows for that weekday, evaluated in the clinic timezone.
 *
 * Pure and deterministic — unit tested in operatingHours.test.ts.
 */
export function checkWithinOperatingHours(
  startsAt: Date,
  endsAt: Date,
  schedules: ScheduleWindow[],
  timezone: string,
): OperatingHoursResult {
  if (endsAt.getTime() <= startsAt.getTime()) {
    return { ok: false, reason: 'endsAt must be after startsAt' };
  }

  const start = wallClock(startsAt, timezone);
  const end = wallClock(endsAt, timezone);

  // Reject appointments that cross midnight (and therefore weekdays); the
  // clinic schedule model is per-weekday.
  if (start.dayOfWeek !== end.dayOfWeek) {
    return {
      ok: false,
      reason: 'appointment must start and end on the same day',
    };
  }

  const dayWindows = schedules.filter((s) => s.dayOfWeek === start.dayOfWeek);
  if (dayWindows.length === 0) {
    return { ok: false, reason: 'clinic is closed on this day' };
  }

  const fits = dayWindows.some((w) => {
    const open = timeToMinutes(w.openTime);
    const close = timeToMinutes(w.closeTime);
    return start.minutes >= open && end.minutes <= close;
  });

  return fits
    ? { ok: true }
    : { ok: false, reason: 'appointment falls outside operating hours' };
}
