import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { hashPassword } from './auth.service.js';
import { authenticatorCode, matchingStep } from './totp.js';

it('matches the RFC 6238 SHA-1 vector truncated to six digits', () => {
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  expect(authenticatorCode(key, 1)).toBe('287082');
  expect(matchingStep(key, '287082', 59000)).toBe(1);
});

describe('staff MFA', () => {
  it.each(['DOCTOR', 'SECRETARY'] as const)('withholds all staff routes until %s verifies, encrypts the key and refuses replay', async role => {
    const app = createApp();
    const username = 'mfa-' + randomUUID();
    const password = randomUUID() + 'X!';
    const user = await prisma.user.create({ data: { username, email: username + '@test.local', fullName: 'MFA fixture',
      role, status: 'ACTIVE', passwordHash: await hashPassword(password) } });
    try {
      const agent = request.agent(app);
      const challenge = await agent.post('/api/auth/login').send({ username, password }).expect(202);
      await agent.get('/api/auth/me').expect(401);
      await agent.get('/api/clinical-images').expect(401);
      const step = Math.floor(Date.now() / 30000);
      const key = challenge.body.setupKey;
      const code = authenticatorCode(key, step);
      const wrong = ['000000', '000001', '000002', '000003'].find(c => matchingStep(key, c) === null)!;
      await agent.post('/api/auth/mfa').send({ code: wrong }).expect(401);
      await agent.get('/api/clinics').expect(401);
      await agent.post('/api/auth/mfa').send({ code }).expect(200);
      await agent.get('/api/auth/me').expect(200);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.mfaSecretEnc).toMatch(/^v1:/);
      expect(stored.mfaLastStep).toBe(step);
      await agent.post('/api/auth/logout').expect(204);
      const next = await agent.post('/api/auth/login').send({ username, password }).expect(202);
      expect(next.body.setupKey).toBeUndefined();
      await agent.post('/api/auth/mfa').send({ code }).expect(401);
      await agent.get('/api/auth/me').expect(401);
      for (let i = 0; i < 4; i++) {
        await agent.post('/api/auth/login').send({ username, password }).expect(202);
        await agent.post('/api/auth/mfa').send({ code: wrong }).expect(401);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('LOCKED');
      await agent.post('/api/auth/mfa').send({ code: authenticatorCode(key, step + 1) }).expect(401);
    } finally { await prisma.user.delete({ where: { id: user.id } }); }
  });
});
