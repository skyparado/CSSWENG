import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  followUp: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  patientConsent: { findFirst: vi.fn() },
  outreachLog: { count: vi.fn(), create: vi.fn() },
}));
vi.mock('../prisma.js', () => ({ prisma: db }));

import { buildReminderMessage, findFollowUpsNeedingReminder, processReminder } from './reminders.service.js';
import type { Gateways } from './gateway.js';
import { encrypt } from '../lib/fieldCrypto.js';

const followUp = {
  id: 'f1',
  patientId: 'p1',
  clinicId: 'c1',
  status: 'OPEN',
  taskType: 'CHECK_UP',
  reason: 'glaucoma pressure check',
  dueDate: new Date('2026-11-10T00:00:00Z'),
  // Stored encrypted, as the patients module writes them.
  patient: { id: 'p1', mobileNumber: encrypt('+639171234567'), email: encrypt('juan@example.com') },
  clinic: { id: 'c1', name: 'UERM', phone: '+63 2 8715 0861' },
};

const consent = { id: 'consent1', isGranted: true, withdrawnAt: null };

function gateways(overrides: Partial<Gateways> = {}): Gateways & {
  sms: { send: ReturnType<typeof vi.fn> };
  email: { send: ReturnType<typeof vi.fn> };
} {
  return {
    sms: { send: vi.fn().mockResolvedValue({ providerMessageId: 'sms-1' }) },
    email: { send: vi.fn().mockResolvedValue({ providerMessageId: 'mail-1' }) },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  db.followUp.findUnique.mockResolvedValue(followUp);
  db.patientConsent.findFirst.mockResolvedValue(consent);
  db.outreachLog.count.mockResolvedValue(0);
  db.outreachLog.create.mockImplementation(async ({ data }) => ({ id: 'o1', ...data }));
  db.followUp.updateMany.mockResolvedValue({ count: 0 });
});

describe('buildReminderMessage', () => {
  it('names the clinic and visit type but not the clinical reason', () => {
    const { body } = buildReminderMessage({
      clinicName: 'UERM',
      taskType: 'LAB_TEST',
      dueDate: new Date('2026-11-10T00:00:00Z'),
      clinicPhone: '+63 2 8715 0861',
    });
    expect(body).toContain('UERM');
    expect(body).toContain('laboratory test');
    expect(body).toContain('2026-11-10');
    expect(body).toContain('+63 2 8715 0861');
  });
});

