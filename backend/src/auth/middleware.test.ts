import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import supertest from 'supertest';

/**
 * Integration tests for the RBAC middleware (requireAuth, requireDoctor).
 *
 * These exercise the middleware end-to-end through the HTTP layer, using
 * routes it is actually applied to: /api/clinics (POST = Doctor only, GET =
 * any authenticated user) and /api/documents/requests (POST = Doctor only).
 */
const app = createApp();

let doctorAgent: ReturnType<typeof request.agent>;
let secretaryAgent: ReturnType<typeof request.agent>;
let doctorCleanup: () => Promise<void>;
let secretaryCleanup: () => Promise<void>;
let createdClinicId: string | null = null;

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const secretary = await loginAgent(app, 'SECRETARY');
  secretaryAgent = secretary.agent;
  secretaryCleanup = secretary.cleanup;
});

afterAll(async () => {
  if (createdClinicId) {
    await prisma.clinic
      .delete({ where: { id: createdClinicId } })
      .catch(() => undefined);
  }
  await doctorCleanup();
  await secretaryCleanup();
  await prisma.$disconnect();
});

describe('requireAuth middleware', () => {
  it('rejects an unauthenticated GET /api/clinics with 401', async () => {
    const res = await supertest(app).get('/api/clinics');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not authenticated/i);
  });

  it('accepts an authenticated GET /api/clinics with 200', async () => {
    const res = await doctorAgent.get('/api/clinics');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('accepts a Secretary GET /api/clinics with 200 (both roles allowed)', async () => {
    const res = await secretaryAgent.get('/api/clinics');
    expect(res.status).toBe(200);
  });
});

describe('requireDoctor middleware', () => {
  it('rejects an unauthenticated POST /api/clinics with 401', async () => {
    const res = await supertest(app)
      .post('/api/clinics')
      .send({ name: 'Should Fail', timezone: 'Asia/Manila' });
    expect(res.status).toBe(401);
  });

  it('rejects a Secretary POST /api/clinics with 403', async () => {
    const res = await secretaryAgent
      .post('/api/clinics')
      .send({ name: 'Secretary Attempt', timezone: 'Asia/Manila' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/doctor/i);
  });

  it('allows a Doctor POST /api/clinics with 201', async () => {
    const res = await doctorAgent
      .post('/api/clinics')
      .send({ name: 'RBAC Test Clinic', timezone: 'Asia/Manila' });
    expect(res.status).toBe(201);
    createdClinicId = res.body.id as string;
    expect(createdClinicId).toBeTruthy();
  });

  it('rejects a Secretary PATCH /api/clinics/:id with 403', async () => {
    if (!createdClinicId) {
      throw new Error('previous test did not create a clinic');
    }
    const res = await secretaryAgent
      .patch(`/api/clinics/${createdClinicId}`)
      .send({ name: 'Secretary Rename' });
    expect(res.status).toBe(403);
  });

  it('rejects a Secretary DELETE /api/clinics/:id with 403', async () => {
    if (!createdClinicId) {
      throw new Error('previous test did not create a clinic');
    }
    const res = await secretaryAgent.delete(`/api/clinics/${createdClinicId}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated POST /api/documents/requests with 401', async () => {
    const res = await supertest(app)
      .post('/api/documents/requests')
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects a Secretary POST /api/documents/requests with 403', async () => {
    const res = await secretaryAgent.post('/api/documents/requests').send({});
    expect(res.status).toBe(403);
  });
});