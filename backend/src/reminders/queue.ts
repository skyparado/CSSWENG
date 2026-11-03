import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { env } from '../env.js';
import type { ReminderJobData } from './reminders.service.js';

export const REMINDER_QUEUE = 'follow-up-reminders';
export const SCAN_JOB = 'scan-due-follow-ups';
export const SEND_JOB = 'send-reminder';

/**
 * BullMQ connection options parsed from REDIS_URL. BullMQ workers need
 * `maxRetriesPerRequest: null`, which the shared client in redis.ts does not
 * use, so the queue gets its own connections.
 */
export function bullConnection(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Retry policy for sending: exponential backoff between attempts. */
export function sendJobOptions(): JobsOptions {
  return {
    attempts: env.REMINDER_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.REMINDER_JOB_BACKOFF_MS },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

let queue: Queue | undefined;

/** The reminder queue, created on first use so importing this module never connects to Redis. */
export function getReminderQueue(): Queue {
  queue ??= new Queue(REMINDER_QUEUE, { connection: bullConnection() });
  return queue;
}

/**
 * Queue one reminder. `dedupe` makes the job id stable per task and channel so
 * the daily scan cannot queue the same reminder twice while one is pending.
 */
export async function enqueueReminder(
  data: ReminderJobData,
  opts: { dedupe?: boolean } = {},
): Promise<string | undefined> {
  const job = await getReminderQueue().add(SEND_JOB, data, {
    ...sendJobOptions(),
    jobId: opts.dedupe ? `reminder-${data.followUpId}-${data.channel}` : undefined,
  });
  return job.id;
}

/** Register the repeatable daily scan (idempotent: same scheduler id replaces itself). */
export async function scheduleDailyScan(): Promise<void> {
  await getReminderQueue().upsertJobScheduler(
    'daily-reminder-scan',
    { pattern: env.REMINDER_SCAN_CRON, tz: env.CLINIC_TIMEZONE },
    { name: SCAN_JOB, opts: { removeOnComplete: true, removeOnFail: { count: 50 } } },
  );
}

export async function closeReminderQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
