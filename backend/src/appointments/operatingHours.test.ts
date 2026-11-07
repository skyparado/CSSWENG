import { describe, it, expect } from 'vitest';
import {
  checkWithinOperatingHours,
  nearestFreeTimes,
  wallClock,
  type ScheduleWindow,
} from './operatingHours.js';

// Mon–Fri 09:00–17:00, in Manila (UTC+8, no DST).
const weekday: ScheduleWindow[] = [1, 2, 3, 4, 5].map((d) => ({
  dayOfWeek: d,
  openTime: '09:00',
  closeTime: '17:00',
}));
const TZ = 'Asia/Manila';

describe('wallClock', () => {
  it('derives Manila local weekday and minute-of-day', () => {
    // 2026-01-05 02:30 UTC == 10:30 Mon in Manila.
    const wc = wallClock(new Date('2026-01-05T02:30:00Z'), TZ);
    expect(wc.dayOfWeek).toBe(1); // Monday
    expect(wc.minutes).toBe(10 * 60 + 30);
  });
});

describe('checkWithinOperatingHours', () => {
  it('accepts an appointment inside the window', () => {
    // 10:00–11:00 Mon Manila.
    const r = checkWithinOperatingHours(
      new Date('2026-01-05T02:00:00Z'),
      new Date('2026-01-05T03:00:00Z'),
      weekday,
      TZ,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an appointment that starts before opening', () => {
    // 08:00–09:30 Mon Manila.
    const r = checkWithinOperatingHours(
      new Date('2026-01-05T00:00:00Z'),
      new Date('2026-01-05T01:30:00Z'),
      weekday,
      TZ,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an appointment that ends after closing', () => {
    // 16:30–18:00 Mon Manila.
    const r = checkWithinOperatingHours(
      new Date('2026-01-05T08:30:00Z'),
      new Date('2026-01-05T10:00:00Z'),
      weekday,
      TZ,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a day the clinic is closed', () => {
    // Sunday 10:00 Manila.
    const r = checkWithinOperatingHours(
      new Date('2026-01-04T02:00:00Z'),
      new Date('2026-01-04T03:00:00Z'),
      weekday,
      TZ,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/closed/);
  });

  it('rejects endsAt not after startsAt', () => {
    const r = checkWithinOperatingHours(
      new Date('2026-01-05T03:00:00Z'),
      new Date('2026-01-05T03:00:00Z'),
      weekday,
      TZ,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an appointment spanning two days', () => {
    // 23:30 Mon -> 00:30 Tue Manila.
    const r = checkWithinOperatingHours(
      new Date('2026-01-05T15:30:00Z'),
      new Date('2026-01-05T16:30:00Z'),
      weekday,
      TZ,
    );
    expect(r.ok).toBe(false);
  });
});

describe('nearestFreeTimes', () => {
  const uerm = [
    { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
    { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
  ];
  const hour = 3_600_000;

  it('skips closed time and bookings, in clinic time', () => {
    // Mon 2026-01-05 12:10 Manila → first fit is 13:00 (05:00Z); 13:00–14:00 is booked.
    const busy: Array<[number, number]> = [[Date.parse('2026-01-05T05:00:00Z'), Date.parse('2026-01-05T06:00:00Z')]];
    const times = nearestFreeTimes(new Date('2026-01-05T04:10:00Z'), hour, uerm, 'Asia/Manila', busy);
    expect(times.map((d) => d.toISOString())).toEqual([
      '2026-01-05T06:00:00.000Z',
      '2026-01-05T06:30:00.000Z',
      '2026-01-05T07:00:00.000Z',
    ]);
  });

  it('rolls over to the next open day and gives up past the horizon', () => {
    const fromMonEvening = new Date('2026-01-05T09:00:00Z'); // 17:00 Manila, closed
    expect(nearestFreeTimes(fromMonEvening, hour, uerm, 'Asia/Manila', [], 1)[0].toISOString()).toBe(
      '2026-01-08T02:00:00.000Z', // Thu 10:00 Manila
    );
    expect(nearestFreeTimes(fromMonEvening, hour, [], 'Asia/Manila', [])).toEqual([]);
  });
});
