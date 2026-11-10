import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { hashPassword } from '../auth/auth.service.js';
import { AuditActions } from './actions.js';
import {
  drainAuditWrites,
  waitForAudit,
  waitForAuditCount,
} from '../test-utils/waitForAudit.js';

/**
 * Named audit entries for the sign-in paths (QA 1.3).
 *
 * Before this the only thing written was the middleware's generic
 * HTTP_REQUEST row, so the audit screen could not answer "who failed to sign
 * in" or "when did this account lock".
 */

const app = createApp();

const PASSWORD = 'AuditPass123!';
let email = '';
let userId = '';

/** Newest entry with this action for the account under test. */
function latest(action: string) {
  return waitForAudit({ action, resourceId: userId });
}

beforeAll(async () => {
  email = `audit-auth-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      fullName: 'Audit Auth Test',
      passwordHash: await hashPassword(PASSWORD),
      role: 'SECRETARY',
      status: 'ACTIVE',
    },
  });
  userId = user.id;
});

afterAll(async () => {
  // Let queued writes finish before deleting the user, so a pending one is
  // not still holding the audit advisory lock during cleanup.
  await drainAuditWrites();
  // Audit rows are append-only by design, so only the user is cleaned up.
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
});

describe('login audit entries (QA 1.3)', () => {
  it('writes LOGIN_SUCCESS with the actor on a good sign-in', async () => {
    await supertest(app)
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    const entry = await latest(AuditActions.LOGIN_SUCCESS);
    expect(entry.userId).toBe(userId);
    expect(entry.userEmail).toBe(email);
    expect(entry.userRole).toBe('SECRETARY');
    expect(entry.statusCode).toBe(200);
  });

  it('writes LOGIN_FAILED with the reason on a wrong password', async () => {
    await supertest(app)
      .post('/api/auth/login')
      .send({ email, password: 'definitely-wrong' })
      .expect(401);

    const entry = await latest(AuditActions.LOGIN_FAILED);
    expect(entry.userId).toBe(userId);
    expect(entry.statusCode).toBe(401);
    const meta = entry.metadata as { reason?: string } | null;
    expect(meta?.reason).toBe('wrong_password');
  });

  it('records an unknown email without inventing a user id', async () => {
    const unknownEmail = `nobody-${Date.now()}@test.local`;

    await supertest(app)
      .post('/api/auth/login')
      .send({ email: unknownEmail, password: 'whatever' })
      .expect(401);

    // Matched on the email that was tried. Picking the most recent
    // LOGIN_FAILED would catch another spec's entry instead, since the
    // writes are fire-and-forget and can land out of order.
    const entry = await waitForAudit({
      action: AuditActions.LOGIN_FAILED,
      userEmail: unknownEmail,
    });

    // No user id: there is no account, and inventing one would be a lie.
    expect(entry.userId).toBeNull();
    expect(entry.resourceId).toBeNull();
    const meta = entry.metadata as { reason?: string } | null;
    expect(meta?.reason).toBe('unknown_email');
  });

  it('writes LOGOUT when a session is destroyed', async () => {
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    await agent.post('/api/auth/logout').expect(204);

    const entry = await latest(AuditActions.LOGOUT);
    expect(entry.userId).toBe(userId);
    expect(entry.statusCode).toBe(204);
  });

  it('writes a single ACCOUNT_LOCKED entry on the attempt that locks', async () => {
    const lockEmail = `audit-lock-${Date.now()}@test.local`;
    const locking = await prisma.user.create({
      data: {
        email: lockEmail,
        fullName: 'Audit Lock Test',
        passwordHash: await hashPassword(PASSWORD),
        role: 'SECRETARY',
        status: 'ACTIVE',
      },
    });

    try {
      // Five wrong passwords is the threshold in auth.service.
      for (let i = 0; i < 5; i += 1) {
        await supertest(app)
          .post('/api/auth/login')
          .send({ email: lockEmail, password: 'wrong' })
          .expect(401);
      }

      const locked = await prisma.user.findUnique({ where: { id: locking.id } });
      expect(locked?.status).toBe('LOCKED');

      const lockEntries = await waitForAuditCount(
        { action: AuditActions.ACCOUNT_LOCKED, resourceId: locking.id },
        1,
      );
      // Exactly one: a sixth attempt must not log a second lockout.
      expect(lockEntries).toHaveLength(1);

      await supertest(app)
        .post('/api/auth/login')
        .send({ email: lockEmail, password: 'wrong' })
        .expect(401);

      // Give that attempt's writes time to land, then confirm the count did
      // not move. Waiting matters here: checking straight away would pass
      // even if a second entry were on its way.
      await drainAuditWrites();
      const stillOne = await prisma.auditLog.count({
        where: { action: AuditActions.ACCOUNT_LOCKED, resourceId: locking.id },
      });
      expect(stillOne).toBe(1);
    } finally {
      await drainAuditWrites();
      await prisma.user.delete({ where: { id: locking.id } }).catch(() => undefined);
    }
  });

  it('does not also write a generic HTTP_REQUEST row for an audited login', async () => {
    const before = await prisma.auditLog.count({
      where: { action: AuditActions.HTTP_REQUEST, path: '/api/auth/login' },
    });

    await supertest(app)
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    // Wait for the named entry to land, which means the request's audit work
    // is done, then confirm no generic row joined it.
    await waitForAudit({ action: AuditActions.LOGIN_SUCCESS, resourceId: userId });
    await drainAuditWrites();

    const after = await prisma.auditLog.count({
      where: { action: AuditActions.HTTP_REQUEST, path: '/api/auth/login' },
    });
    expect(after).toBe(before);
  });
});
