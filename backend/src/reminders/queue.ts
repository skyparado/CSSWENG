import { Queue, type JobsOptions } from 'bullmq';
import { logOutreachAttempt } from '../followups/outreach.service.js';
import { conflict } from '../http.js';
import { SYSTEM_ACTOR, auditPatientChange, type AuditActor } from '../audit/record.js';
import { prisma } from '../prisma.js';
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
export function bullConnection() {
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
 * Manual requests and scans share a durable job id within each contact cycle.
 * A confirmed failure or cancellation allows another attempt.
 */
export async function enqueueReminder(data: ReminderJobData, actor: AuditActor = SYSTEM_ACTOR): Promise<string | undefined> {
  // Persist the intent and its audit event before contacting Redis. On startup a worker can requeue this same id.
  const intent = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FollowUp" WHERE id = ${data.followUpId} FOR UPDATE`;
    const task = await tx.followUp.findUniqueOrThrow({ where: { id: data.followUpId } });
    if (task.status !== 'OPEN') throw conflict('Reminders require an open follow-up');
    const consent = await tx.patientConsent.findFirst({ where: { patientId: task.patientId, channel: data.channel, consentType: 'REMINDER' },
      orderBy: [{ consentedAt: 'desc' }, { id: 'desc' }] });
    if (!consent?.isGranted || consent.withdrawnAt) throw conflict('Active reminder consent is required');
    const scope = { followUpId: task.id, channel: data.channel, cycle: task.reminderCycle };
    const existing = await tx.reminderDelivery.findFirst({ where: { ...scope, status: { in: ['SENT', 'PENDING', 'DISPATCHING', 'UNCERTAIN'] },
      OR: [{ deliveryStatus: null }, { deliveryStatus: 'DELIVERED' }] } });
    if (existing) {
      if (existing.status === 'PENDING') return existing;
      throw conflict(existing.status === 'SENT' ? 'A reminder was already sent' : 'Delivery is awaiting provider confirmation');
    }
    const previous = await tx.reminderDelivery.count({ where: scope });
    const row = await tx.reminderDelivery.create({ data: { ...scope, consentId: consent.id,
      idempotencyKey: `reminder-${task.id}-${data.channel}-${scope.cycle}-${previous}` } });
    await auditPatientChange(tx, actor, 'REMINDER_REQUESTED', 'ReminderDelivery',
      { ...task, id: row.id }, { followUpId: task.id, channel: data.channel });
    return row;
  });
  return queueIntent(intent);
}

async function queueIntent(intent: { followUpId: string; channel: ReminderJobData['channel']; cycle: number; idempotencyKey: string }) {
  const job = await getReminderQueue().add(SEND_JOB, { followUpId: intent.followUpId, channel: intent.channel, cycle: intent.cycle },
    { ...sendJobOptions(), jobId: intent.idempotencyKey });
  return job.id;
}

export async function recoverPendingReminders() {
  const pending = await prisma.reminderDelivery.findMany({ where: { status: 'PENDING' } });
  for (const row of pending) {
    const previous = await getReminderQueue().getJob(row.idempotencyKey);
    if (!previous) await queueIntent(row);
    else if (await previous.getState() === 'failed') await previous.retry('failed');
  }
  // Redis may have been lost after the provider acceptance was saved but before its contact log committed.
  const missing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id FROM "ReminderDelivery" d WHERE d.status = 'SENT' AND d."providerMessageId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "OutreachLog" o WHERE o."followUpId" = d."followUpId"
      AND o."providerMessageId" = d."providerMessageId")`;
  for (const { id } of missing) {
    const row = await prisma.reminderDelivery.findUnique({ where: { id }, include: { followUp: true } });
    if (row?.consentId && row.providerMessageId) {
      await logOutreachAttempt({ followUp: row.followUp, channel: row.channel, consentId: row.consentId,
        outcome: 'SENT', providerMessageId: row.providerMessageId, deliveryStatus: row.deliveryStatus ?? undefined,
        attemptedAt: row.sentAt ?? row.createdAt });
    }
  }
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
