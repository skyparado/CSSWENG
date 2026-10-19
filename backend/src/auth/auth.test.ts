import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../prisma.js';
import { authenticate, hashPassword } from './auth.service.js';
import { HttpError } from '../http.js';

/**
 * Integration tests for the lockout policy in auth.service. These hit the
 * local Postgres directly through Prisma.
 *
 * Each test creates its own user with a unique email so parallel runs do not
 * collide, and tears it down at the end.
 */
describe('auth.service lockout policy', () => {
  const uniqueEmail = () =>
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;

  async function createUser(email: string, password: string) {
    const hash = await hashPassword(password);
    return prisma.user.create({
      data: {
        email,
        fullName: 'Test User',
        passwordHash: hash,
        role: 'SECRETARY',
        status: 'ACTIVE',
      },
    });
  }

  async function cleanup(email: string) {
    await prisma.user.deleteMany({ where: { email } });
  }

  it('authenticates with the correct password and clears failure counters', async () => {
    const email = uniqueEmail();
    const password = 'CorrectPass123!';
    await createUser(email, password);

    const user = await authenticate(email, password);
    expect(user.email).toBe(email);

    const after = await prisma.user.findUnique({ where: { email } });
    expect(after?.failedLoginAttempts).toBe(0);
    expect(after?.lockedUntil).toBeNull();
    expect(after?.lastLoginAt).not.toBeNull();

    await cleanup(email);
  });

  it('rejects a wrong password with 401 and increments the failure counter', async () => {
    const email = uniqueEmail();
    await createUser(email, 'CorrectPass123!');

    await expect(authenticate(email, 'wrong')).rejects.toMatchObject({
      status: 401,
    });

    const after = await prisma.user.findUnique({ where: { email } });
    expect(after?.failedLoginAttempts).toBe(1);
    expect(after?.firstFailedLoginAt).not.toBeNull();

    await cleanup(email);
  });

  it('locks the account after 5 consecutive failed attempts (SRS 7.2)', async () => {
    const email = uniqueEmail();
    await createUser(email, 'CorrectPass123!');

    for (let i = 0; i < 5; i++) {
      await expect(authenticate(email, 'wrong')).rejects.toBeInstanceOf(
        HttpError,
      );
    }

    const locked = await prisma.user.findUnique({ where: { email } });
    expect(locked?.status).toBe('LOCKED');
    expect(locked?.lockedUntil).not.toBeNull();
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // A sixth attempt — even with the CORRECT password — should still be
    // rejected because the lockout window has not expired.
    await expect(authenticate(email, 'CorrectPass123!')).rejects.toMatchObject({
      status: 423,
    });

    await cleanup(email);
  });

  it('rejects a REVOKED account with 403', async () => {
    const email = uniqueEmail();
    const user = await createUser(email, 'CorrectPass123!');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'REVOKED' },
    });

    await expect(authenticate(email, 'CorrectPass123!')).rejects.toMatchObject({
      status: 403,
    });

    await cleanup(email);
  });

  it('rejects a PENDING account with 403', async () => {
    const email = uniqueEmail();
    const user = await createUser(email, 'CorrectPass123!');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'PENDING' },
    });

    await expect(authenticate(email, 'CorrectPass123!')).rejects.toMatchObject({
      status: 403,
    });

    await cleanup(email);
  });

  it('returns the same 401 for unknown email as for wrong password', async () => {
    const email = uniqueEmail();
    await expect(authenticate(email, 'anything')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid email or password',
    });
  });
});