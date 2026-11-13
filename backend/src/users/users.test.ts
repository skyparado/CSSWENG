import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { hashPassword } from '../auth/auth.service.js';

/**
 * Integration tests for the user-admin routes (Doctor-only).
 * Covers create, update, status transitions, unlock and password reset.
 */

const app = createApp();

let doctorAgent: ReturnType<typeof request.agent>;
let secretaryAgent: ReturnType<typeof request.agent>;
let doctorCleanup: () => Promise<void>;
let secretaryCleanup: () => Promise<void>;

// Any user ids a test creates for a target of admin actions.
const createdTargetIds: string[] = [];

async function makeTarget(
  overrides: Partial<{
    email: string;
    fullName: string;
    role: 'DOCTOR' | 'SECRETARY';
    status: 'PENDING' | 'ACTIVE' | 'LOCKED' | 'REVOKED' | 'REJECTED';
  }> = {},
): Promise<string> {
  const email =
    overrides.email ??
    `target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      fullName: overrides.fullName ?? 'Target User',
      passwordHash: await hashPassword('TargetPass123!'),
      role: overrides.role ?? 'SECRETARY',
      status: overrides.status ?? 'PENDING',
    },
  });
  createdTargetIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const secretary = await loginAgent(app, 'SECRETARY');
  secretaryAgent = secretary.agent;
  secretaryCleanup = secretary.cleanup;
});

afterEach(async () => {
  // Drain targets created during the test to keep suites independent.
  for (const id of createdTargetIds.splice(0)) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
});

afterAll(async () => {
  await doctorCleanup();
  await secretaryCleanup();
  await prisma.$disconnect();
});

describe('authorization', () => {
  it('rejects an unauthenticated GET /api/users with 401', async () => {
    const res = await supertest(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('rejects a Secretary GET /api/users with 403', async () => {
    const res = await secretaryAgent.get('/api/users');
    expect(res.status).toBe(403);
  });

  it('rejects a Secretary POST /api/users with 403', async () => {
    const res = await secretaryAgent.post('/api/users').send({
      email: `nope-${Date.now()}@test.local`,
      fullName: 'Nope',
      password: 'NopePass123!',
      role: 'SECRETARY',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/users (create)', () => {
  it('creates an ACTIVE account and never returns the password hash', async () => {
    const email = `create-${Date.now()}@test.local`;
    const res = await doctorAgent.post('/api/users').send({
      email,
      fullName: 'Fresh Hire',
      password: 'FreshPass123!',
      role: 'SECRETARY',
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.passwordHash).toBeUndefined();
    createdTargetIds.push(res.body.id);
  });

  it('rejects a duplicate email with 400', async () => {
    const email = `dup-${Date.now()}@test.local`;
    const first = await doctorAgent.post('/api/users').send({
      email,
      fullName: 'First',
      password: 'FirstPass123!',
      role: 'SECRETARY',
    });
    expect(first.status).toBe(201);
    createdTargetIds.push(first.body.id);

    const second = await doctorAgent.post('/api/users').send({
      email,
      fullName: 'Second',
      password: 'SecondPass123!',
      role: 'SECRETARY',
    });
    expect(second.status).toBe(400);
  });
});

describe('status transitions', () => {
  it('approves a PENDING account (PENDING -> ACTIVE)', async () => {
    const id = await makeTarget({ status: 'PENDING' });
    const res = await doctorAgent.post(`/api/users/${id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
  });

  it('rejects a PENDING account (PENDING -> REJECTED)', async () => {
    const id = await makeTarget({ status: 'PENDING' });
    const res = await doctorAgent.post(`/api/users/${id}/reject`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
  });

  it('refuses to approve an already-ACTIVE account (400)', async () => {
    const id = await makeTarget({ status: 'ACTIVE' });
    const res = await doctorAgent.post(`/api/users/${id}/approve`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot move/i);
  });

  it('revokes an ACTIVE account (ACTIVE -> REVOKED)', async () => {
    const id = await makeTarget({ status: 'ACTIVE' });
    const res = await doctorAgent.post(`/api/users/${id}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVOKED');
  });

  it('reinstates a REVOKED account and clears lockout counters', async () => {
    const id = await makeTarget({ status: 'REVOKED' });
    // Simulate stale lockout state leftover from before revoke.
    await prisma.user.update({
      where: { id },
      data: {
        failedLoginAttempts: 4,
        firstFailedLoginAt: new Date(),
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });
    const res = await doctorAgent.post(`/api/users/${id}/reinstate`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.lockedUntil).toBeNull();

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(fresh.failedLoginAttempts).toBe(0);
    expect(fresh.firstFailedLoginAt).toBeNull();
  });

  it('unlocks a LOCKED account (LOCKED -> ACTIVE) and clears counters', async () => {
    const id = await makeTarget({ status: 'LOCKED' });
    await prisma.user.update({
      where: { id },
      data: {
        failedLoginAttempts: 5,
        firstFailedLoginAt: new Date(),
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });
    const res = await doctorAgent.post(`/api/users/${id}/unlock`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(fresh.failedLoginAttempts).toBe(0);
    expect(fresh.lockedUntil).toBeNull();
  });
});

describe('PATCH /api/users/:id', () => {
  it('updates fullName and role', async () => {
    const id = await makeTarget({ status: 'ACTIVE', role: 'SECRETARY' });
    const res = await doctorAgent
      .patch(`/api/users/${id}`)
      .send({ fullName: 'Renamed Person', role: 'DOCTOR' });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe('Renamed Person');
    expect(res.body.role).toBe('DOCTOR');
  });

  it('rejects an empty payload with 400', async () => {
    const id = await makeTarget({ status: 'ACTIVE' });
    const res = await doctorAgent.patch(`/api/users/${id}`).send({});
    expect(res.status).toBe(400);
  });
});

describe('reset password', () => {
  it('lets the target log in with the new password after reset', async () => {
    const email = `reset-${Date.now()}@test.local`;
    const original = await prisma.user.create({
      data: {
        email,
        fullName: 'Reset Target',
        passwordHash: await hashPassword('OldPass123!'),
        role: 'SECRETARY',
        status: 'ACTIVE',
      },
    });
    createdTargetIds.push(original.id);

    const res = await doctorAgent
      .post(`/api/users/${original.id}/reset-password`)
      .send({ password: 'BrandNewPass123!' });
    expect(res.status).toBe(200);

    // Old password should fail.
    const oldLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email, password: 'OldPass123!' });
    expect(oldLogin.status).toBe(401);

    // New password should work.
    const newLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email, password: 'BrandNewPass123!' });
    expect(newLogin.status).toBe(200);
  });
});


describe('password policy (QA 1)', () => {
  const WEAK: Array<[string, string]> = [
    ['too short', 'Short1Pass'],
    ['no uppercase', 'alllowercase123'],
    ['no lowercase', 'ALLUPPERCASE123'],
    ['no number', 'NoDigitsHereAtAll'],
    ['padded with a space', ' LeadingSpace123'],
    ['a common password', 'Password123'],
  ];

  it.each(WEAK)('refuses a new account with a password that is %s', async (_label, password) => {
    const email = `weak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const res = await doctorAgent
      .post('/api/users')
      .send({ email, fullName: 'Weak Password', password, role: 'SECRETARY' });
    expect(res.status).toBe(400);
    // Nothing half-created: the account must not exist after a refusal.
    const found = await prisma.user.findUnique({ where: { email } });
    expect(found).toBeNull();
  });

  it('refuses a reset that would weaken an existing password', async () => {
    const email = `reset-weak-${Date.now()}@test.local`;
    const created = await doctorAgent
      .post('/api/users')
      .send({ email, fullName: 'Reset Target', password: 'StrongEnough123', role: 'SECRETARY' });
    expect(created.status).toBe(201);
    createdTargetIds.push(created.body.id);

    const res = await doctorAgent
      .post(`/api/users/${created.body.id}/reset-password`)
      .send({ password: 'weak' });
    expect(res.status).toBe(400);

    // The original password still works, so the refusal changed nothing.
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email, password: 'StrongEnough123' });
    expect(login.status).toBe(200);
  });

  it('accepts a password that meets the policy at the minimum length', async () => {
    const email = `ok-${Date.now()}@test.local`;
    const res = await doctorAgent
      .post('/api/users')
      .send({ email, fullName: 'Just Enough', password: 'Abcdefghij12', role: 'SECRETARY' });
    expect(res.status).toBe(201);
    createdTargetIds.push(res.body.id);
  });

  it('does not apply the policy to signing in, so it is never revealed there', async () => {
    // A short wrong password gets the ordinary 401, not a validation error that
    // would tell an attacker what the policy is.
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: `nobody-${Date.now()}@test.local`, password: 'x' });
    expect(res.status).toBe(401);
  });
});
