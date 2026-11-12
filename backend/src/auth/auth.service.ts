import argon2 from 'argon2';
import type { User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { HttpError } from '../http.js';

/**
 * Lockout policy per SRS 7.2 (updated per QA 1 feedback):
 *  - 5 failed attempts inside a rolling 15-minute window locks the account
 *  - LOCKED is permanent until a doctor unlocks via POST /api/users/:id/unlock
 */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_WINDOW_MS = 15 * 60 * 1000;

/**
 * Why a sign-in attempt failed. This is for the audit log only, which is
 * doctor-only. It is never sent to the client, because telling the browser
 * apart an unknown email from a revoked account is exactly the account
 * enumeration QA 1 asked us to close.
 */
export type AuthFailureReason =
  | 'unknown_email'
  | 'account_not_active'
  | 'wrong_password';

/**
 * 401 with "Invalid credentials" — same message for unknown email, wrong
 * password, and non-ACTIVE accounts. `attemptsRemaining` is populated only
 * when we recognised the email AND incremented a real counter. For every
 * other failure path it is null so the response carries no enumeration
 * signal.
 *
 * The remaining fields exist so the route can write a precise audit entry.
 * None of them are serialised into the response body.
 */
export class InvalidCredentialsError extends HttpError {
  readonly attemptsRemaining: number | null;
  readonly reason: AuthFailureReason;
  /** The account we matched, when we matched one. Null for unknown emails. */
  readonly userId: string | null;
  /** Account status at the time of the attempt, for the audit metadata. */
  readonly accountStatus: string | null;
  /** True when this very attempt pushed the account into LOCKED. */
  readonly lockedNow: boolean;

  constructor(opts: {
    attemptsRemaining: number | null;
    reason: AuthFailureReason;
    userId?: string | null;
    accountStatus?: string | null;
    lockedNow?: boolean;
  }) {
    super(401, 'Invalid credentials');
    this.attemptsRemaining = opts.attemptsRemaining;
    this.reason = opts.reason;
    this.userId = opts.userId ?? null;
    this.accountStatus = opts.accountStatus ?? null;
    this.lockedNow = opts.lockedNow ?? false;
  }
}

/** Hash a plaintext password with argon2id (explicit, not relying on defaults). */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Cached dummy argon2id hash. We verify against it on the unknown-email path
 * so response time is indistinguishable from a real failed verify — no
 * account enumeration via timing.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash('dummy-for-timing-mitigation', {
      type: argon2.argon2id,
    });
  }
  return dummyHashPromise;
}

/**
 * Authenticate (emailLower, password). Returns the user on success, throws
 * InvalidCredentialsError on any failure (unknown email, non-ACTIVE account,
 * wrong password). Enforces status rules and atomically bumps the failed-
 * attempt counter with SELECT ... FOR UPDATE.
 */
export async function authenticate(
  emailLower: string,
  password: string,
): Promise<User> {
  const user = await prisma.user.findUnique({ where: { email: emailLower } });

  if (!user) {
    // Timing-uniform path for unknown accounts.
    await argon2.verify(await getDummyHash(), password).catch(() => undefined);
    throw new InvalidCredentialsError({
      attemptsRemaining: null,
      reason: 'unknown_email',
    });
  }

  // Non-ACTIVE: PENDING, LOCKED, REVOKED, REJECTED all return the same error.
  // Still run the real verify so timing matches the ACTIVE+wrong-password path.
  if (user.status !== 'ACTIVE') {
    await argon2.verify(user.passwordHash, password).catch(() => undefined);
    throw new InvalidCredentialsError({
      attemptsRemaining: null,
      reason: 'account_not_active',
      userId: user.id,
      accountStatus: user.status,
    });
  }

  const ok = await argon2.verify(user.passwordHash, password);
  if (!ok) {
    const { attempts, lockedNow } = await recordFailedAttempt(user.id);
    const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - attempts);
    throw new InvalidCredentialsError({
      attemptsRemaining: remaining,
      reason: 'wrong_password',
      userId: user.id,
      accountStatus: lockedNow ? 'LOCKED' : user.status,
      lockedNow,
    });
  }

  // Success: clear counter, note last login. LOCKED is never auto-cleared
  // here — only POST /api/users/:id/unlock (doctor) clears it.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      firstFailedLoginAt: null,
      lastLoginAt: new Date(),
    },
  });

  return user;
}

/**
 * Atomic failed-attempt increment under a transaction with row lock. Two
 * simultaneous wrong-password calls serialise through the FOR UPDATE so the
 * counter never undercounts. Returns the new attempt number and whether this
 * attempt is the one that locked the account, so the caller can write the
 * lockout audit entry exactly once.
 */
async function recordFailedAttempt(
  userId: string,
): Promise<{ attempts: number; lockedNow: boolean }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        failedLoginAttempts: number;
        firstFailedLoginAt: Date | null;
        status: string;
      }>
    >`
      SELECT "failedLoginAttempts", "firstFailedLoginAt", "status"
      FROM "User"
      WHERE id = ${userId}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error(`User ${userId} vanished mid-update`);
    }
    const row = rows[0];

    const now = new Date();
    const withinWindow =
      row.firstFailedLoginAt !== null &&
      now.getTime() - row.firstFailedLoginAt.getTime() <= FAILED_WINDOW_MS;

    const nextAttempts = withinWindow ? row.failedLoginAttempts + 1 : 1;
    const nextFirstFailed = withinWindow ? row.firstFailedLoginAt : now;
    const shouldLock =
      nextAttempts >= MAX_FAILED_ATTEMPTS && row.status !== 'LOCKED';

    await tx.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: nextAttempts,
        firstFailedLoginAt: nextFirstFailed,
        ...(shouldLock ? { status: 'LOCKED' as const } : {}),
      },
    });

    return { attempts: nextAttempts, lockedNow: shouldLock };
  });
}