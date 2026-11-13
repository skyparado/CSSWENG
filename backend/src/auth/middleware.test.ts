import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { isPublicPath } from './middleware.js';
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

  it('rejects a Secretary POST /api/clinics/:id/deactivate with 403', async () => {
    if (!createdClinicId) {
      throw new Error('previous test did not create a clinic');
    }
    const res = await secretaryAgent.post(`/api/clinics/${createdClinicId}/deactivate`);
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


describe('deny by default (QA 3.1)', () => {
  it('refuses an anonymous request to an api route with 401', async () => {
    const res = await supertest(app).get('/api/clinics');
    expect(res.status).toBe(401);
  });

  it('refuses an anonymous request to a path no router handles', async () => {
    // The point of denying by default: an unguarded or not-yet-written route
    // must not fall through to a 404 that confirms what does exist.
    const res = await supertest(app).get('/api/not-a-real-router');
    expect(res.status).toBe(401);
  });

  it.each([
    ['health', '/health'],
    ['the tablet read route', '/api/tablet-intake/tablet/no-such-token'],
  ])('still allows %s without a session', async (_label, path) => {
    const res = await supertest(app).get(path);
    expect(res.status).not.toBe(401);
  });

  it('still allows a login attempt without a session', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ username: `nobody-${Date.now()}`, password: 'wrong' });
    // 401 for bad credentials is the route answering, not the gate refusing;
    // what matters is that it was not refused before reaching the handler.
    expect(res.body.error).not.toBe('Not authenticated');
  });

  it('lets an authenticated request through to its own role check', async () => {
    // Secretary reaching a Doctor-only route must get 403 from the role guard,
    // not 401 from the gate.
    const res = await secretaryAgent.post('/api/clinics').send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('isPublicPath', () => {
  it('allows only the documented public paths', () => {
    expect(isPublicPath('/health')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/logout')).toBe(true);
    expect(isPublicPath('/api/webhooks/sms/status')).toBe(true);
    expect(isPublicPath('/api/tablet-intake/tablet/abc/submit')).toBe(true);
  });

  it('does not allow the staff side of tablet intake', async () => {
    // Starting or listing sessions is staff work and must stay behind auth,
    // even though it shares a prefix with the tablet's own routes.
    expect(isPublicPath('/api/tablet-intake/sessions')).toBe(false);
    expect(isPublicPath('/api/auth/me')).toBe(false);
    expect(isPublicPath('/api/patients')).toBe(false);
  });
});
