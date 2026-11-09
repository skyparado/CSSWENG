import { describe, expect, it } from 'vitest';
import { addDays, describeHours, freeSlots, zonedParts, zonedToUtc } from './time';

const MNL = 'Asia/Manila';
const UERM = [
  { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
  { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
];

describe('clinic time helpers', () => {
  it('converts clinic wall-clock time to UTC and back', () => {
    expect(zonedToUtc('2026-01-05', '13:00', MNL).toISOString()).toBe('2026-01-05T05:00:00.000Z');
    expect(zonedToUtc('2026-07-06', '09:30', 'America/New_York').toISOString()).toBe('2026-07-06T13:30:00.000Z');
    expect(zonedParts(new Date('2026-01-04T17:30:00Z'), MNL)).toEqual({
      date: '2026-01-05',
      time: '01:30',
      dayOfWeek: 1,
    });
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('lists free 30-minute slots inside hours, minus bookings and the past', () => {
    const busy: Array<[number, number]> = [
      [Date.parse('2026-01-05T05:30:00Z'), Date.parse('2026-01-05T06:00:00Z')], // 13:30 Manila
    ];
    const past = Date.parse('2025-12-01T00:00:00Z');
    expect(freeSlots('2026-01-05', UERM, MNL, busy, past)).toEqual(['13:00', '14:00', '14:30', '15:00', '15:30']);
    expect(freeSlots('2026-01-06', UERM, MNL, [], past)).toEqual([]); // Tuesday: closed
    expect(freeSlots('2026-01-05', UERM, MNL, [], Date.parse('2026-01-05T06:10:00Z'))).toEqual(['14:30', '15:00', '15:30']);
  });

  it('describes weekly hours', () => {
    expect(describeHours(UERM)).toEqual(['Mon 1:00 PM–4:00 PM', 'Thu 10:00 AM–12:00 PM']);
  });
});
