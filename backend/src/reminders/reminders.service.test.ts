import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string; idempotencyKey: string; status: string };

/** In-memory stand-in for the ReminderDelivery table: this is the "persistent send tracking". */
const store = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), seq: 0 }));

const db = vi.hoisted(() => ({
  followUp: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  patientConsent: { findFirst: vi.fn() },
  outreachLog: { findFirst: vi.fn(), create: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
  reminderDelivery: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => ({ writeAudit: vi.fn().mockResolvedValue({}) }));

import {
  buildReminderMessage,
  findFollowUpsNeedingReminder,
  processReminder,
} from './reminders.service.js';
import { StubSmsGateway } from './gateway.js';
import type { Gateways } from './gateway.js';

const followUp = {
  id: 'f1',
  patientId: 'p1',
  clinicId: 'c1',
  status: 'OPEN',
  taskType: 'INJECTION',
  reason: 'intravitreal injection for macular edema',
  dueDate: new Date('2026-11-10T00:00:00Z'),
  patient: { id: 'p1', mobileNumber: '+639171234567', email: 'juan@example.com' },
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
  store.rows.clear();
  store.seq = 0;

  db.followUp.findUnique.mockResolvedValue(followUp);
  db.patientConsent.findFirst.mockResolvedValue(consent);
  db.followUp.updateMany.mockResolvedValue({ count: 0 });

  // Outreach log: an in-memory list so "already logged?" lookups are truthful.
  const outreach: Array<Record<string, unknown>> = [];
  db.outreachLog.findFirst.mockImplementation(async ({ where }) =>
    outreach.find(
      (o) => o.followUpId === where.followUpId && o.providerMessageId === where.providerMessageId,
    ) ?? null,
  );
  db.outreachLog.aggregate.mockResolvedValue({ _max: { attemptNumber: null } });
  db.outreachLog.count.mockResolvedValue(0);
  db.outreachLog.create.mockImplementation(async ({ data }) => {
    const row = { id: `o${outreach.length + 1}`, ...data };
    outreach.push(row);
    return row;
  });
  db.$queryRaw.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));

  db.reminderDelivery.findUnique.mockImplementation(
    async ({ where }) => (store.rows.get(where.idempotencyKey) as Row | undefined) ?? null,
  );
  db.reminderDelivery.create.mockImplementation(async ({ data }) => {
    const row = { id: `d${++store.seq}`, status: 'PENDING', providerMessageId: null, ...data };
    store.rows.set(data.idempotencyKey, row);
    return row;
  });
  db.reminderDelivery.update.mockImplementation(async ({ where, data }) => {
    const row = [...store.rows.values()].find((r) => r.id === where.id);
    if (!row) throw new Error('no such delivery');
    Object.assign(row, data);
    return row;
  });
});

describe('buildReminderMessage', () => {
  it('names the clinic and due date but nothing clinical', () => {
    const { subject, body } = buildReminderMessage({
      clinicName: 'UERM',
      dueDate: new Date('2026-11-10T00:00:00Z'),
      clinicPhone: '+63 2 8715 0861',
    });
    expect(body).toContain('UERM');
    expect(body).toContain('2026-11-10');
    expect(body).toContain('+63 2 8715 0861');
    expect(`${subject} ${body}`).not.toMatch(
      /inject|laborator|\blab\b|procedure|test|check-?up|surgery|glaucoma|macular/i,
    );
  });
});

describe('processReminder: message content', () => {
  it.each([['SMS'], ['EMAIL']] as const)(
    'sends no task type or reason in the %s, whatever the task is',
    async (channel) => {
      for (const taskType of ['INJECTION', 'LAB_TEST', 'PROCEDURE'] as const) {
        store.rows.clear();
        db.followUp.findUnique.mockResolvedValue({ ...followUp, taskType });
        const gw = gateways();
        await processReminder({ followUpId: 'f1', channel }, gw, { isFinalAttempt: false });

        const sent = (channel === 'SMS' ? gw.sms : gw.email).send.mock.calls[0][0];
        const text = `${sent.subject ?? ''} ${sent.body}`;
        expect(text).not.toMatch(/inject|laborator|\blab\b|procedure|macular|edema/i);
      }
    },
  );
});

