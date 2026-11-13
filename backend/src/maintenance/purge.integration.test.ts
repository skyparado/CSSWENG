import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.js';
import { verifyChain, writeAudit } from '../audit/audit.service.js';
import { computeEntryHash } from '../audit/hashChain.js';
import { purgeAuditLog } from './purge.js';

/**
 * Integration test (real Postgres) for the audit retention purge (SDD 7.3).
 * It empties the AuditLog table first (TRUNCATE is not blocked by the
 * append-only row triggers), so it is meant for the test database only.
 */
const YEARS = 365.25 * 86_400_000;

/** Insert an entry with an explicit age, chained onto `previousHash`, the way writeAudit would have. */
async function insertAged(ageYears: number, previousHash: string, tag: string) {
  const createdAt = new Date(Date.now() - ageYears * YEARS);
  const entry = {
    userId: null, userEmail: null, userRole: 'SYSTEM', action: 'LOGIN_SUCCESS', resourceType: null,
    resourceId: tag, method: null, path: null, statusCode: null, ipAddress: null, userAgent: null, metadata: { tag },
  };
  const entryHash = computeEntryHash({ ...entry, createdAt }, previousHash);
  await prisma.auditLog.create({ data: { ...entry, createdAt, previousHash, entryHash } });
  return entryHash;
}

let oldestHash = '';

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE "AuditLog"`;
  // Three entries well past five years, then two recent ones through the normal writer.
  let h = '';
  h = await insertAged(6.5, h, 'old-1');
  h = await insertAged(6.2, h, 'old-2');
  oldestHash = await insertAged(5.4, h, 'old-3');
  await writeAudit({
    userId: null, userEmail: null, userRole: 'SYSTEM', action: 'LOGIN_SUCCESS', resourceType: null,
    resourceId: 'recent-1', method: null, path: null, statusCode: null, ipAddress: null, userAgent: null, metadata: null,
  });
  await writeAudit({
    userId: null, userEmail: null, userRole: 'SYSTEM', action: 'LOGIN_SUCCESS', resourceType: null,
    resourceId: 'recent-2', method: null, path: null, statusCode: null, ipAddress: null, userAgent: null, metadata: null,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('audit retention (real database)', () => {
  it('starts as a valid chain', async () => {
    expect(await verifyChain()).toMatchObject({ ok: true, total: 5 });
  });

  it('refuses to delete any entry through ordinary SQL, old or new', async () => {
    await expect(prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = 'old-1'`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = 'recent-1'`).rejects.toThrow(/append-only/);
  });

  it('refuses to UPDATE an entry even with the purge switch on', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_retention_purge', 'on', true)`;
        await tx.$executeRaw`UPDATE "AuditLog" SET "action" = 'X' WHERE "resourceId" = 'old-1'`;
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to delete a RECENT entry even with the purge switch on', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_retention_purge', 'on', true)`;
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = 'recent-1'`;
      }),
    ).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { resourceId: 'recent-1' } })).toBe(1);
  });

  it('purges only entries past five years, records the purge, and keeps the chain verifiable', async () => {
    const result = await purgeAuditLog();

    expect(result.deleted).toBe(3);
    expect(await prisma.auditLog.count({ where: { resourceId: { startsWith: 'old-' } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { resourceId: { startsWith: 'recent-' } } })).toBe(2);

    const purge = await prisma.auditLog.findFirstOrThrow({ where: { action: 'RETENTION_PURGE' } });
    expect(purge.metadata).toMatchObject({ target: 'audit', count: 3, lastPurgedEntryHash: oldestHash });

    // The oldest surviving entry now points at a deleted one; the recorded anchor makes that acceptable.
    const first = await prisma.auditLog.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    expect(first.previousHash).toBe(oldestHash);
    expect(await verifyChain()).toMatchObject({ ok: true, total: 3 });
  });

  it('still detects tampering after a purge: an entry pointing at an unrecorded hash is a break', async () => {
    // Drop the purge record's protection by pointing the chain somewhere nobody recorded.
    await prisma.$executeRaw`TRUNCATE TABLE "AuditLog"`;
    await insertAged(0.01, 'f'.repeat(64), 'orphan');
    const result = await verifyChain();
    expect(result.ok).toBe(false);
    expect(result.breakages[0]?.reason).toBe('wrong_previous_hash');
  });

  it('does nothing when there is nothing past retention', async () => {
    await prisma.$executeRaw`TRUNCATE TABLE "AuditLog"`;
    await writeAudit({
      userId: null, userEmail: null, userRole: 'SYSTEM', action: 'LOGIN_SUCCESS', resourceType: null,
      resourceId: 'fresh', method: null, path: null, statusCode: null, ipAddress: null, userAgent: null, metadata: null,
    });
    expect(await purgeAuditLog()).toEqual({ deleted: 0, purgedThrough: null });
    expect(await prisma.auditLog.count({ where: { action: 'RETENTION_PURGE' } })).toBe(0);
  });
});
