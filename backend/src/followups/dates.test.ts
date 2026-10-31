import { describe, expect, it } from 'vitest';
import { addDays, daysOverdue, todayInTimezone, toDateOnly } from './dates.js';

describe('todayInTimezone', () => {
  it('uses the clinic timezone, not UTC, to decide the date', () => {
    // 20:00Z on the 4th is already 04:00 on the 5th in Manila (UTC+8).
    const now = new Date('2026-11-04T20:00:00Z');
    expect(todayInTimezone('UTC', now)).toBe('2026-11-04');
    expect(todayInTimezone('Asia/Manila', now)).toBe('2026-11-05');
  });
});

describe('addDays', () => {
  it('moves across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('daysOverdue', () => {
  it('counts whole days past the due date', () => {
    expect(daysOverdue(toDateOnly('2026-11-01'), '2026-11-05')).toBe(4);
  });

  it('is zero on the due date and negative before it', () => {
    expect(daysOverdue(toDateOnly('2026-11-05'), '2026-11-05')).toBe(0);
    expect(daysOverdue(toDateOnly('2026-11-06'), '2026-11-05')).toBe(-1);
  });
});
