import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../env.js';
import { AuditActions } from '../audit/actions.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/record.js';
import { bullConnection } from '../reminders/queue.js';
import { runBackup } from './backup.js';
import { runRetentionPurge } from './purge.js';

export const MAINTENANCE_QUEUE = 'maintenance';
export const BACKUP_JOB = 'database-backup';
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
  if (job.name === BACKUP_JOB) {
    try {
      const result = await runBackup();
      await recordAudit(SYSTEM_ACTOR, {
        action: AuditActions.BACKUP_COMPLETED,
        resourceType: 'Backup',
        resourceId: result.databaseKey,
        metadata: { ...result },
      });
      return result;
    } catch (err) {
      await recordAudit(SYSTEM_ACTOR, {
        action: AuditActions.BACKUP_FAILED,
        resourceType: 'Backup',
        resourceId: 'database',
        metadata: { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
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
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[maintenance] ${job?.name ?? 'job'} failed (attempt ${job?.attemptsMade ?? '?'}):`, err.message);
  });
  await scheduleMaintenance();
}

export async function stopMaintenanceWorker(): Promise<void> {
  await worker?.close();
  worker = undefined;
  await queue?.close();
  queue = undefined;
}
