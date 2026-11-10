import type { Prisma, AuditLog } from '@prisma/client';
import { prisma } from '../prisma.js';

/**
 * Audit entries are written fire-and-forget on purpose: a failing audit write
 * must never change the response the caller sees. That means the row is not
 * guaranteed to exist the instant an HTTP call returns, so tests poll for it
 * instead of reading once and hoping.
 *
 * Each write also serialises through a Postgres advisory lock, so under a busy
 * suite a single entry can take a moment to land.
 */
export async function waitForAudit(
  where: Prisma.AuditLogWhereInput,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<AuditLog> {
  const deadline = Date.now() + timeoutMs;
  let last: AuditLog | null = null;

  while (Date.now() < deadline) {
    last = await prisma.auditLog.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    });
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `No audit entry matched ${JSON.stringify(where)} within ${timeoutMs}ms`,
  );
}

/**
 * Wait until at least `expected` entries match, then return all of them.
 * Use this when the point of the test is how many entries were written, not
 * just that one was.
 */
export async function waitForAuditCount(
  where: Prisma.AuditLogWhereInput,
  expected: number,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<AuditLog[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: AuditLog[] = [];

  while (Date.now() < deadline) {
    rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Expected ${expected} audit entries matching ${JSON.stringify(where)}, ` +
      `found ${rows.length} within ${timeoutMs}ms`,
  );
}

/**
 * Give in-flight audit writes a moment to drain. Call this in afterAll before
 * deleting the test user, so a queued write is not still holding the advisory
 * lock while the cleanup tries to run.
 */
export async function drainAuditWrites(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
