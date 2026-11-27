import { Queue, Worker, type Job } from 'bullmq';
import { bullConnection } from '../reminders/queue.js';
import { prisma } from '../prisma.js';
import { processExport } from './exports.service.js';

export const EXPORT_QUEUE = 'report-exports';
export const EXPORT_JOB = 'render-report-export';

export interface ExportJobData {
  exportId: string;
}

let queue: Queue | undefined;

/** Created on first use so importing this module never connects to Redis. */
export function getExportQueue(): Queue {
  queue ??= new Queue(EXPORT_QUEUE, { connection: { ...bullConnection(), maxRetriesPerRequest: 1 } });
  return queue;
}

/** Queue the rendering of one export. The job id is the export id, so it cannot be queued twice. */
export async function enqueueExport(exportId: string): Promise<void> {
  await getExportQueue().add(
    EXPORT_JOB,
    { exportId } satisfies ExportJobData,
    {
      jobId: `export-${exportId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
}

/** Route a job to its handler; exported so it can be tested without Redis. */
export async function handleExportJob(job: Pick<Job, 'name' | 'data'> & Partial<Pick<Job, 'attemptsMade' | 'opts'>>) {
  if (job.name !== EXPORT_JOB) throw new Error(`Unknown export job: ${job.name}`);
  return processExport((job.data as ExportJobData).exportId, undefined, (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1));
}

let worker: Worker | undefined;
let recoveryTimer: ReturnType<typeof setInterval> | undefined;

async function recoverExports() {
  const pending = await prisma.reportExport.findMany({ where: { status: { in: ['QUEUED', 'RETRYING', 'RUNNING'] } }, select: { id: true } });
  for (const row of pending) {
    const previous = await getExportQueue().getJob(`export-${row.id}`);
    if (!previous) await enqueueExport(row.id);
    else if (await previous.getState() === 'failed') {
      // BullMQ can exhaust a stalled job without calling the processor again.
      await prisma.reportExport.updateMany({ where: { id: row.id, status: { in: ['QUEUED', 'RUNNING', 'RETRYING'] } },
        data: { status: 'FAILED', error: 'Export could not be prepared', completedAt: new Date() } });
    }
  }
}

export async function startExportWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(EXPORT_QUEUE, (job) => handleExportJob(job), {
    connection: bullConnection(),
    concurrency: 2,
  });
  await getExportQueue().waitUntilReady();
  await recoverExports();
  recoveryTimer = setInterval(() => { void recoverExports().catch(() => console.error('[exports] queue recovery will retry')); }, 60000);
  recoveryTimer.unref();
  worker.on('failed', (job) => {
    // eslint-disable-next-line no-console
    console.error(`[exports] job ${job?.id ?? ''} failed (attempt ${job?.attemptsMade ?? '?'}).`);
  });
}

export async function stopExportWorker(): Promise<void> {
  clearInterval(recoveryTimer);
  await worker?.close();
  worker = undefined;
  await queue?.close();
  queue = undefined;
}
