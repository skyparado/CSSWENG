import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.js';
import { logOutreachAttempt } from './outreach.service.js';
import { testPatientData } from '../test-utils/patientData.js';

/**
 * Integration test (real Postgres): outreach attempts logged at the same moment
 * get distinct attempt numbers, and the database itself refuses a duplicate.
 * The in-memory simulation in outreach.service.test.ts covers the logic; this
 * proves the row lock and the unique index work in the real database.
 */
const ids = { user: '', clinic: '', patient: '', followUp: '' };
const followUpRef = () => ({ id: ids.followUp, patientId: ids.patient, clinicId: ids.clinic });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `outreach-${Date.now()}`,
      email: `outreach-${Date.now()}@test.local`,
      fullName: 'Outreach Tester',
      passwordHash: 'x',
      role: 'SECRETARY',
      status: 'ACTIVE',
    },
  });
  const clinic = await prisma.clinic.create({ data: { name: 'Outreach Race Clinic' } });
  const patient = await prisma.patient.create({
    data: testPatientData(clinic.id, user.id, { firstName: 'Race', lastName: 'Patient' }),
  });
  const followUp = await prisma.followUp.create({
    data: {
      patientId: patient.id,
      clinicId: clinic.id,
      taskType: 'FOLLOW_UP',
      reason: 'Race test',
      dueDate: new Date('2026-12-01'),
    },
  });
  Object.assign(ids, { user: user.id, clinic: clinic.id, patient: patient.id, followUp: followUp.id });
});

afterAll(async () => {
  await prisma.outreachLog.deleteMany({ where: { followUpId: ids.followUp } });
  await prisma.followUp.deleteMany({ where: { id: ids.followUp } });
  await prisma.patient.deleteMany({ where: { id: ids.patient } });
  await prisma.clinic.deleteMany({ where: { id: ids.clinic } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
});

describe('simultaneous outreach attempts (real database)', () => {
  it('numbers twelve concurrent attempts 1..12 with no duplicates', async () => {
    const logs = await Promise.all(
      Array.from({ length: 12 }, () =>
        logOutreachAttempt({
          followUp: followUpRef(),
          channel: 'CALL',
          outcome: 'LEFT_MESSAGE',
          contactedById: ids.user,
        }),
      ),
    );

    expect(logs.map((l) => l.attemptNumber).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  it('refuses a duplicate attempt number at the database level', async () => {
    await expect(
      prisma.outreachLog.create({
        data: {
          followUpId: ids.followUp,
          patientId: ids.patient,
          clinicId: ids.clinic,
          channel: 'CALL',
          attemptNumber: 1, // already taken
          outcome: 'NO_ANSWER',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('closes the task as declined once, with one audit entry, when two declines race', async () => {
    const f = await prisma.followUp.create({
      data: {
        patientId: ids.patient,
        clinicId: ids.clinic,
        taskType: 'FOLLOW_UP',
        reason: 'x',
        dueDate: new Date('2026-12-02'),
      },
    });
    try {
      const ref = { id: f.id, patientId: ids.patient, clinicId: ids.clinic };
      await Promise.all([
        logOutreachAttempt({ followUp: ref, channel: 'CALL', outcome: 'DECLINED', patientResponse: 'No' }),
        logOutreachAttempt({ followUp: ref, channel: 'CALL', outcome: 'DECLINED', patientResponse: 'No' }),
      ]);

      expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('DECLINED');
      const audits = await prisma.auditLog.count({
        where: { action: 'FOLLOW_UP_STATUS_CHANGED', resourceId: f.id },
      });
      expect(audits).toBe(1);
    } finally {
      await prisma.outreachLog.deleteMany({ where: { followUpId: f.id } });
      await prisma.followUp.delete({ where: { id: f.id } });
    }
  });
});
