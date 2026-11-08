import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.js';

/**
 * Integration test (real Postgres, like fieldEncryption.test.ts): the clinical
 * free-text columns added to the encryption set hold ciphertext in the database
 * and read back as plaintext through Prisma.
 *
 *   FollowUp.reason, OutreachLog.patientResponse,
 *   Medication.instructions, Medication.indication, Allergy.reaction
 */
const REASON = 'Intravitreal injection for diabetic macular edema';
const RESPONSE = 'Patient says the injection last time was painful';
const INSTRUCTIONS = 'Instil one drop in the left eye at bedtime';
const INDICATION = 'Primary open-angle glaucoma, left eye';
const REACTION = 'Facial swelling and hives within an hour';

const ids = { user: '', clinic: '', patient: '', followUp: '', outreach: '', medication: '', allergy: '' };

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `enc-${Date.now()}@test.local`,
      fullName: 'Encryption Tester',
      passwordHash: 'x',
      role: 'DOCTOR',
      status: 'ACTIVE',
    },
  });
  const clinic = await prisma.clinic.create({ data: { name: 'Sensitive Fields Clinic' } });
  const patient = await prisma.patient.create({ data: { firstName: 'Sensi', lastName: 'Tive' } });
  const followUp = await prisma.followUp.create({
    data: {
      patientId: patient.id,
      clinicId: clinic.id,
      taskType: 'INJECTION',
      reason: REASON,
      dueDate: new Date('2026-12-01'),
    },
  });
  const outreach = await prisma.outreachLog.create({
    data: {
      followUpId: followUp.id,
      patientId: patient.id,
      clinicId: clinic.id,
      channel: 'CALL',
      attemptNumber: 1,
      outcome: 'REACHED',
      patientResponse: RESPONSE,
      contactedById: user.id,
    },
  });
  const medication = await prisma.medication.create({
    data: {
      patientId: patient.id,
      clinicId: clinic.id,
      medicationName: 'Timolol',
      dose: '1 drop',
      frequency: 'QHS',
      route: 'ophthalmic',
      instructions: INSTRUCTIONS,
      indication: INDICATION,
      startDate: new Date('2026-11-01'),
      prescribingDoctor: 'Dr. Test',
      recordedById: user.id,
    },
  });
  const allergy = await prisma.allergy.create({
    data: {
      patientId: patient.id,
      clinicId: clinic.id,
      allergenName: 'Penicillin',
      reaction: REACTION,
      recordedById: user.id,
    },
  });
  Object.assign(ids, {
    user: user.id,
    clinic: clinic.id,
    patient: patient.id,
    followUp: followUp.id,
    outreach: outreach.id,
    medication: medication.id,
    allergy: allergy.id,
  });
});

afterAll(async () => {
  // Foreign keys are RESTRICT: children first.
  await prisma.allergy.deleteMany({ where: { id: ids.allergy } });
  await prisma.medication.deleteMany({ where: { id: ids.medication } });
  await prisma.outreachLog.deleteMany({ where: { id: ids.outreach } });
  await prisma.followUp.deleteMany({ where: { id: ids.followUp } });
  await prisma.patient.deleteMany({ where: { id: ids.patient } });
  await prisma.clinic.deleteMany({ where: { id: ids.clinic } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
});

const CIPHERTEXT = /^v\d+\.aesgcm256\./;

describe('clinical free text is encrypted at rest', () => {
  it('FollowUp.reason', async () => {
    const [row] = await prisma.$queryRaw<Array<{ v: string }>>`
      SELECT "reason" AS v FROM "FollowUp" WHERE id = ${ids.followUp}`;
    expect(row?.v).toMatch(CIPHERTEXT);
    expect(row?.v).not.toContain('injection');
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: ids.followUp } })).reason).toBe(REASON);
  });

  it('OutreachLog.patientResponse', async () => {
    const [row] = await prisma.$queryRaw<Array<{ v: string }>>`
      SELECT "patientResponse" AS v FROM "OutreachLog" WHERE id = ${ids.outreach}`;
    expect(row?.v).toMatch(CIPHERTEXT);
    expect(
      (await prisma.outreachLog.findUniqueOrThrow({ where: { id: ids.outreach } })).patientResponse,
    ).toBe(RESPONSE);
  });

  it('Medication.instructions and Medication.indication', async () => {
    const [row] = await prisma.$queryRaw<Array<{ i: string; d: string }>>`
      SELECT "instructions" AS i, "indication" AS d FROM "Medication" WHERE id = ${ids.medication}`;
    expect(row?.i).toMatch(CIPHERTEXT);
    expect(row?.d).toMatch(CIPHERTEXT);
    const med = await prisma.medication.findUniqueOrThrow({ where: { id: ids.medication } });
    expect(med.instructions).toBe(INSTRUCTIONS);
    expect(med.indication).toBe(INDICATION);
  });

  it('Allergy.reaction', async () => {
    const [row] = await prisma.$queryRaw<Array<{ v: string }>>`
      SELECT "reaction" AS v FROM "Allergy" WHERE id = ${ids.allergy}`;
    expect(row?.v).toMatch(CIPHERTEXT);
    expect((await prisma.allergy.findUniqueOrThrow({ where: { id: ids.allergy } })).reaction).toBe(REACTION);
  });

  it('keeps the other columns of the same rows searchable', async () => {
    const found = await prisma.followUp.findMany({
      where: { clinicId: ids.clinic, taskType: 'INJECTION' },
    });
    expect(found.map((f) => f.id)).toEqual([ids.followUp]);
  });
});