describe('processReminder', () => {
  it('sends an SMS and logs it with the consent that allowed it', async () => {
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
    });

    expect(result).toEqual({ status: 'sent', outreachId: 'o1' });
    expect(gw.sms.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+639171234567' }),
    );
    expect(gw.email.send).not.toHaveBeenCalled();
    expect(db.outreachLog.create.mock.calls[0][0].data).toMatchObject({
      followUpId: 'f1',
      channel: 'SMS',
      outcome: 'SENT',
      consentId: 'consent1',
      providerMessageId: 'sms-1',
      attemptNumber: 1,
      contactedById: undefined,
    });
  });

  it('sends an email to the patient email address', async () => {
    const gw = gateways();
    await processReminder({ followUpId: 'f1', channel: 'EMAIL' }, gw, { isFinalAttempt: false });
    expect(gw.email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'juan@example.com', subject: 'Reminder from UERM' }),
    );
  });

  it('does not send, or log, when the patient has no reminder consent', async () => {
    db.patientConsent.findFirst.mockResolvedValue(null);
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(gw.sms.send).not.toHaveBeenCalled();
    expect(db.outreachLog.create).not.toHaveBeenCalled();
  });

  it('does not send when the latest consent decision is a refusal', async () => {
    db.patientConsent.findFirst.mockResolvedValue({ ...consent, isGranted: false });
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(gw.sms.send).not.toHaveBeenCalled();
  });

  it('does not send when the consent was withdrawn', async () => {
    db.patientConsent.findFirst.mockResolvedValue({ ...consent, withdrawnAt: new Date() });
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'EMAIL' }, gw, {
      isFinalAttempt: false,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(gw.email.send).not.toHaveBeenCalled();
  });

  it('checks consent for the requested channel only', async () => {
    await processReminder({ followUpId: 'f1', channel: 'EMAIL' }, gateways(), {
      isFinalAttempt: false,
    });
    expect(db.patientConsent.findFirst.mock.calls[0][0].where).toMatchObject({
      patientId: 'p1',
      consentType: 'REMINDER',
      channel: 'EMAIL',
    });
  });

  it('skips a follow-up that is no longer open', async () => {
    db.followUp.findUnique.mockResolvedValue({ ...followUp, status: 'COMPLETED' });
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gateways(), {
      isFinalAttempt: false,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'NOT_OPEN' });
  });

  it('skips a missing follow-up', async () => {
    db.followUp.findUnique.mockResolvedValue(null);
    const result = await processReminder({ followUpId: 'gone', channel: 'SMS' }, gateways(), {
      isFinalAttempt: false,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'FOLLOW_UP_NOT_FOUND' });
  });

  it('skips when the patient has no number or address for the channel', async () => {
    db.followUp.findUnique.mockResolvedValue({
      ...followUp,
      patient: { ...followUp.patient, mobileNumber: null },
    });
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONTACT' });
    expect(gw.sms.send).not.toHaveBeenCalled();
  });

  it('rethrows a gateway error so BullMQ retries, without logging yet', async () => {
    const gw = gateways({ sms: { send: vi.fn().mockRejectedValue(new Error('gateway down')) } });
    await expect(
      processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, { isFinalAttempt: false }),
    ).rejects.toThrow('gateway down');
    expect(db.outreachLog.create).not.toHaveBeenCalled();
  });

  it('logs a FAILED attempt, then rethrows, on the final attempt', async () => {
    const gw = gateways({ sms: { send: vi.fn().mockRejectedValue(new Error('gateway down')) } });
    await expect(
      processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, { isFinalAttempt: true }),
    ).rejects.toThrow('gateway down');
    expect(db.outreachLog.create.mock.calls[0][0].data).toMatchObject({
      outcome: 'FAILED',
      deliveryStatus: 'FAILED',
      consentId: 'consent1',
    });
  });

  it('marks the task unreachable when failed attempts reach the limit', async () => {
    // Two earlier failures; the final failed send brings the count to the limit of 3.
    db.outreachLog.count.mockImplementation(async ({ where }) => (where.outcome ? 3 : 2));
    db.followUp.updateMany.mockResolvedValue({ count: 1 });
    const gw = gateways({ sms: { send: vi.fn().mockRejectedValue(new Error('down')) } });

    await expect(
      processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, { isFinalAttempt: true }),
    ).rejects.toThrow('down');

    expect(db.followUp.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'f1', status: 'OPEN' },
        data: expect.objectContaining({ status: 'UNREACHABLE' }),
      }),
    );
  });

  it('numbers attempts after the ones already logged', async () => {
    db.outreachLog.count.mockResolvedValue(2);
    await processReminder({ followUpId: 'f1', channel: 'SMS' }, gateways(), {
      isFinalAttempt: false,
    });
    expect(db.outreachLog.create.mock.calls[0][0].data.attemptNumber).toBe(3);
  });
});

describe('findFollowUpsNeedingReminder', () => {
  it('asks only for open tasks of consenting patients with no reminder sent on the channel', async () => {
    db.followUp.findMany.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]);
    const ids = await findFollowUpsNeedingReminder('SMS', new Date('2026-11-05T00:00:00Z'));

    expect(ids).toEqual(['f1', 'f2']);
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where.status).toBe('OPEN');
    expect(where.patient.voidedAt).toBeNull();
    expect(where.patient.consents.some).toMatchObject({
      consentType: 'REMINDER',
      channel: 'SMS',
      isGranted: true,
      withdrawnAt: null,
    });
    expect(where.outreachLogs.none).toMatchObject({ channel: 'SMS', outcome: 'SENT' });
    // 2026-11-05 in Manila + the default 2-day lead window.
    expect(where.dueDate.lte).toEqual(new Date('2026-11-07T00:00:00Z'));
  });
});
