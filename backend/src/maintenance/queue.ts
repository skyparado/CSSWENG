import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../env.js';
import { AuditActions } from '../audit/actions.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/record.js';
import { bullConnection } from '../reminders/queue.js';
import { evaluateRoutineRecalls } from '../followups/recall.js';
import { prisma } from '../prisma.js';
import { runAuditBackup, runBackup } from './backup.js';
import { runRetentionPurge } from './purge.js';

export const MAINTENANCE_QUEUE = 'maintenance';
export const BACKUP_JOB = 'database-backup';
export const AUDIT_BACKUP_JOB = 'audit-backup';
export const RECALL_JOB = 'routine-recalls';
export const PURGE_JOB = 'retention-purge';

let queue: Queue | undefined;

export function getMaintenanceQueue(): Queue {
  queue ??= new Queue(MAINTENANCE_QUEUE, { connection: bullConnection() });
  return queue;
}

/**
 * Register the repeating jobs. Idempotent: the same scheduler id replaces
 * itself, so restarting the server never doubles the schedule.
 */
export async function scheduleMaintenance(): Promise<void> {
  const q = getMaintenanceQueue();
  const retry = { attempts: 3, backoff: { type: 'exponential', delay: 5 * 60_000 }, removeOnComplete: { count: 30 }, removeOnFail: { count: 60 } };
  for (const name of [AUDIT_BACKUP_JOB, RECALL_JOB]) {
    await q.upsertJobScheduler(`daily-${name}`, { pattern: env.BACKUP_CRON, tz: env.CLINIC_TIMEZONE }, { name, opts: retry });
  }
  await q.upsertJobScheduler(
    'daily-database-backup',
    { pattern: env.BACKUP_CRON, tz: env.CLINIC_TIMEZONE },
    { name: BACKUP_JOB, opts: retry },
  );
  await q.upsertJobScheduler(
    'daily-retention-purge',
    { pattern: env.PURGE_CRON, tz: env.CLINIC_TIMEZONE },
    { name: PURGE_JOB, opts: retry },
  );
}

/** Run one maintenance job and write its outcome to the audit trail. Exported for tests. */
export async function handleMaintenanceJob(job: Pick<Job, 'name'>) {
  if (job.name === RECALL_JOB) return evaluateRoutineRecalls();
  if (job.name === BACKUP_JOB || job.name === AUDIT_BACKUP_JOB) {
    try {
      const result = job.name === AUDIT_BACKUP_JOB ? await runAuditBackup() : await runBackup();
      await recordAudit(SYSTEM_ACTOR, {
        action: AuditActions.BACKUP_COMPLETED,
        resourceType: 'Backup',
        resourceId: result.databaseKey,
        metadata: { ...result, job: job.name },
      });
      return result;
    } catch (err) {
      await recordAudit(SYSTEM_ACTOR, {
        action: AuditActions.BACKUP_FAILED,
        resourceType: 'Backup',
        resourceId: job.name,
      }).catch(() => undefined);
      throw err; // BullMQ retries with backoff
    }
  }
  if (job.name === PURGE_JOB) return runRetentionPurge();
  throw new Error(`Unknown maintenance job: ${job.name}`);
}

let worker: Worker | undefined;

export async function startMaintenanceWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(MAINTENANCE_QUEUE, (job) => handleMaintenanceJob(job), {
    connection: bullConnection(),
    concurrency: 1, // one backup or purge at a time
  });
  worker.on('failed', (job) => {
    // eslint-disable-next-line no-console
    console.error(`[maintenance] ${job?.name ?? 'job'} failed (attempt ${job?.attemptsMade ?? '?'}).`);
  });
  await scheduleMaintenance();
  // Repeatable jobs do not backfill a period when Redis or the worker was down.
  for (const name of [BACKUP_JOB, AUDIT_BACKUP_JOB]) {
    const recent = await prisma.auditLog.findFirst({ where: { action: AuditActions.BACKUP_COMPLETED,
      createdAt: { gte: new Date(Date.now() - 86400000) }, metadata: { path: ['job'], equals: name } }, select: { id: true } });
    if (!recent) await getMaintenanceQueue().add(name, {}, { jobId: `catchup-${name}-${Date.now().toString().slice(0, -5)}`,
      attempts: 3, backoff: { type: 'exponential', delay: 60000 }, removeOnComplete: true });
  }
}

export async function stopMaintenanceWorker(): Promise<void> {
  await worker?.close();
  worker = undefined;
  await queue?.close();
  queue = undefined;
}
