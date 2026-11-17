import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { testPatientData } from '../test-utils/patientData.js';
import { drainAuditWrites, waitForAudit } from '../test-utils/waitForAudit.js';

/**
 * Patient rights requests against the real database (SDD 7.4): the free text
 * is stored encrypted, the Secretary is kept to her clinic, only the Doctor
 * decides, and each step lands in the audit trail.
 */

const app = createApp();

let doctor: Awaited<ReturnType<typeof loginAgent>>;
let secretary: Awaited<ReturnType<typeof loginAgent>>;
let mine = '';
let theirs = '';
let patientId = '';

beforeAll(async () => {
  mine = (await prisma.clinic.create({ data: { name: 'Rights Mine', timezone: 'Asia/Manila' } })).id;
  theirs = (await prisma.clinic.create({ data: { name: 'Rights Theirs', timezone: 'Asia/Manila' } })).id;
  doctor = await loginAgent(app, 'DOCTOR', mine);
  secretary = await loginAgent(app, 'SECRETARY', mine);
  patientId = (await prisma.patient.create({ data: testPatientData(mine, doctor.userId) })).id;
});

afterAll(async () => {
  await drainAuditWrites();
  await prisma.patientRightsRequest.deleteMany({ where: { patientId } }).catch(() => undefined);
  await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  await secretary.cleanup();
  await doctor.cleanup();
  await prisma.clinic.deleteMany({ where: { id: { in: [mine, theirs] } } }).catch(() => undefined);
});

describe('patient rights requests', () => {
  it('runs from the Secretary recording a request to the Doctor completing it', async () => {
    const created = await secretary.agent
      .post('/api/rights-requests')
      .send({ patientId, requestType: 'CORRECTION', receivedVia: 'WRITTEN', details: 'Wrong birth date on file' })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'PENDING', clinicId: mine, details: 'Wrong birth date on file' });

    // Encrypted at rest.
    const stored = await prisma.patientRightsRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.details).not.toContain('birth date');

    await waitForAudit({ action: 'RIGHTS_REQUEST_RECORDED', resourceId: created.body.id });

    // Only the Doctor decides.
    await secretary.agent
      .post(`/api/rights-requests/${created.body.id}/decision`)
      .send({ status: 'COMPLETED', decisionNote: 'Fixed' })
      .expect(403);

    const decided = await doctor.agent
      .post(`/api/rights-requests/${created.body.id}/decision`)
      .send({ status: 'COMPLETED', decisionNote: 'Birth date corrected on the chart' })
      .expect(200);
    expect(decided.body).toMatchObject({ status: 'COMPLETED', decidedById: doctor.userId });

    await waitForAudit({ action: 'RIGHTS_REQUEST_COMPLETED', resourceId: created.body.id });

    // A second decision is refused.
    await doctor.agent
      .post(`/api/rights-requests/${created.body.id}/decision`)
      .send({ status: 'DENIED', decisionNote: 'Changed my mind' })
      .expect(409);
  });

  it('keeps the Secretary to her active clinic', async () => {
    const other = await prisma.patientRightsRequest.create({
      data: { patientId, clinicId: theirs, requestType: 'ACCESS', receivedVia: 'PHONE', recordedById: doctor.userId },
    });

    const list = await secretary.agent.get('/api/rights-requests').expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).not.toContain(other.id);
    await secretary.agent.get('/api/rights-requests').query({ clinicId: theirs }).expect(403);
  });
});
