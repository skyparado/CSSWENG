import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';

/**
 * Integration tests for refreshSessionUser (QA 2.1). On every authenticated
 * request, the middleware re-checks the user against the DB and kills the
 * session if the account is gone, no longer ACTIVE, or the role changed.
 */

const app = createApp();

let doctorAgent: ReturnType<typeof request.agent>;
let doctorUserId: string;
let doctorCleanup: () => Promise<void>;

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorUserId = doctor.userId;
  doctorCleanup = doctor.cleanup;
});

afterAll(async () => {
  await doctorCleanup();
  await prisma.$disconnect();
});

describe('refreshSessionUser middleware', () => {
  it('lets a request through when the account is still ACTIVE with the same role', async () => {
    const res = await doctorAgent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(doctorUserId);
  });

  it('kills the session on the next request after the account is revoked', async () => {
    // First confirm the session is alive.
    const before = await doctorAgent.get('/api/auth/me');
    expect(before.status).toBe(200);

    // Doctor revokes the account out of band.
    await prisma.user.update({
      where: { id: doctorUserId },
      data: { status: 'REVOKED' },
    });

    // Next request on the same agent should be rejected.
    const after = await doctorAgent.get('/api/auth/me');
    expect(after.status).toBe(401);

    // Put the account back so other tests can keep using the agent.
    await prisma.user.update({
      where: { id: doctorUserId },
      data: { status: 'ACTIVE' },
    });
  });

  it('kills the session when the account is locked out of band', async () => {
    // Need a fresh login because the previous test destroyed the session.
    const fresh = await loginAgent(app, 'DOCTOR');
    try {
      const before = await fresh.agent.get('/api/auth/me');
      expect(before.status).toBe(200);

      await prisma.user.update({
        where: { id: fresh.userId },
        data: { status: 'LOCKED' },
      });

      const after = await fresh.agent.get('/api/auth/me');
      expect(after.status).toBe(401);
    } finally {
      await fresh.cleanup();
    }
  });

  it('kills the session when the role is changed from SECRETARY to DOCTOR', async () => {
    const secretary = await loginAgent(app, 'SECRETARY');
    try {
      const before = await secretary.agent.get('/api/auth/me');
      expect(before.status).toBe(200);
      expect(before.body.user.role).toBe('SECRETARY');

      // Doctor promotes the secretary to doctor.
      await prisma.user.update({
        where: { id: secretary.userId },
        data: { role: 'DOCTOR' },
      });

      // The old session was minted with role=SECRETARY, so the next request
      // should be rejected and force a fresh login under the new role.
      const after = await secretary.agent.get('/api/auth/me');
      expect(after.status).toBe(401);
    } finally {
      await secretary.cleanup();
    }
  });

  it('kills the session when the account is deleted out of band', async () => {
    const victim = await loginAgent(app, 'DOCTOR');
    try {
      const before = await victim.agent.get('/api/auth/me');
      expect(before.status).toBe(200);

      // Simulate the account being hard-deleted (shouldn't happen in prod, but
      // the middleware should still fail safe).
      await prisma.user.delete({ where: { id: victim.userId } });

      const after = await victim.agent.get('/api/auth/me');
      expect(after.status).toBe(401);
    } finally {
      // Already deleted; cleanup is a no-op but safe.
      await victim.cleanup();
    }
  });

  it('is a no-op for anonymous requests (health check still passes)', async () => {
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);
  });
});
