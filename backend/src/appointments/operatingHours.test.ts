import { describe, it, expect } from 'vitest';
import {
  checkWithinOperatingHours,
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
