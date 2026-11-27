import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../prisma.js';
import { authenticatorCode } from '../auth/totp.js';
import { decrypt } from '../lib/fieldCrypto.js';
import { hashPassword } from '../auth/auth.service.js';

/** Exercise both sign-in steps. Distinct time steps keep repeated fixture logins independent. */
export async function signInStaff(agent: ReturnType<typeof request.agent>, username: string, password: string) {
  const challenge = await agent.post('/api/auth/login').send({ username, password }).expect(202);
  const user = await prisma.user.findUniqueOrThrow({ where: { username } });
  const key = challenge.body.setupKey ?? decrypt(user.mfaSecretEnc!);
  const step = Math.max(Math.floor(Date.now() / 30000) - 1, (user.mfaLastStep ?? 0) + 1);
  if (step > Math.floor(Date.now() / 30000) + 1) await new Promise(r => setTimeout(r, (step - 1) * 30000 - Date.now() + 50));
  return agent.post('/api/auth/mfa').send({ code: authenticatorCode(key, step) }).expect(200);
}

/**
 * Create a supertest agent authenticated as a throwaway user with the given
 * role. The agent keeps the session cookie between requests, so subsequent
 * calls look like they come from the same logged-in user.
 *
 * Returns a `cleanup` function that deletes the test user. Call it in
 * afterAll so parallel suites do not leave rows behind.
 */
export async function loginAgent(
  app: Express,
  role: 'DOCTOR' | 'SECRETARY' = 'DOCTOR',
  /**
   * Assign this clinic to the account and select it, so the agent can reach
   * routes behind requireClinicAccess. A Secretary also gets the UserClinic
   * row, without which select-clinic refuses her.
   */
  clinicId?: string,
): Promise<{
  agent: ReturnType<typeof request.agent>;
  userId: string;
  /** What this account signs in with, for tests that log in a second time. */
  username: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
}> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const username = `test-${suffix}`;
  const email = `test-${suffix}@test.local`;
  const password = 'TestPass123!';
  const hash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      username,
      email,
      fullName: `Test ${role}`,
      passwordHash: hash,
      role,
      status: 'ACTIVE',
    },
  });

  if (clinicId) {
    await prisma.userClinic.create({ data: { userId: user.id, clinicId } });
  }

  const agent = request.agent(app);
  await signInStaff(agent, username, password);

  if (clinicId) {
    await agent.post('/api/auth/select-clinic').send({ clinicId }).expect(200);
  }

  return {
    agent,
    userId: user.id,
    username,
    email,
    password,
    async cleanup() {
      // UserClinic cascades on user delete, but be explicit so a failed
      // cascade does not leave the row pointing at a deleted account.
      await prisma.userClinic
        .deleteMany({ where: { userId: user.id } })
        .catch(() => undefined);
      await prisma.user
        .delete({ where: { id: user.id } })
        .catch(() => undefined);
    },
  };
}
