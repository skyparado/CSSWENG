import { describe, it, expect } from 'vitest';
import { prisma } from '../prisma.js';
import {
  authenticate,
  hashPassword,
  InvalidCredentialsError,
} from './auth.service.js';

/**
 * Integration tests for the lockout policy in auth.service (QA 1 updated):
 *  - All failure paths return 401 "Invalid credentials" (no status leak)
 *  - LOCKED is permanent until the doctor unlocks (POST /api/users/:id/unlock)
 *  - Failed-attempt counter increments atomically
 *  - Unknown usernames still run a hash verify (timing-attack mitigation)
 *
 * Each test creates its own user with a unique username so parallel runs do
 * not collide, and tears it down at the end.
 */
describe('auth.service lockout policy', () => {
  // A username, not an email: authenticate() takes the sign-in credential.
  const uniqueLogin = () =>
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  async function createUser(login: string, password: string) {
    const hash = await hashPassword(password);
    return prisma.user.create({
      data: {
        username: login,
        email: `${login}@test.local`,
        fullName: 'Test User',
        passwordHash: hash,
        role: 'SECRETARY',
        status: 'ACTIVE',
      },
    });
  }

  async function cleanup(login: string) {
    await prisma.user.deleteMany({ where: { username: login } });
  }

  it('authenticates with the correct password and clears failure counters', async () => {
    const login = uniqueLogin();
    const password = 'CorrectPass123!';
    await createUser(login, password);

    const user = await authenticate(login, password);
    expect(user.username).toBe(login);

    const after = await prisma.user.findUnique({ where: { username: login } });
    expect(after?.failedLoginAttempts).toBe(0);
    expect(after?.lastLoginAt).not.toBeNull();

    await cleanup(login);
  });

  it('rejects a wrong password with 401 "Invalid credentials" and carries attemptsRemaining', async () => {
    const login = uniqueLogin();
    await createUser(login, 'CorrectPass123!');

    await expect(authenticate(login, 'wrong')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
      attemptsRemaining: 4,
    });

    const after = await prisma.user.findUnique({ where: { username: login } });
    expect(after?.failedLoginAttempts).toBe(1);
    expect(after?.firstFailedLoginAt).not.toBeNull();

    await cleanup(login);
  });

  it('locks the account after 5 consecutive failed attempts (SRS 7.2)', async () => {
    const login = uniqueLogin();
    await createUser(login, 'CorrectPass123!');

    for (let i = 0; i < 5; i++) {
      await expect(authenticate(login, 'wrong')).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    }

    const locked = await prisma.user.findUnique({ where: { username: login } });
    expect(locked?.status).toBe('LOCKED');
    expect(locked?.failedLoginAttempts).toBe(5);

    await cleanup(login);
  });

  it('keeps a LOCKED account locked indefinitely — even with the correct password — until the doctor unlocks', async () => {
    const login = uniqueLogin();
    const password = 'CorrectPass123!';
    const user = await createUser(login, password);

    // Simulate the lockout state the doctor would see.
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'LOCKED', failedLoginAttempts: 5 },
    });

    // Correct password: still rejected with the generic 401 — status is NOT
    // revealed, and it never auto-clears.
    await expect(authenticate(login, password)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
      attemptsRemaining: null,
    });

    // Simulate the doctor's unlock (POST /api/users/:id/unlock clears
    // status + counters). After that, the correct password works again.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'ACTIVE',
        failedLoginAttempts: 0,
        firstFailedLoginAt: null,
        lockedUntil: null,
      },
    });
    const authed = await authenticate(login, password);
    expect(authed.username).toBe(login);

    await cleanup(login);
  });

  it('rejects a REVOKED account with the same generic 401 (no status leak)', async () => {
    const login = uniqueLogin();
    const user = await createUser(login, 'CorrectPass123!');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'REVOKED' },
    });

    await expect(authenticate(login, 'CorrectPass123!')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
      attemptsRemaining: null,
    });

    await cleanup(login);
  });

  it('rejects a PENDING account with the same generic 401 (no status leak)', async () => {
    const login = uniqueLogin();
    const user = await createUser(login, 'CorrectPass123!');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'PENDING' },
    });

    await expect(authenticate(login, 'CorrectPass123!')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
      attemptsRemaining: null,
    });

    await cleanup(login);
  });

  it('returns the same 401 for unknown login as for wrong password (no account enumeration)', async () => {
    const login = uniqueLogin();
    await expect(authenticate(login, 'anything')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
      attemptsRemaining: null,
    });
  });
});