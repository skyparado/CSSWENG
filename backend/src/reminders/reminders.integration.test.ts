import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../prisma.js';
import { verifyChain, writeAudit } from '../audit/audit.service.js';
import { processReminder } from './reminders.service.js';
import type { Gateways } from './gateway.js';
import { testPatientData } from '../test-utils/patientData.js';

/**
 * Integration test (real Postgres): the persistent send record is what stops a
 * retry from sending twice, and the audit chain stays valid when entries are
 * written inside a business transaction.
 */
const ids = { user: '', clinic: '', patient: '', consent: '', followUp: '' };
const sent: Array<{ to: string; body: string; idempotencyKey?: string }> = [];
const gateways: Gateways = {
  sms: {
    async send(m) {
      sent.push(m);
      return { providerMessageId: `prov-${m.idempotencyKey}`, deliveryStatus: 'DELIVERED' };
    },
  },
  email: { send: vi.fn() },
};

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `reminder-${Date.now()}`,
      email: `reminder-${Date.now()}@test.local`,
      fullName: 'Reminder Tester',
      passwordHash: 'x',
      role: 'SECRETARY',
      status: 'ACTIVE',
    },
  });
  const clinic = await prisma.clinic.create({ data: { name: 'Reminder Clinic', phone: '+63 2 1234' } });
  const patient = await prisma.patient.create({
    data: testPatientData(clinic.id, user.id, {
      firstName: 'Re',
      lastName: 'Mind',
      mobileNumber: '+639171112222',
    }),
  });
  const consent = await prisma.patientConsent.create({
    data: {
      patientId: patient.id,
      consentType: 'REMINDER',
      channel: 'SMS',
      isGranted: true,
      captureMethod: 'IN_PERSON',
      recordedById: user.id,
    },
  });
  const followUp = await prisma.followUp.create({
    data: {
      patientId: patient.id,
      clinicId: clinic.id,
      taskType: 'LAB_TEST',
      reason: 'Fasting blood sugar',
      dueDate: new Date('2026-12-01'),
    },
  });
  Object.assign(ids, {
    user: user.id,
    clinic: clinic.id,
    patient: patient.id,
    consent: consent.id,
    followUp: followUp.id,
  });
});

afterAll(async () => {
  await prisma.reminderDelivery.deleteMany({ where: { followUpId: ids.followUp } });
  await prisma.outreachLog.deleteMany({ where: { followUpId: ids.followUp } });
  await prisma.followUp.deleteMany({ where: { id: ids.followUp } });
  await prisma.patientConsent.deleteMany({ where: { id: ids.consent } });
  await prisma.patient.deleteMany({ where: { id: ids.patient } });
  await prisma.clinic.deleteMany({ where: { id: ids.clinic } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
});

describe('reminder send tracking (real database)', () => {
  const job = () => ({ followUpId: ids.followUp, channel: 'SMS' as const });

  it('sends once, records the send, and sends nothing clinical', async () => {
    const result = await processReminder(job(), gateways, { isFinalAttempt: false, jobKey: 'int-job-1' });

    expect(result.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe('int-job-1');
    expect(sent[0]?.body).not.toMatch(/lab|blood|sugar|fasting|test/i);

    const delivery = await prisma.reminderDelivery.findUniqueOrThrow({
      where: { idempotencyKey: 'int-job-1' },
    });
    expect(delivery).toMatchObject({
      status: 'SENT',
      providerMessageId: 'prov-int-job-1',
      consentId: ids.consent,
    });
  });

  it('a retry of the same job neither sends nor logs a second time', async () => {
    const again = await processReminder(job(), gateways, { isFinalAttempt: false, jobKey: 'int-job-1' });

    expect(again).toMatchObject({ status: 'sent', recovered: true });
    expect(sent).toHaveLength(1);
    expect(await prisma.outreachLog.count({ where: { followUpId: ids.followUp } })).toBe(1);
  });

  it('rebuilds a missing outreach row from the delivery record without re-sending', async () => {
    // Simulate "sent, then the database failed": the delivery is SENT but the log row is gone.
    await prisma.outreachLog.deleteMany({ where: { followUpId: ids.followUp } });

    const result = await processReminder(job(), gateways, { isFinalAttempt: false, jobKey: 'int-job-1' });

    expect(result.status).toBe('sent');
    expect(sent).toHaveLength(1);
    const rows = await prisma.outreachLog.findMany({ where: { followUpId: ids.followUp } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'SENT', providerMessageId: 'prov-int-job-1', consentId: ids.consent });
  });

  it('a later reminder is not queued by the scan once one is recorded as sent', async () => {
    const { findFollowUpsNeedingReminder } = await import('./reminders.service.js');
    await prisma.outreachLog.deleteMany({ where: { followUpId: ids.followUp } }); // even with no log row
    const due = await findFollowUpsNeedingReminder('SMS', new Date('2026-12-01'));
    expect(due).not.toContain(ids.followUp);
  });

  it('sends nothing once consent is withdrawn', async () => {
    await prisma.patientConsent.update({ where: { id: ids.consent }, data: { withdrawnAt: new Date() } });

    const result = await processReminder(job(), gateways, { isFinalAttempt: false, jobKey: 'int-job-2' });

    expect(result).toEqual({ status: 'skipped', reason: 'NO_CONSENT' });
    expect(sent).toHaveLength(1);
  });
});

describe('audit chain with transactional entries (real database)', () => {
  it('stays valid when an entry commits with the change it describes, and when it rolls back', async () => {
    await prisma.$transaction(async (tx) => {
      await writeAudit(
        {
          userId: ids.user, userEmail: null, userRole: 'SECRETARY', action: 'CONSENT_WITHDRAWN',
          resourceType: 'PatientConsent', resourceId: ids.consent, method: null, path: null,
          statusCode: null, ipAddress: null, userAgent: null, metadata: { inTx: true },
        },
        tx,
      );
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await writeAudit(
          {
            userId: ids.user, userEmail: null, userRole: 'SECRETARY', action: 'CONSENT_WITHDRAWN',
            resourceType: 'PatientConsent', resourceId: 'rolled-back', method: null, path: null,
            statusCode: null, ipAddress: null, userAgent: null, metadata: null,
          },
          tx,
        );
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');

    expect(await prisma.auditLog.count({ where: { resourceId: ids.consent, action: 'CONSENT_WITHDRAWN' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { resourceId: 'rolled-back' } })).toBe(0);
    expect((await verifyChain()).ok).toBe(true);
  });
});
