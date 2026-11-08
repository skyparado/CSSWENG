import { Worker, type Job } from 'bullmq';
import type { ReminderChannel } from '@prisma/client';
import { createGateways, type Gateways } from './gateway.js';
import {
  REMINDER_QUEUE,
  SCAN_JOB,
  SEND_JOB,
  bullConnection,
  closeReminderQueue,
  enqueueReminder,
  scheduleDailyScan,
} from './queue.js';
import {
  findFollowUpsNeedingReminder,
  processReminder,
  type ReminderJobData,
} from './reminders.service.js';

const CHANNELS: ReminderChannel[] = ['SMS', 'EMAIL'];

/** Queue a reminder job for every follow-up that needs one. */
export async function runScan(): Promise<number> {
  let queued = 0;
  for (const channel of CHANNELS) {
    for (const followUpId of await findFollowUpsNeedingReminder(channel)) {
      await enqueueReminder({ followUpId, channel }, { dedupe: true });
      queued += 1;
    }
  }
  return queued;
}

/** Route a job to its handler. Exported so it can be tested without Redis. */
export async function handleJob(
  job: Pick<Job, 'name' | 'data' | 'attemptsMade' | 'opts'> & { id?: string },
  gateways: Gateways,
) {
  if (job.name === SCAN_JOB) return runScan();
  if (job.name === SEND_JOB) {
    const attempts = job.opts.attempts ?? 1;
    // attemptsMade counts completed attempts; this run is the next one.
    return processReminder(job.data as ReminderJobData, gateways, {
      isFinalAttempt: job.attemptsMade + 1 >= attempts,
      // The job id is the same on every retry, so it is the idempotency key.
      jobKey: job.id,
    });
  }
  throw new Error(`Unknown reminder job: ${job.name}`);
}

let worker: Worker | undefined;

/** Start the reminder worker and the daily scan schedule. */
export async function startReminderWorker(): Promise<void> {
  if (worker) return;
  const gateways = createGateways();

  worker = new Worker(REMINDER_QUEUE, (job) => handleJob(job, gateways), {
    connection: bullConnection(),
    concurrency: 5,
  });
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[reminders] ${job?.name ?? 'job'} ${job?.id ?? ''} failed (attempt ${job?.attemptsMade ?? '?'}):`,
      err.message,
    );
  });
  worker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[reminders] worker error:', err.message);
  });

  await scheduleDailyScan();
}

export async function stopReminderWorker(): Promise<void> {
  await worker?.close();
  worker = undefined;
  await closeReminderQueue();
}
