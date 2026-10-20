import argon2 from 'argon2';
import type { User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { HttpError } from '../http.js';

/**
 * Lockout policy per SRS 7.2: 5 failed attempts inside this rolling 15-minute
 * window locks the account. The lock itself also lasts 15 minutes before the
 * next attempt is allowed.
 */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const ARGON_OPTS = { type: argon2.argon2id };

/** Hash a plaintext password. Used by the seed script and user creation. */
export async function hashPassword(plain: string): Promise<string> {
  // argon2id is the default algorithm in argon2 v0.40+, so no options needed.
  return argon2.hash(plain);
}

/**
 * Authenticate (email, password). On success returns the user record. On any
 * failure throws an HttpError. Also enforces the account status rules and the
 * lockout counter.
 */
export async function authenticate(
  emailLower: string,
  password: string,
): Promise<User> {
  const user = await prisma.user.findUnique({ where: { email: emailLower } });

  // Same generic 401 for both "no such user" and "wrong password" so an
  // attacker cannot enumerate accounts by trying different emails.
  if (!user) {
    throw new HttpError(401, 'Invalid email or password');
  }

  if (user.status === 'REVOKED') {
    throw new HttpError(403, 'This account has been revoked.');
  }
  if (user.status === 'PENDING') {
    throw new HttpError(403, 'This account is awaiting doctor approval.');
  }

  // Honor an active lockout window.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new HttpError(
      423,
      'Account is temporarily locked after repeated failed attempts. Try again later.',
    );
  }

  const ok = await argon2.verify(user.passwordHash, password);
  if (!ok) {
    await recordFailedAttempt(user);
    throw new HttpError(401, 'Invalid email or password');
  }

  // Success: clear the failure counter, lift any lockout, note last login.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      firstFailedLoginAt: null,
      lockedUntil: null,
      status: user.status === 'LOCKED' ? 'ACTIVE' : user.status,
      lastLoginAt: new Date(),
    },
  });

  return user;
}

async function recordFailedAttempt(user: User): Promise<void> {
  const now = new Date();
  const windowStart = user.firstFailedLoginAt;
  const withinWindow =
    windowStart !== null &&
    now.getTime() - windowStart.getTime() <= FAILED_WINDOW_MS;

  // Reset the counter if we're outside the previous 15-minute window.
  const nextAttempts = withinWindow ? user.failedLoginAttempts + 1 : 1;
  const nextFirstFailed = withinWindow ? windowStart : now;
  const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: nextAttempts,
      firstFailedLoginAt: nextFirstFailed,
      ...(shouldLock
        ? {
            status: 'LOCKED',
            lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS),
          }
        : {}),
    },
  });
}