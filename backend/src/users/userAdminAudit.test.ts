import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { hashPassword } from '../auth/auth.service.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { AuditActions } from '../audit/actions.js';
import { drainAuditWrites, waitForAudit } from '../test-utils/waitForAudit.js';

/**
 * Account approval trail (QA 4.1) and audit entries for every account
 * decision (QA 4.4).
 */

const app = createApp();

let doctor: Awaited<ReturnType<typeof loginAgent>>;
const createdUserIds: string[] = [];

/** A fresh PENDING account, as a self-registration would leave it. */
async function pendingUser(requestedRole: 'DOCTOR' | 'SECRETARY' = 'SECRETARY') {
  const user = await prisma.user.create({
    data: {
      username: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      fullName: 'Pending Applicant',
      passwordHash: await hashPassword('PendingPass123!'),
      role: requestedRole,
      requestedRole,
      status: 'PENDING',
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/**
 * Audit writes are fire-and-forget, so poll rather than reading once. The
 * route returns before the entry has necessarily landed.
 */
function auditFor(action: string, resourceId: string) {
  return waitForAudit({ action, resourceId });
}

beforeAll(async () => {
  doctor = await loginAgent(app, 'DOCTOR');
});

afterAll(async () => {
  // Let queued audit writes finish before the deletes, so a pending one is
  // not still holding the audit advisory lock.
  await drainAuditWrites();
  for (const id of createdUserIds) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  await doctor.cleanup();
});

describe('account approval trail (QA 4.1)', () => {
  it('records who approved an account and when', async () => {
    const applicant = await pendingUser('SECRETARY');

    const res = await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.approvedById).toBe(doctor.userId);
    expect(res.body.approvedAt).not.toBeNull();
    // Role was not overridden, so requested and granted agree.
    expect(res.body.requestedRole).toBe('SECRETARY');
    expect(res.body.role).toBe('SECRETARY');
  });

  it('enforces the role the doctor granted, not the one requested', async () => {
    const applicant = await pendingUser('DOCTOR');

    const res = await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({ grantedRole: 'SECRETARY' })
      .expect(200);

    // The record keeps both, so the admin screen can show the difference.
    expect(res.body.requestedRole).toBe('DOCTOR');
    expect(res.body.role).toBe('SECRETARY');

    const stored = await prisma.user.findUnique({ where: { id: applicant.id } });
    expect(stored?.role).toBe('SECRETARY');
  });

  it('records the decider on a rejection too', async () => {
    const applicant = await pendingUser();

    const res = await doctor.agent
      .post(`/api/users/${applicant.id}/reject`)
      .expect(200);

    expect(res.body.status).toBe('REJECTED');
    expect(res.body.approvedById).toBe(doctor.userId);
    expect(res.body.approvedAt).not.toBeNull();
  });

  it('marks a doctor-created account as self-approved', async () => {
    const username = `made-${Date.now()}`;
    const res = await doctor.agent
      .post('/api/users')
      .send({
        username,
        email: `${username}@test.local`,
        fullName: 'Directly Created',
        password: 'Tambourine-Kelp-42',
        role: 'SECRETARY',
      })
      .expect(201);

    createdUserIds.push(res.body.id);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.approvedById).toBe(doctor.userId);
    expect(res.body.requestedRole).toBe('SECRETARY');
  });
});

describe('account decision audit entries (QA 4.4)', () => {
  it('writes USER_APPROVED carrying requested and granted roles', async () => {
    const applicant = await pendingUser('DOCTOR');
    await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({ grantedRole: 'SECRETARY' })
      .expect(200);

    const entry = await auditFor(AuditActions.USER_APPROVED, applicant.id);
    expect(entry.userId).toBe(doctor.userId);
    const meta = entry.metadata as {
      requestedRole?: string;
      grantedRole?: string;
    } | null;
    expect(meta?.requestedRole).toBe('DOCTOR');
    expect(meta?.grantedRole).toBe('SECRETARY');
  });

  it('writes USER_REVOKED and USER_REINSTATED', async () => {
    const applicant = await pendingUser();
    await doctor.agent.post(`/api/users/${applicant.id}/approve`).send({}).expect(200);
    await doctor.agent.post(`/api/users/${applicant.id}/revoke`).expect(200);

    const revoked = await auditFor(AuditActions.USER_REVOKED, applicant.id);
    expect(revoked.userId).toBe(doctor.userId);

    await doctor.agent.post(`/api/users/${applicant.id}/reinstate`).expect(200);
    const reinstated = await auditFor(AuditActions.USER_REINSTATED, applicant.id);
    expect(reinstated.userId).toBe(doctor.userId);
  });

  it('writes USER_UNLOCKED when the doctor unlocks an account', async () => {
    const applicant = await pendingUser();
    await doctor.agent.post(`/api/users/${applicant.id}/approve`).send({}).expect(200);
    await prisma.user.update({
      where: { id: applicant.id },
      data: { status: 'LOCKED', failedLoginAttempts: 5 },
    });

    await doctor.agent.post(`/api/users/${applicant.id}/unlock`).expect(200);

    const entry = await auditFor(AuditActions.USER_UNLOCKED, applicant.id);
    expect(entry.userId).toBe(doctor.userId);
  });

  it('writes USER_PASSWORD_RESET without storing the password', async () => {
    const applicant = await pendingUser();
    await doctor.agent.post(`/api/users/${applicant.id}/approve`).send({}).expect(200);

    const secret = 'BrandNewPass123!';
    await doctor.agent
      .post(`/api/users/${applicant.id}/reset-password`)
      .send({ password: secret })
      .expect(200);

    const entry = await auditFor(AuditActions.USER_PASSWORD_RESET, applicant.id);
    expect(entry.userId).toBe(doctor.userId);
    // The whole entry is checked, not just metadata: a password must not
    // reach the audit log through any field.
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it('refuses a secretary on every account endpoint', async () => {
    const secretary = await loginAgent(app, 'SECRETARY');
    try {
      await secretary.agent.get('/api/users').expect(403);
      await secretary.agent.post('/api/users/some-id/approve').send({}).expect(403);
      await secretary.agent.post('/api/users/some-id/revoke').expect(403);
    } finally {
      await secretary.cleanup();
    }
  });
});
