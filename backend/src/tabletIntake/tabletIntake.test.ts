import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';

/**
 * Integration tests for the tablet intake flow: staff creates a session,
 * the tablet (unauthenticated, token-only) reads it, patient submits,
 * session becomes one-shot, dedup finds an existing patient, expiry works.
 */

const app = createApp();

let secretaryAgent: ReturnType<typeof request.agent>;
let doctorAgent: ReturnType<typeof request.agent>;
let secretaryCleanup: () => Promise<void>;
let doctorCleanup: () => Promise<void>;

let clinicId = '';
const createdPatientIds: string[] = [];
const createdSessionIds: string[] = [];

function fullPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    dateOfBirth: '1980-05-14',
    sex: 'MALE' as const,
    mobileNumber: '+63-917-555-0100',
    email: 'juan@example.com',
    address: '123 Mabini St, Manila',
    medicalHistory: 'None',
    allergies: 'None',
    medications: 'None',
    consents: {
      treatment: true as const,
      dataPrivacy: true as const,
      photoConsent: true,
    },
    ...overrides,
  };
}

beforeAll(async () => {
  const secretary = await loginAgent(app, 'SECRETARY');
  secretaryAgent = secretary.agent;
  secretaryCleanup = secretary.cleanup;

  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const clinic = await prisma.clinic.create({
    data: { name: 'Tablet Intake Test Clinic', timezone: 'Asia/Manila' },
  });
  clinicId = clinic.id;
});

afterAll(async () => {
  // Cascade from submission to session.
  for (const id of createdSessionIds) {
    await prisma.tabletIntakeSession.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of createdPatientIds) {
    await prisma.patient.delete({ where: { id } }).catch(() => undefined);
  }
  if (clinicId) await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
  await secretaryCleanup();
  await doctorCleanup();
  await prisma.$disconnect();
});

describe('POST /api/tablet-intake/sessions (start)', () => {
  it('rejects unauthenticated start with 401', async () => {
    const res = await supertest(app)
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    expect(res.status).toBe(401);
  });

  it('Secretary starts a session: returns token + ACTIVE', async () => {
    const res = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.clinicId).toBe(clinicId);
    createdSessionIds.push(res.body.id);
  });

  it('Doctor can also start a session', async () => {
    const res = await doctorAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    expect(res.status).toBe(201);
    createdSessionIds.push(res.body.id);
  });

  it('rejects start for an unknown clinic with 404', async () => {
    const res = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId: 'does_not_exist' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tablet-intake/tablet/:token (tablet read)', () => {
  it('is public: no auth required', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    const res = await supertest(app).get(`/api/tablet-intake/tablet/${start.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.clinic.id).toBe(clinicId);
    // Must not leak the token or secretary id back to the tablet response.
    expect(res.body.token).toBeUndefined();
    expect(res.body.startedBySecretaryId).toBeUndefined();
  });

  it('returns 404 for an unknown token', async () => {
    const res = await supertest(app).get('/api/tablet-intake/tablet/not-a-real-token');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tablet-intake/tablet/:token/submit', () => {
  it('submits a new patient: creates Patient, marks session SUBMITTED', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    const submit = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(fullPayload({ mobileNumber: '+63-917-555-0101' }));
    expect(submit.status).toBe(201);
    expect(submit.body.patientCreated).toBe(true);
    expect(submit.body.patientId).toMatch(/^[a-z0-9]+$/);
    createdPatientIds.push(submit.body.patientId);

    // Session is now SUBMITTED; subsequent reads reflect that and don't leak form data.
    const read = await supertest(app).get(`/api/tablet-intake/tablet/${start.body.token}`);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('SUBMITTED');
    expect(read.body.rawPayload).toBeUndefined();
    expect(read.body.submittedAt).toBeTruthy();
  });

  it('rejects a second submit on the same session with 400 (one-shot)', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    const first = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(fullPayload({ mobileNumber: '+63-917-555-0102' }));
    expect(first.status).toBe(201);
    createdPatientIds.push(first.body.patientId);

    const second = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(fullPayload({ mobileNumber: '+63-917-555-0102' }));
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/SUBMITTED/);
  });

  it('rejects a submit missing required consent with 400', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    const res = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(
        fullPayload({
          mobileNumber: '+63-917-555-0103',
          consents: { treatment: false, dataPrivacy: true },
        }),
      );
    expect(res.status).toBe(400);
  });

  it('deduplicates to an existing patient on firstName + lastName + mobileNumber', async () => {
    const mobile = '+63-917-555-0199';
    // First session + submit creates the patient.
    const start1 = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start1.body.id);
    const first = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start1.body.token}/submit`)
      .send(fullPayload({ firstName: 'Dedup', lastName: 'Target', mobileNumber: mobile }));
    expect(first.body.patientCreated).toBe(true);
    createdPatientIds.push(first.body.patientId);

    // Second session + submit with same name + mobile reuses the patient.
    const start2 = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start2.body.id);
    const second = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start2.body.token}/submit`)
      .send(fullPayload({ firstName: 'Dedup', lastName: 'Target', mobileNumber: mobile }));
    expect(second.status).toBe(201);
    expect(second.body.patientCreated).toBe(false);
    expect(second.body.patientId).toBe(first.body.patientId);
  });
});

describe('expiry', () => {
  it('auto-expires an ACTIVE session read after expiresAt has passed', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    // Force expiry in the past.
    await prisma.tabletIntakeSession.update({
      where: { id: start.body.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const read = await supertest(app).get(`/api/tablet-intake/tablet/${start.body.token}`);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('EXPIRED');

    const submit = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(fullPayload({ mobileNumber: '+63-917-555-0104' }));
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/EXPIRED|expired/);
  });
});

describe('cancel', () => {
  it('Secretary cancels an ACTIVE session: status CANCELLED, submit rejected', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    const cancel = await secretaryAgent.post(`/api/tablet-intake/sessions/${start.body.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');

    const submit = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(fullPayload({ mobileNumber: '+63-917-555-0105' }));
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/CANCELLED/);
  });

  it('refuses to cancel an already-SUBMITTED session with 400', async () => {
    const start = await secretaryAgent
      .post('/api/tablet-intake/sessions')
      .send({ clinicId });
    createdSessionIds.push(start.body.id);

    const submit = await supertest(app)
      .post(`/api/tablet-intake/tablet/${start.body.token}/submit`)
      .send(fullPayload({ mobileNumber: '+63-917-555-0106' }));
    expect(submit.status).toBe(201);
    createdPatientIds.push(submit.body.patientId);

    const cancel = await secretaryAgent.post(`/api/tablet-intake/sessions/${start.body.id}/cancel`);
    expect(cancel.status).toBe(400);
  });
});

describe('GET /api/tablet-intake/sessions (list, staff)', () => {
  it('rejects unauthenticated list with 401', async () => {
    const res = await supertest(app).get(`/api/tablet-intake/sessions?clinicId=${clinicId}`);
    expect(res.status).toBe(401);
  });

  it('lists sessions for the clinic (Secretary) and omits the token', async () => {
    const res = await secretaryAgent.get(`/api/tablet-intake/sessions?clinicId=${clinicId}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].token).toBeUndefined();
    expect(res.body.items[0].clinicId).toBe(clinicId);
  });

  it('400 when clinicId query param is missing', async () => {
    const res = await secretaryAgent.get('/api/tablet-intake/sessions');
    expect(res.status).toBe(400);
  });
});