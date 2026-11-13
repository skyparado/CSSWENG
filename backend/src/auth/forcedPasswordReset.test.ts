import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';

/**
 * The forced password reset path (QA 1): a doctor hands out a temporary
 * password or forces a reset, and the account can then do exactly one thing,
 * which is set a new password.
 */
const app = createApp();

let doctorAgent: Awaited<ReturnType<typeof loginAgent>>;
const createdIds: string[] = [];

beforeAll(async () => {
  doctorAgent = await loginAgent(app, 'DOCTOR');
});

afterAll(async () => {
  for (const id of createdIds) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  await doctorAgent.cleanup();
  await prisma.$disconnect();
});

/** A doctor-created account, which is always issued a temporary password. */
async function newStaffAccount(password: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const username = `forced-${suffix}`;
  const res = await doctorAgent.agent.post('/api/users').send({
    username,
    email: `${username}@test.local`,
    fullName: 'Temp Password Holder',
    password,
    role: 'SECRETARY',
  });
  expect(res.status).toBe(201);
  createdIds.push(res.body.id);
  return { id: res.body.id as string, username };
}

describe('a doctor-issued password is temporary', () => {
  it('marks the new account as needing its own password', async () => {
    const { id } = await newStaffAccount('Handed-Over-77');
    const row = await prisma.user.findUnique({ where: { id } });
    expect(row?.mustResetPassword).toBe(true);
  });

  it('lets the account sign in but refuses everything except setting a password', async () => {
    const { username } = await newStaffAccount('Handed-Over-78');
    const agent = supertest.agent(app);

    // Signing in works: the person has to get far enough to fix this.
    await agent.post('/api/auth/login').send({ username, password: 'Handed-Over-78' }).expect(200);

    // Ordinary work is refused, and the response says why so the UI can route
    // them to the change-password screen.
    const blocked = await agent.get('/api/clinics');
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toMatchObject({ mustResetPassword: true });

    // The session survives the refusal; it is needed for the next step.
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
  });

  it('clears the flag once the account sets its own password, and not before', async () => {
    const { id, username } = await newStaffAccount('Handed-Over-79');
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ username, password: 'Handed-Over-79' }).expect(200);

    const changed = await agent.post('/api/auth/change-password').send({
      currentPassword: 'Handed-Over-79',
      newPassword: 'Tambourine-Kelp-42',
    });
    expect(changed.status).toBe(204);

    const row = await prisma.user.findUnique({ where: { id } });
    expect(row?.mustResetPassword).toBe(false);
    // The replaced password is now in history, so it cannot come straight back.
    expect(row?.passwordHistory.length).toBe(1);

    // Normal work is available again.
    const after = await agent.get('/api/clinics');
    expect(after.status).toBe(200);

    // The old password no longer signs in; the new one does.
    await supertest(app)
      .post('/api/auth/login')
      .send({ username, password: 'Handed-Over-79' })
      .expect(401);
    await supertest(app)
      .post('/api/auth/login')
      .send({ username, password: 'Tambourine-Kelp-42' })
      .expect(200);
  });
});

describe('POST /api/auth/change-password', () => {
  it('requires the current password, even with a reset pending', async () => {
    const { username } = await newStaffAccount('Handed-Over-80');
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ username, password: 'Handed-Over-80' }).expect(200);

    const res = await agent.post('/api/auth/change-password').send({
      currentPassword: 'not-the-current-one',
      newPassword: 'Tambourine-Kelp-42',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a new password that repeats one from the history window', async () => {
    const { username } = await newStaffAccount('Handed-Over-81');
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ username, password: 'Handed-Over-81' }).expect(200);

    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'Handed-Over-81', newPassword: 'Marmalade-Quartz-7' })
      .expect(204);

    // Going back to the password the doctor handed over is exactly what the
    // history window exists to stop.
    const res = await agent.post('/api/auth/change-password').send({
      currentPassword: 'Marmalade-Quartz-7',
      newPassword: 'Handed-Over-81',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last 5 passwords/i);
  });

  it('refuses a new password that fails the shape rules', async () => {
    const { username } = await newStaffAccount('Handed-Over-82');
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ username, password: 'Handed-Over-82' }).expect(200);

    const res = await agent.post('/api/auth/change-password').send({
      currentPassword: 'Handed-Over-82',
      newPassword: 'NoSymbolHere123',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an anonymous attempt', async () => {
    const res = await supertest(app).post('/api/auth/change-password').send({
      currentPassword: 'whatever',
      newPassword: 'Tambourine-Kelp-42',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/users/:id/force-password-reset', () => {
  it('locks an already-working account out of everything but a password change', async () => {
    const { username } = await newStaffAccount('Handed-Over-83');
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ username, password: 'Handed-Over-83' }).expect(200);
    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'Handed-Over-83', newPassword: 'Tambourine-Kelp-42' })
      .expect(204);
    expect((await agent.get('/api/clinics')).status).toBe(200);

    const target = await prisma.user.findUnique({ where: { username } });
    const forced = await doctorAgent.agent.post(`/api/users/${target!.id}/force-password-reset`);
    expect(forced.status).toBe(200);
    expect(forced.body.mustResetPassword).toBe(true);

    // Takes effect on the account's very next request, no re-login needed.
    const blocked = await agent.get('/api/clinics');
    expect(blocked.status).toBe(403);
  });

  it('is refused for a Secretary', async () => {
    const secretary = await loginAgent(app, 'SECRETARY');
    const target = await newStaffAccount('Handed-Over-84');
    const res = await secretary.agent.post(`/api/users/${target.id}/force-password-reset`);
    expect(res.status).toBe(403);
    await secretary.cleanup();
  });
});