describe('processReminder: sending', () => {
  it('sends an SMS and logs it with the consent that allowed it', async () => {
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
    });

    expect(result).toEqual({ status: 'sent', outreachId: 'o1' });
    expect(gw.sms.send).toHaveBeenCalledWith(expect.objectContaining({ to: '+639171234567' }));
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

  it('records the delivery as PENDING before calling the provider, then SENT with its message id', async () => {
    const order: string[] = [];
    db.reminderDelivery.create.mockImplementation(async ({ data }) => {
      order.push('claim');
      const row = { id: 'd1', status: 'PENDING', providerMessageId: null, ...data };
      store.rows.set(data.idempotencyKey, row);
      return row;
    });
    const gw = gateways({
      sms: {
        send: vi.fn().mockImplementation(async () => {
          order.push('send');
          return { providerMessageId: 'sms-1' };
        }),
      },
    });

    await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
      jobKey: 'job-7',
    });

    expect(order).toEqual(['claim', 'send']);
    expect(store.rows.get('job-7')).toMatchObject({
      status: 'SENT',
      providerMessageId: 'sms-1',
      consentId: 'consent1',
    });
  });

  it('hands the provider a stable idempotency key', async () => {
    const gw = gateways();
    await processReminder({ followUpId: 'f1', channel: 'EMAIL' }, gw, {
      isFinalAttempt: false,
      jobKey: 'job-7',
    });
    expect(gw.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'juan@example.com',
        subject: 'Reminder from UERM',
        idempotencyKey: 'job-7',
      }),
    );
  });

  it('numbers attempts after the ones already logged', async () => {
    db.outreachLog.aggregate.mockResolvedValue({ _max: { attemptNumber: 2 } });
    await processReminder({ followUpId: 'f1', channel: 'SMS' }, gateways(), {
      isFinalAttempt: false,
    });
    expect(db.outreachLog.create.mock.calls[0][0].data.attemptNumber).toBe(3);
  });
});

describe('processReminder: successful delivery followed by a database failure', () => {
  it('does not send twice when the outreach log write fails and the job is retried', async () => {
    const gw = gateways();
    const job = { followUpId: 'f1', channel: 'SMS' as const };
    const opts = { isFinalAttempt: false, jobKey: 'job-1' };

    // Attempt 1: the SMS goes out, then the database refuses the outreach row.
    db.outreachLog.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(processReminder(job, gw, opts)).rejects.toThrow('connection lost');
    expect(gw.sms.send).toHaveBeenCalledTimes(1);
    expect(store.rows.get('job-1')).toMatchObject({ status: 'SENT', providerMessageId: 'sms-1' });

    // Attempt 2 (BullMQ retry): database is back. The message is NOT sent again,
    // but the missing outreach row is written.
    const result = await processReminder(job, gw, opts);
    expect(gw.sms.send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'sent' });
    expect(db.outreachLog.create).toHaveBeenCalledTimes(2);
    expect(db.outreachLog.create.mock.calls[1][0].data).toMatchObject({
      outcome: 'SENT',
      providerMessageId: 'sms-1',
      consentId: 'consent1',
    });
  });

  it('writes no second outreach row when the first one did commit', async () => {
    const gw = gateways();
    const job = { followUpId: 'f1', channel: 'SMS' as const };
    const opts = { isFinalAttempt: false, jobKey: 'job-1' };

    await processReminder(job, gw, opts);
    const again = await processReminder(job, gw, opts);

    expect(gw.sms.send).toHaveBeenCalledTimes(1);
    expect(db.outreachLog.create).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ status: 'sent', outreachId: 'o1', recovered: true });
  });

  it('finishes the log of an already-sent reminder even if the task was closed or consent withdrawn since', async () => {
    const gw = gateways();
    const job = { followUpId: 'f1', channel: 'SMS' as const };
    const opts = { isFinalAttempt: false, jobKey: 'job-1' };

    db.outreachLog.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(processReminder(job, gw, opts)).rejects.toThrow();

    db.followUp.findUnique.mockResolvedValue({ ...followUp, status: 'COMPLETED' });
    db.patientConsent.findFirst.mockResolvedValue({ ...consent, withdrawnAt: new Date() });
    const result = await processReminder(job, gw, opts);

    expect(result).toMatchObject({ status: 'sent' });
    expect(gw.sms.send).toHaveBeenCalledTimes(1);
  });

  it('relies on the provider idempotency key when the database fails before the SENT row is saved', async () => {
    const sms = new StubSmsGateway();
    const sendSpy = vi.spyOn(sms, 'send');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const gw = { sms, email: gateways().email } as unknown as Gateways;
    const job = { followUpId: 'f1', channel: 'SMS' as const };
    const opts = { isFinalAttempt: false, jobKey: 'job-9' };

    // The provider accepts, but saving the SENT row fails: the row stays PENDING.
    db.reminderDelivery.update.mockRejectedValueOnce(new Error('connection lost'));
    await expect(processReminder(job, gw, opts)).rejects.toThrow('connection lost');
    await processReminder(job, gw, opts);

    // It is called again (we could not know), but with the SAME key, so a
    // provider that honours idempotency delivers once and returns the same id.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const [first, second] = await Promise.all(sendSpy.mock.results.map((r) => r.value));
    expect(sendSpy.mock.calls[0][0].idempotencyKey).toBe('job-9');
    expect(sendSpy.mock.calls[1][0].idempotencyKey).toBe('job-9');
    expect(first.providerMessageId).toBe(second.providerMessageId);
    log.mockRestore();
  });
});

