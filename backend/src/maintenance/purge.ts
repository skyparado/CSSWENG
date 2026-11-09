import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { AuditActions } from '../audit/actions.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/record.js';
import { deleteObject } from '../storage/s3.js';
import { purgeOldBackups } from './backup.js';

const BATCH = 5_000;

/** The instant `years` before `now` (calendar years, so leap days are not drifted over). */
export function yearsAgo(now: Date, years: number): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

export interface AuditPurgeResult {
  deleted: number;
  /** createdAt of the newest entry removed. */
  purgedThrough: Date | null;
}

/**
 * Remove audit entries past retention (SDD 7.3: at least five years), oldest
 * first, in one transaction together with the audit entry that records the purge.
 *
 * The database only allows this DELETE when the transaction sets
 * `app.audit_retention_purge`, and only for rows more than five years old, so
 * nothing recent can be removed even by this job. The purge entry stores the
 * hash of the last entry removed; verifyChain accepts the oldest surviving entry
 * pointing at exactly that hash, so the chain stays verifiable and a purge
 * cannot be used to hide tampering.
 */
export async function purgeAuditLog(now: Date = new Date()): Promise<AuditPurgeResult> {
  const cutoff = yearsAgo(now, env.AUDIT_RETENTION_YEARS);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_retention_purge', 'on', true)`;

      let deleted = 0;
      let last: { entryHash: string; createdAt: Date } | null = null;
      for (;;) {
        const batch = await tx.auditLog.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
          select: { id: true, entryHash: true, createdAt: true },
        });
        if (batch.length === 0) break;
        await tx.auditLog.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } });
        deleted += batch.length;
        last = batch[batch.length - 1] ?? last;
      }
      if (deleted === 0 || !last) return { deleted: 0, purgedThrough: null };

      await recordAudit(
        SYSTEM_ACTOR,
        {
          action: AuditActions.RETENTION_PURGE,
          resourceType: 'AuditLog',
          resourceId: 'retention',
          metadata: {
            target: 'audit',
            count: deleted,
            purgedThrough: last.createdAt.toISOString(),
            lastPurgedEntryHash: last.entryHash,
            retentionYears: env.AUDIT_RETENTION_YEARS,
          },
        },
        tx,
      );
      return { deleted, purgedThrough: last.createdAt };
    },
    { timeout: 120_000 },
  );
}

/** Remove report export files past REPORT_EXPORT_RETENTION_DAYS and mark them EXPIRED. */
export async function purgeExpiredExports(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.REPORT_EXPORT_RETENTION_DAYS * 86_400_000);
  const old = await prisma.reportExport.findMany({
    where: { createdAt: { lt: cutoff }, status: { in: ['READY', 'FAILED', 'QUEUED'] } },
    select: { id: true, objectKey: true },
  });
  for (const e of old) {
    if (e.objectKey) await deleteObject(e.objectKey);
    await prisma.reportExport.update({ where: { id: e.id }, data: { status: 'EXPIRED', objectKey: null } });
  }
  if (old.length > 0) {
    await recordAudit(SYSTEM_ACTOR, {
      action: AuditActions.RETENTION_PURGE,
      resourceType: 'ReportExport',
      resourceId: 'retention',
      metadata: { target: 'exports', count: old.length, retentionDays: env.REPORT_EXPORT_RETENTION_DAYS },
    });
  }
  return old.length;
}

export interface PurgeSummary {
  auditEntries: number;
  exports: number;
  backups: number;
}

/**
 * Everything the nightly purge does. Each step is independent: a failure in one
 * (say the backup store is unreachable) does not stop the others, but is
 * reported so the job is marked failed and retried.
 */
export async function runRetentionPurge(now: Date = new Date()): Promise<PurgeSummary> {
  const errors: string[] = [];
  const summary: PurgeSummary = { auditEntries: 0, exports: 0, backups: 0 };

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await step('audit log', async () => {
    summary.auditEntries = (await purgeAuditLog(now)).deleted;
  });
  await step('report exports', async () => {
    summary.exports = await purgeExpiredExports(now);
  });
  await step('backups', async () => {
    const removed = await purgeOldBackups(undefined, now);
    summary.backups = removed.length;
    if (removed.length > 0) {
      await recordAudit(SYSTEM_ACTOR, {
        action: AuditActions.RETENTION_PURGE,
        resourceType: 'Backup',
        resourceId: 'retention',
        metadata: { target: 'backups', count: removed.length, retentionDays: env.BACKUP_RETENTION_DAYS },
      });
    }
  });

  if (errors.length > 0) throw new Error(`Retention purge incomplete (${errors.join('; ')})`);
  return summary;
}
