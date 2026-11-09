import { Queue, Worker, type Job } from 'bullmq';
import { bullConnection } from '../reminders/queue.js';
import { processExport } from './exports.service.js';

export const EXPORT_QUEUE = 'report-exports';
export const EXPORT_JOB = 'render-report-export';

export interface ExportJobData {
  exportId: string;
}

let queue: Queue | undefined;

/** Created on first use so importing this module never connects to Redis. */
export function getExportQueue(): Queue {
  queue ??= new Queue(EXPORT_QUEUE, { connection: bullConnection() });
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
export async function handleExportJob(job: Pick<Job, 'name' | 'data'>) {
  if (job.name !== EXPORT_JOB) throw new Error(`Unknown export job: ${job.name}`);
  return processExport((job.data as ExportJobData).exportId);
}

let worker: Worker | undefined;

export function startExportWorker(): void {
  if (worker) return;
  worker = new Worker(EXPORT_QUEUE, (job) => handleExportJob(job), {
    connection: bullConnection(),
    concurrency: 2,
  });
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[exports] job ${job?.id ?? ''} failed (attempt ${job?.attemptsMade ?? '?'}):`, err.message);
  });
}

export async function stopExportWorker(): Promise<void> {
  await worker?.close();
  worker = undefined;
  await queue?.close();
  queue = undefined;
}
