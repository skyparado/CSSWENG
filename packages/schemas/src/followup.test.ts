import { describe, expect, it } from 'vitest';
import {
  calendarDateSchema,
  consentCreateSchema,
  followUpCreateSchema,
  followUpDeclineSchema,
  followUpDueQuerySchema,
  followUpQuerySchema,
  followUpRemindSchema,
  outreachCreateSchema,
} from './followup.js';

describe('calendarDateSchema', () => {
  it('accepts a real date and rejects other shapes', () => {
    expect(calendarDateSchema.safeParse('2026-11-05').success).toBe(true);
    expect(calendarDateSchema.safeParse('2026-11-05T00:00:00Z').success).toBe(false);
    expect(calendarDateSchema.safeParse('11/05/2026').success).toBe(false);
    expect(calendarDateSchema.safeParse('2026-13-45').success).toBe(false);
  });
});

describe('consentCreateSchema', () => {
  const base = { patientId: 'p1', isGranted: true, captureMethod: 'IN_PERSON' } as const;

  it('requires a channel for reminder consent', () => {
    const r = consentCreateSchema.safeParse({ ...base, consentType: 'REMINDER' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('channel');
  });

  it('accepts reminder consent with a channel', () => {
    expect(
      consentCreateSchema.safeParse({ ...base, consentType: 'REMINDER', channel: 'SMS' }).success,
    ).toBe(true);
  });

  it('rejects a channel on data-processing consent', () => {
    expect(
      consentCreateSchema.safeParse({ ...base, consentType: 'DATA_PROCESSING', channel: 'SMS' })
        .success,
    ).toBe(false);
  });

  it('rejects CALL as a reminder channel', () => {
    expect(
      consentCreateSchema.safeParse({ ...base, consentType: 'REMINDER', channel: 'CALL' }).success,
    ).toBe(false);
  });

  it('requires an explicit yes/no', () => {
    const { isGranted: _omit, ...rest } = base;
    expect(
      consentCreateSchema.safeParse({ ...rest, consentType: 'DATA_PROCESSING' }).success,
    ).toBe(false);
  });
});

describe('followUpCreateSchema', () => {
  const valid = {
    patientId: 'p1',
    taskType: 'CHECK_UP',
    reason: 'Pressure check',
    dueDate: '2026-12-01',
  };

  it('defaults priority to NORMAL', () => {
    const r = followUpCreateSchema.parse(valid);
    expect(r.priority).toBe('NORMAL');
  });

  it('requires a reason and a valid task type', () => {
    expect(followUpCreateSchema.safeParse({ ...valid, reason: '' }).success).toBe(false);
    expect(followUpCreateSchema.safeParse({ ...valid, taskType: 'SURGERY' }).success).toBe(false);
  });

  it('rejects a reason longer than 255 characters', () => {
    expect(followUpCreateSchema.safeParse({ ...valid, reason: 'x'.repeat(256) }).success).toBe(false);
  });
});

describe('follow-up list queries', () => {
  it('coerces pagination and defaults the due window to today', () => {
    expect(followUpDueQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 20, withinDays: 0 });
    expect(followUpDueQuerySchema.parse({ withinDays: '7', pageSize: '50' })).toMatchObject({
      withinDays: 7,
      pageSize: 50,
    });
  });

  it('caps the due window and page size', () => {
    expect(followUpDueQuerySchema.safeParse({ withinDays: 91 }).success).toBe(false);
    expect(followUpQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it('accepts the clinic, reason and priority filters', () => {
    const r = followUpQuerySchema.parse({ clinicId: 'c1', reason: 'glaucoma', priority: 'HIGH', status: 'OPEN' });
    expect(r).toMatchObject({ clinicId: 'c1', reason: 'glaucoma', priority: 'HIGH', status: 'OPEN' });
  });
});

describe('followUpDeclineSchema / followUpRemindSchema', () => {
  it('requires a decline note', () => {
    expect(followUpDeclineSchema.safeParse({}).success).toBe(false);
    expect(followUpDeclineSchema.safeParse({ closureNote: 'Moved abroad' }).success).toBe(true);
  });

  it('only allows SMS or EMAIL reminders', () => {
    expect(followUpRemindSchema.safeParse({ channel: 'EMAIL' }).success).toBe(true);
    expect(followUpRemindSchema.safeParse({ channel: 'CALL' }).success).toBe(false);
  });
});

describe('outreachCreateSchema', () => {
  it('defaults to a phone call and coerces the attempt time', () => {
    const r = outreachCreateSchema.parse({
      followUpId: 'f1',
      outcome: 'NO_ANSWER',
      attemptedAt: '2026-11-05T09:00:00Z',
    });
    expect(r.channel).toBe('CALL');
    expect(r.attemptedAt).toBeInstanceOf(Date);
  });

  it('keeps SMS/email rows and SENT out of manual logging', () => {
    expect(
      outreachCreateSchema.safeParse({ followUpId: 'f1', channel: 'SMS', outcome: 'REACHED' }).success,
    ).toBe(false);
    expect(outreachCreateSchema.safeParse({ followUpId: 'f1', outcome: 'SENT' }).success).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    expect(outreachCreateSchema.safeParse({ followUpId: 'f1', outcome: 'MAYBE' }).success).toBe(false);
  });
});
