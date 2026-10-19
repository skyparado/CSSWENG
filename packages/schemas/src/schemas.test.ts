import { describe, it, expect } from 'vitest';
import { clinicScheduleCreateSchema } from './clinic.js';
import { appointmentCreateSchema } from './appointment.js';
import { timeToMinutes } from './common.js';

describe('clinicScheduleCreateSchema', () => {
  it('rejects a window where open is not before close', () => {
    const r = clinicScheduleCreateSchema.safeParse({
      dayOfWeek: 1,
      openTime: '17:00',
      closeTime: '09:00',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid window', () => {
    const r = clinicScheduleCreateSchema.safeParse({
      dayOfWeek: 1,
      openTime: '09:00',
      closeTime: '17:00',
    });
    expect(r.success).toBe(true);
  });
});

describe('appointmentCreateSchema', () => {
  it('rejects endsAt before startsAt', () => {
    const r = appointmentCreateSchema.safeParse({
      clinicId: 'c1',
      patientId: 'p1',
      startsAt: '2026-01-01T10:00:00Z',
      endsAt: '2026-01-01T09:00:00Z',
    });
    expect(r.success).toBe(false);
  });
});

describe('timeToMinutes', () => {
  it('converts HH:mm to minutes since midnight', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('23:59')).toBe(1439);
  });
});
