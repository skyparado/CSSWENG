import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../prisma.js';
import { hashPassword } from '../auth/auth.service.js';

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
): Promise<{
  agent: ReturnType<typeof request.agent>;
  userId: string;
  cleanup: () => Promise<void>;
}> {
  const email = `test-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@test.local`;
  const password = 'TestPass123!';
  const hash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email,
      fullName: `Test ${role}`,
      passwordHash: hash,
      role,
      status: 'ACTIVE',
    },
  });

  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password }).expect(200);

  return {
    agent,
    userId: user.id,
    async cleanup() {
      await prisma.user
        .delete({ where: { id: user.id } })
        .catch(() => undefined);
    },
  };
}
