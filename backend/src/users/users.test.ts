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
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = overrides.email ?? `target-${suffix}@test.local`;
  const user = await prisma.user.create({
    data: {
      username: `target-${suffix}`,
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
      username: `nope-${Date.now()}`,
      email: `nope-${Date.now()}@test.local`,
      fullName: 'Nope',
      password: 'Tambourine-Kelp-42',
      role: 'SECRETARY',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/users (create)', () => {
  it('creates an ACTIVE account and never returns the password hash', async () => {
    const username = `create-${Date.now()}`;
    const email = `${username}@test.local`;
    const res = await doctorAgent.post('/api/users').send({
      username,
      email,
      fullName: 'Fresh Hire',
      password: 'Marmalade-Quartz-7',
      role: 'SECRETARY',
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.passwordHash).toBeUndefined();
    createdTargetIds.push(res.body.id);
  });

  it('rejects a duplicate email with 400', async () => {
    const username = `dup-${Date.now()}`;
    const email = `${username}@test.local`;
    const first = await doctorAgent.post('/api/users').send({
      username: `${username}-a`,
      email,
      fullName: 'First',
      password: 'Lantern-Bramble-19',
      role: 'SECRETARY',
    });
    expect(first.status).toBe(201);
    createdTargetIds.push(first.body.id);

    const second = await doctorAgent.post('/api/users').send({
      username: `${username}-b`,
      email,
      fullName: 'Second',
      password: 'Kingfisher-Loom-83',
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
    const username = `reset-${Date.now()}`;
    const original = await prisma.user.create({
      data: {
        username,
        email: `${username}@test.local`,
        fullName: 'Reset Target',
        passwordHash: await hashPassword('Driftwood-Ember-31'),
        role: 'SECRETARY',
        status: 'ACTIVE',
      },
    });
    createdTargetIds.push(original.id);

    const res = await doctorAgent
      .post(`/api/users/${original.id}/reset-password`)
      .send({ password: 'Harbour-Thimble-55' });
    expect(res.status).toBe(200);

    // Old password should fail.
    const oldLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ username, password: 'Driftwood-Ember-31' });
    expect(oldLogin.status).toBe(401);

    // New password should work.
    const newLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ username, password: 'Harbour-Thimble-55' });
    expect(newLogin.status).toBe(200);
  });
});


describe('password policy (QA 1)', () => {
  const WEAK: Array<[string, string]> = [
    ['too short', 'Short1Pass!'],
    ['missing a letter', '1234567890!!'],
    ['missing a number', 'NoDigitsHere!'],
    ['missing a symbol', 'NoSymbolHere123'],
    ['padded with a space', ' LeadingSpace1!'],
    ['on the breached list', 'Password123!'],
    ['built from the account name', 'Policy-Subject-1!'],
  ];

  it.each(WEAK)('refuses a new account with a password %s', async (_label, password) => {
    const username = `weak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${username}@test.local`;
    const res = await doctorAgent
      .post('/api/users')
      .send({ username, email, fullName: 'Policy Subject', password, role: 'SECRETARY' });
    expect(res.status).toBe(400);
    // Nothing half-created: the account must not exist after a refusal.
    const found = await prisma.user.findUnique({ where: { email } });
    expect(found).toBeNull();
  });

  it('refuses a reset that would weaken an existing password', async () => {
    const username = `reset-weak-${Date.now()}`;
    const email = `${username}@test.local`;
    const created = await doctorAgent
      .post('/api/users')
      .send({ username, email, fullName: 'Reset Target', password: 'Sandpiper-Vellum-6', role: 'SECRETARY' });
    expect(created.status).toBe(201);
    createdTargetIds.push(created.body.id);

    const res = await doctorAgent
      .post(`/api/users/${created.body.id}/reset-password`)
      .send({ password: 'weak' });
    expect(res.status).toBe(400);

    // The original password still works, so the refusal changed nothing.
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ username, password: 'Sandpiper-Vellum-6' });
    expect(login.status).toBe(200);
  });

  it('accepts a password that meets the policy at the minimum length', async () => {
    const username = `ok-${Date.now()}`;
    const email = `${username}@test.local`;
    const res = await doctorAgent
      .post('/api/users')
      .send({ username, email, fullName: 'Just Enough', password: 'Abcdefghij1!', role: 'SECRETARY' });
    expect(res.status).toBe(201);
    createdTargetIds.push(res.body.id);
  });

  it('does not apply the policy to signing in, so it is never revealed there', async () => {
    // A short wrong password gets the ordinary 401, not a validation error that
    // would tell an attacker what the policy is.
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ username: `nobody-${Date.now()}`, password: 'x' });
    expect(res.status).toBe(401);
  });
});


describe('username (SRS, SDD, S01)', () => {
  it('refuses a username that is already taken, without saying whose', async () => {
    const username = `taken-${Date.now()}`;
    const first = await doctorAgent.post('/api/users').send({
      username,
      email: `${username}-a@test.local`,
      fullName: 'First Holder',
      password: 'Tambourine-Kelp-42',
      role: 'SECRETARY',
    });
    expect(first.status).toBe(201);
    createdTargetIds.push(first.body.id);

    const second = await doctorAgent.post('/api/users').send({
      username,
      email: `${username}-b@test.local`,
      fullName: 'Second Holder',
      password: 'Marmalade-Quartz-7',
      role: 'SECRETARY',
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/username/i);
  });

  it.each([
    ['too short', 'ab'],
    ['has a space', 'ana reyes'],
    ['has an at sign', 'ana@clinic'],
    ['starts with a dot', '.ana'],
  ])('refuses a username that is %s', async (_label, username) => {
    const res = await doctorAgent.post('/api/users').send({
      username,
      email: `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: 'Shape Check',
      password: 'Tambourine-Kelp-42',
      role: 'SECRETARY',
    });
    expect(res.status).toBe(400);
  });

  it('stores a username lowercased so case cannot lock anyone out', async () => {
    const base = `MixedCase${Date.now()}`;
    const res = await doctorAgent.post('/api/users').send({
      username: base,
      email: `mixed-${Date.now()}@test.local`,
      fullName: 'Mixed Case',
      password: 'Lantern-Bramble-19',
      role: 'SECRETARY',
    });
    expect(res.status).toBe(201);
    createdTargetIds.push(res.body.id);
    expect(res.body.username).toBe(base.toLowerCase());

    // Typed in any case, it signs in.
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ username: base.toUpperCase(), password: 'Lantern-Bramble-19' });
    expect(login.status).toBe(200);
  });

  it('does not accept the email address as a credential any more', async () => {
    const username = `nomail-${Date.now()}`;
    const email = `${username}@test.local`;
    const created = await doctorAgent.post('/api/users').send({
      username,
      email,
      fullName: 'No Mail Login',
      password: 'Driftwood-Ember-31',
      role: 'SECRETARY',
    });
    expect(created.status).toBe(201);
    createdTargetIds.push(created.body.id);

    const byEmail = await supertest(app)
      .post('/api/auth/login')
      .send({ username: email, password: 'Driftwood-Ember-31' });
    expect(byEmail.status).toBe(401);

    const byUsername = await supertest(app)
      .post('/api/auth/login')
      .send({ username, password: 'Driftwood-Ember-31' });
    expect(byUsername.status).toBe(200);
  });
});
