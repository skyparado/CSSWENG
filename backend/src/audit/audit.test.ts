import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { writeAudit, verifyChain } from './audit.service.js';
import { AuditActions } from './actions.js';

/**
 * Integration tests for the audit log: hash-chain integrity, append-only
 * triggers, HTTP middleware auto-logging and the Doctor-only read routes.
 */

const app = createApp();

let doctorAgent: ReturnType<typeof request.agent>;
let secretaryAgent: ReturnType<typeof request.agent>;
let doctorCleanup: () => Promise<void>;
let secretaryCleanup: () => Promise<void>;

/**
 * TRUNCATE bypasses the BEFORE UPDATE/DELETE row triggers (they only fire per
 * row). We use it for test isolation; production code must never do this.
 */
async function clearAuditLog(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditLog"');
}

/** Small helper so middleware's fire-and-forget writes have time to land. */
function flushAudit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

function sampleEntry(overrides: Partial<Parameters<typeof writeAudit>[0]> = {}) {
  return {
    userId: null,
    userEmail: null,
    userRole: null,
    action: 'TEST_EVENT',
    resourceType: null,
    resourceId: null,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const secretary = await loginAgent(app, 'SECRETARY');
  secretaryAgent = secretary.agent;
  secretaryCleanup = secretary.cleanup;
});

afterAll(async () => {
  await doctorCleanup();
  await secretaryCleanup();
  await prisma.$disconnect();
});

describe('hash chain integrity', () => {
  it('verifies a clean chain of 5 entries', async () => {
    await clearAuditLog();
    for (let i = 0; i < 5; i++) {
      await writeAudit(sampleEntry({ metadata: { i } }));
    }
    const result = await verifyChain();
    expect(result.ok).toBe(true);
    expect(result.total).toBe(5);
    expect(result.breakages).toEqual([]);
  });

  it('chains each entry: previousHash = prior entryHash', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ metadata: { n: 1 } }));
    await writeAudit(sampleEntry({ metadata: { n: 2 } }));
    await writeAudit(sampleEntry({ metadata: { n: 3 } }));
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(rows[0].previousHash).toBe('');
    expect(rows[1].previousHash).toBe(rows[0].entryHash);
    expect(rows[2].previousHash).toBe(rows[1].entryHash);
  });

  it('detects tampering with a middle row', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ metadata: { n: 1 } }));
    await writeAudit(sampleEntry({ metadata: { n: 2 } }));
    await writeAudit(sampleEntry({ metadata: { n: 3 } }));

    // Simulate out-of-band tampering: temporarily disable the trigger so we
    // can UPDATE a row the way an attacker with raw DB access might.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_block_update',
    );
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
    });
    await prisma.auditLog.update({
      where: { id: rows[1].id },
      data: { action: 'HACKED' },
    });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_block_update',
    );

    const result = await verifyChain();
    expect(result.ok).toBe(false);
    expect(result.breakages.length).toBeGreaterThan(0);
    expect(result.breakages[0].id).toBe(rows[1].id);
    expect(result.breakages[0].reason).toBe('wrong_entry_hash');
  });
});

describe('append-only triggers (DB-level enforcement)', () => {
  it('blocks UPDATE on AuditLog', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ action: 'IMMUTABLE_TEST' }));
    const entry = await prisma.auditLog.findFirstOrThrow();
    await expect(
      prisma.auditLog.update({
        where: { id: entry.id },
        data: { action: 'TAMPERED' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('blocks DELETE on AuditLog', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ action: 'IMMUTABLE_TEST' }));
    const entry = await prisma.auditLog.findFirstOrThrow();
    await expect(
      prisma.auditLog.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('middleware auto-logging', () => {
  it('logs an HTTP_REQUEST entry after a successful route call', async () => {
    await clearAuditLog();
    const res = await doctorAgent.get('/api/clinics');
    expect(res.status).toBe(200);
    await flushAudit();
    const entries = await prisma.auditLog.findMany({
      where: { path: '/api/clinics', action: AuditActions.HTTP_REQUEST },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].statusCode).toBe(200);
    expect(entries[0].method).toBe('GET');
    expect(entries[0].userRole).toBe('DOCTOR');
  });

  it('does not log the /health endpoint', async () => {
    await clearAuditLog();
    await supertest(app).get('/health').expect(200);
    await flushAudit();
    const entries = await prisma.auditLog.findMany({
      where: { path: '/health' },
    });
    expect(entries).toEqual([]);
  });

  it('does not log /api/audit itself (prevents recursion)', async () => {
    await clearAuditLog();
    await doctorAgent.get('/api/audit').expect(200);
    await flushAudit();
    const entries = await prisma.auditLog.findMany({
      where: { path: '/api/audit' },
    });
    expect(entries).toEqual([]);
  });
});

describe('GET /api/audit (list)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await supertest(app).get('/api/audit');
    expect(res.status).toBe(401);
  });

  it('rejects a Secretary with 403', async () => {
    const res = await secretaryAgent.get('/api/audit');
    expect(res.status).toBe(403);
  });

  it('returns entries for the Doctor, newest first', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ action: 'OLDER_EVENT' }));
    // Nudge the clock forward enough that createdAt orders deterministically.
    await new Promise((r) => setTimeout(r, 10));
    await writeAudit(sampleEntry({ action: 'NEWER_EVENT' }));

    const res = await doctorAgent.get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    expect(res.body.items[0].action).toBe('NEWER_EVENT');
  });

  it('filters by action', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ action: 'FILTER_ME' }));
    await writeAudit(sampleEntry({ action: 'NOT_ME' }));

    const res = await doctorAgent.get('/api/audit?action=FILTER_ME');
    expect(res.status).toBe(200);
    expect(res.body.items.every((e: { action: string }) => e.action === 'FILTER_ME')).toBe(true);
  });
});

describe('GET /api/audit/verify', () => {
  it('returns ok=true on a clean chain', async () => {
    await clearAuditLog();
    await writeAudit(sampleEntry({ action: 'VERIFY_TEST' }));
    const res = await doctorAgent.get('/api/audit/verify');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.breakages).toEqual([]);
  });

  it('rejects a Secretary with 403', async () => {
    const res = await secretaryAgent.get('/api/audit/verify');
    expect(res.status).toBe(403);
  });
});