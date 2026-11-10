import { describe, expect, it } from 'vitest';
import { openNow } from './ClinicSelect';

// UERM: Mon 13:00–16:00. 2026-11-09 is a Monday; Manila is UTC+8.
const uerm = { timezone: 'Asia/Manila', schedules: [{ dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' }] };
const at = (iso: string) => new Date(`${iso}+08:00`);

describe('openNow', () => {
  it('is closed before opening', () => expect(openNow(uerm, at('2026-11-09T12:59'))).toBe(false));
  it('is open during hours', () => expect(openNow(uerm, at('2026-11-09T13:00'))).toBe(true));
  it('is closed after closing', () => expect(openNow(uerm, at('2026-11-09T16:00'))).toBe(false));
  it('is closed on a day with no hours', () => expect(openNow(uerm, at('2026-11-10T14:00'))).toBe(false));
});