describe('processReminder: retries', () => {
  it('rethrows a gateway error so BullMQ retries, without logging yet', async () => {
    const gw = gateways({ sms: { send: vi.fn().mockRejectedValue(new Error('gateway down')) } });
    await expect(
      processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, { isFinalAttempt: false }),
    ).rejects.toThrow('gateway down');
    expect(db.outreachLog.create).not.toHaveBeenCalled();
  });

  it('reuses the same delivery row and key on every retry', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce({ providerMessageId: 'sms-1' });
    const gw = gateways({ sms: { send } });
    const job = { followUpId: 'f1', channel: 'SMS' as const };
    const opts = { isFinalAttempt: false, jobKey: 'job-2' };

    await expect(processReminder(job, gw, opts)).rejects.toThrow('gateway down');
    await processReminder(job, gw, opts);

    expect(db.reminderDelivery.create).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map((c) => c[0].idempotencyKey)).toEqual(['job-2', 'job-2']);
    expect(store.rows.get('job-2')).toMatchObject({ status: 'SENT' });
  });

  it('logs a FAILED attempt, then rethrows, on the final attempt', async () => {
    const gw = gateways({ sms: { send: vi.fn().mockRejectedValue(new Error('gateway down')) } });
    await expect(
      processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
        isFinalAttempt: true,
        jobKey: 'job-3',
      }),
    ).rejects.toThrow('gateway down');
    expect(db.outreachLog.create.mock.calls[0][0].data).toMatchObject({
      outcome: 'FAILED',
      deliveryStatus: 'FAILED',
      consentId: 'consent1',
    });
    expect(store.rows.get('job-3')).toMatchObject({ status: 'FAILED' });
  });

  it('marks the task unreachable when failed attempts reach the limit', async () => {
    db.outreachLog.count.mockResolvedValue(3);
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
});

describe('processReminder: consent and eligibility', () => {
  it('does not send, or log, when the patient has no reminder consent', async () => {
    db.patientConsent.findFirst.mockResolvedValue(null);
    const gw = gateways();
    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(gw.sms.send).not.toHaveBeenCalled();
    expect(db.outreachLog.create).not.toHaveBeenCalled();
    expect(db.reminderDelivery.create).not.toHaveBeenCalled();
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

  it('stops retrying once consent is withdrawn between attempts, and cancels the pending delivery', async () => {
    const send = vi.fn().mockRejectedValue(new Error('gateway down'));
    const gw = gateways({ sms: { send } });
    const job = { followUpId: 'f1', channel: 'SMS' as const };
    const opts = { isFinalAttempt: false, jobKey: 'job-4' };

    await expect(processReminder(job, gw, opts)).rejects.toThrow('gateway down');
    expect(store.rows.get('job-4')).toMatchObject({ status: 'PENDING' });

    db.patientConsent.findFirst.mockResolvedValue({ ...consent, withdrawnAt: new Date() });
    const result = await processReminder(job, gw, opts);

    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(send).toHaveBeenCalledTimes(1); // nothing went out after the withdrawal
    expect(store.rows.get('job-4')).toMatchObject({ status: 'CANCELLED' });
  });

  it('checks consent again right before sending, so a withdrawal during the job still wins', async () => {
    // First look: consented. Second look (just before the provider call): withdrawn.
    db.patientConsent.findFirst
      .mockResolvedValueOnce(consent)
      .mockResolvedValueOnce({ ...consent, withdrawnAt: new Date() });
    const gw = gateways();

    const result = await processReminder({ followUpId: 'f1', channel: 'SMS' }, gw, {
      isFinalAttempt: false,
      jobKey: 'job-5',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(gw.sms.send).not.toHaveBeenCalled();
    expect(db.outreachLog.create).not.toHaveBeenCalled();
    expect(store.rows.get('job-5')).toMatchObject({ status: 'CANCELLED' });
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
});

describe('findFollowUpsNeedingReminder', () => {
  it('asks only for open tasks of consenting patients with no reminder sent on the channel', async () => {
    db.followUp.findMany.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]);
    const ids = await findFollowUpsNeedingReminder('SMS', new Date('2026-11-05T00:00:00Z'));

    expect(ids).toEqual(['f1', 'f2']);
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where.status).toBe('OPEN');
    expect(where.patient.consents.some).toMatchObject({
      consentType: 'REMINDER',
      channel: 'SMS',
      isGranted: true,
      withdrawnAt: null,
    });
    expect(where.outreachLogs.none).toMatchObject({ channel: 'SMS', outcome: 'SENT' });
    // Also excludes a reminder that went out but whose outreach log was never written.
    expect(where.deliveries.none).toMatchObject({ channel: 'SMS', status: 'SENT' });
    // 2026-11-05 in Manila + the default 2-day lead window.
    expect(where.dueDate.lte).toEqual(new Date('2026-11-07T00:00:00Z'));
  });
});
