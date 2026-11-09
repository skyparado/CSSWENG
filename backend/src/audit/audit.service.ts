import { prisma } from '../prisma.js';
import { computeEntryHash, type HashableEntry } from './hashChain.js';

/**
 * Everything a caller supplies when writing an audit entry. createdAt,
 * previousHash and entryHash are computed inside writeAudit.
 */
export type AuditInput = Omit<HashableEntry, 'createdAt'>;

/**
 * Advisory lock key used to serialise writes against the chain. Any constant
 * will do; it is a per-session Postgres advisory lock, not a row lock.
 */
const WRITE_LOCK_KEY = 723842137;

/** A transaction client, so an audit row can commit or roll back with the change it records. */
export type AuditTx = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Append a row to the audit log, computing previousHash and entryHash under a
 * transactional advisory lock so concurrent writers chain in a serial order.
 *
 * Pass `tx` to write inside the caller's transaction: the audit row then
 * commits or rolls back together with the business change it describes.
 */
export async function writeAudit(input: AuditInput, tx?: AuditTx) {
  const run = async (db: AuditTx) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${WRITE_LOCK_KEY})`;

    const latest = await db.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { entryHash: true },
    });
    const previousHash = latest?.entryHash ?? '';
    const createdAt = new Date();

    const entryHash = computeEntryHash({ ...input, createdAt }, previousHash);

    return db.auditLog.create({
      data: {
        ...input,
        metadata: (input.metadata ?? null) as any,
        createdAt,
        previousHash,
        entryHash,
      },
    });
  };

  if (tx) return run(tx);
  return prisma.$transaction(run, { timeout: 15000 });
}

/**
 * Walk the chain from oldest to newest and confirm every entry's previousHash
 * matches the prior row's entryHash and every entry's entryHash matches the
 * recomputed hash. Returns details of any breakages found.
 */
export type ChainBreakage = {
  id: string;
  createdAt: Date;
  reason: 'wrong_previous_hash' | 'wrong_entry_hash';
};

export async function verifyChain(): Promise<{
  ok: boolean;
  total: number;
  breakages: ChainBreakage[];
}> {
  const entries = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'asc' },
  });

  // After a retention purge (maintenance/purge.ts) the oldest surviving entry
  // points at a deleted one. The purge records the last deleted entry's hash in
  // its own audit entry, so the chain is accepted from that anchor, and only
  // if the anchor really is on record: an arbitrary previousHash is still a break.
  let previousHash = '';
  const first = entries[0];
  if (first && first.previousHash !== '') {
    const anchors = new Set(
      entries
        .filter((e) => e.action === 'RETENTION_PURGE')
        .map((e) => e.metadata as { target?: string; lastPurgedEntryHash?: string } | null)
        .filter((m) => m?.target === 'audit' && typeof m.lastPurgedEntryHash === 'string')
        .map((m) => m?.lastPurgedEntryHash as string),
    );
    if (anchors.has(first.previousHash)) previousHash = first.previousHash;
  }
  const breakages: ChainBreakage[] = [];

  for (const entry of entries) {
    if (entry.previousHash !== previousHash) {
      breakages.push({
        id: entry.id,
        createdAt: entry.createdAt,
        reason: 'wrong_previous_hash',
      });
    }
    const expected = computeEntryHash(
      {
        userId: entry.userId,
        userEmail: entry.userEmail,
        userRole: entry.userRole,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      },
      previousHash,
    );
    if (entry.entryHash !== expected) {
      breakages.push({
        id: entry.id,
        createdAt: entry.createdAt,
        reason: 'wrong_entry_hash',
      });
    }
    // The chain continues from the row's stored entryHash, not the recomputed
    // one — so later rows aren't double-counted as broken just because an
    // earlier row was tampered with.
    previousHash = entry.entryHash;
  }

  return { ok: breakages.length === 0, total: entries.length, breakages };
}

/* ----------------------------- Query helpers ------------------------------ */

export type AuditListQuery = {
  page: number;
  pageSize: number;
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
};

export async function listAudit(query: AuditListQuery) {
  const { page, pageSize, userId, action, resourceType, resourceId, from, to } = query;
  const where = {
    ...(userId ? { userId } : {}),
    ...(action ? { action } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page, pageSize };
}