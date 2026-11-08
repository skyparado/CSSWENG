import { Prisma, type ReminderChannel, type ReminderDelivery } from '@prisma/client';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { findActiveReminderConsent } from '../consents/consents.service.js';
import { addDays, todayInTimezone, toDateOnly } from '../followups/dates.js';
import { logOutreachAttempt } from '../followups/outreach.service.js';
import type { Gateways } from './gateway.js';

export interface ReminderJobData {
  followUpId: string;
  channel: ReminderChannel;
}

export type ReminderResult =
  | {
      status: 'sent';
      outreachId: string;
      /** True when the message had already gone out on an earlier attempt and only the log was missing. */
      recovered?: boolean;
    }
  | {
      status: 'skipped';
      reason: 'FOLLOW_UP_NOT_FOUND' | 'NOT_OPEN' | 'NO_CONSENT' | 'NO_CONTACT';
    };

/**
 * Reminder text. SMS and email are not a secure channel (RA 10173), so the
 * message says only who is calling and that a visit is due. It never names the
 * kind of task (injection, laboratory test, procedure...) or the clinical
 * reason, and it never reads anything from the task beyond the due date.
 */
export function buildReminderMessage(input: {
  clinicName: string;
  dueDate: Date;
  clinicPhone?: string | null;
}): { subject: string; body: string } {
  const due = input.dueDate.toISOString().slice(0, 10);
  const contact = input.clinicPhone ? ` Call ${input.clinicPhone} to book.` : ' Please contact the clinic to book.';
  return {
    subject: `Reminder from ${input.clinicName}`,
    body: `${input.clinicName}: you have a visit due on ${due}.${contact}`,
  };
}

/** The key that makes a send idempotent: stable across every retry of one job. */
export function idempotencyKeyFor(job: ReminderJobData, jobKey?: string): string {
  return jobKey ?? `${job.followUpId}:${job.channel}`;
}

/**
 * Send one reminder. Runs inside the BullMQ worker.
 *
 * Sends only when the follow-up is still open and the patient holds active
 * reminder consent for the channel, checked again right before the provider is
 * called. A skipped reminder writes no outreach row (an SMS/email row cannot
 * exist without consent).
 *
 * No duplicate sends: every job has a ReminderDelivery row, written BEFORE the
 * provider is called and updated with the provider's message id right after.
 *  - If the provider accepted the message but a later database write failed,
 *    the retry finds the SENT row, does not send again, and just finishes the
 *    outreach log.
 *  - The same key goes to the provider as its idempotency key, which covers the
 *    one window we cannot close ourselves: the provider accepted the message
 *    but we crashed before saving the SENT row.
 *
 * Gateway errors are rethrown so BullMQ retries; on the final attempt a FAILED
 * outreach row is written first so the failure counts toward marking the
 * patient unreachable.
 */
export async function processReminder(
  job: ReminderJobData,
  gateways: Gateways,
  opts: { isFinalAttempt: boolean; jobKey?: string },
): Promise<ReminderResult> {
  const followUp = await prisma.followUp.findUnique({
    where: { id: job.followUpId },
    include: { patient: true, clinic: true },
  });
  if (!followUp) return { status: 'skipped', reason: 'FOLLOW_UP_NOT_FOUND' };

  const key = idempotencyKeyFor(job, opts.jobKey);
  const existing = await prisma.reminderDelivery.findUnique({ where: { idempotencyKey: key } });

  // Already sent on an earlier attempt: never send again, only finish the log.
  // This runs before the open/consent checks on purpose, because the message is
  // out and the record of it must exist whatever has changed since.
  if (existing?.status === 'SENT') return finishLogging(existing, followUp);

  if (followUp.status !== 'OPEN') {
    await cancelDelivery(existing);
    return { status: 'skipped', reason: 'NOT_OPEN' };
  }

  const consent = await findActiveReminderConsent(followUp.patientId, job.channel);
  if (!consent) {
    await cancelDelivery(existing);
    return { status: 'skipped', reason: 'NO_CONSENT' };
  }

  const to = job.channel === 'SMS' ? followUp.patient.mobileNumber : followUp.patient.email;
  if (!to) return { status: 'skipped', reason: 'NO_CONTACT' };

  const delivery = await claimDelivery(existing, {
    idempotencyKey: key,
    followUpId: followUp.id,
    channel: job.channel,
    consentId: consent.id,
  });

  // Consent can be withdrawn while the job waited or between the check above
  // and now. Look once more immediately before anything leaves the building.
  const stillConsented = await findActiveReminderConsent(followUp.patientId, job.channel);
  if (!stillConsented) {
    await cancelDelivery(delivery);
    return { status: 'skipped', reason: 'NO_CONSENT' };
  }

  const message = buildReminderMessage({
    clinicName: followUp.clinic.name,
    dueDate: followUp.dueDate,
    clinicPhone: followUp.clinic.phone,
  });

  let sent;
  try {
    sent =
      job.channel === 'SMS'
        ? await gateways.sms.send({ to, body: message.body, idempotencyKey: key })
        : await gateways.email.send({
            to,
            subject: message.subject,
            body: message.body,
            idempotencyKey: key,
          });
  } catch (err) {
    if (opts.isFinalAttempt) {
      await prisma.reminderDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', deliveryStatus: 'FAILED' },
      });
      await logOutreachAttempt({
        followUp,
        channel: job.channel,
        consentId: consent.id,
        outcome: 'FAILED',
        deliveryStatus: 'FAILED',
      });
    }
    throw err;
  }

  // The provider accepted it. Record that FIRST and on its own, so that if the
  // outreach log below fails the retry knows not to send again.
  const sentRow = await prisma.reminderDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'SENT',
      providerMessageId: sent.providerMessageId,
      deliveryStatus: sent.deliveryStatus,
      sentAt: new Date(),
    },
  });

  return finishLogging(sentRow, followUp);
}

/** Make sure the outreach log has a row for a message that was sent; never writes a second one. */
async function finishLogging(
  delivery: ReminderDelivery,
  followUp: { id: string; patientId: string; clinicId: string },
): Promise<ReminderResult> {
  if (delivery.providerMessageId) {
    const logged = await prisma.outreachLog.findFirst({
      where: { followUpId: followUp.id, providerMessageId: delivery.providerMessageId },
      select: { id: true },
    });
    if (logged) return { status: 'sent', outreachId: logged.id, recovered: true };
  }

  if (!delivery.consentId) {
    // Cannot happen for rows this code wrote; an SMS/email row needs its consent.
    throw new Error(`ReminderDelivery ${delivery.id} has no consent to log the send against`);
  }
  const log = await logOutreachAttempt({
    followUp,
    channel: delivery.channel,
    consentId: delivery.consentId,
    outcome: 'SENT',
    providerMessageId: delivery.providerMessageId ?? undefined,
    deliveryStatus: delivery.deliveryStatus ?? undefined,
  });
  return { status: 'sent', outreachId: log.id };
}

/** Reuse a retry's delivery row, or create it. Two workers racing on one key end up with one row. */
async function claimDelivery(
  existing: ReminderDelivery | null,
  data: { idempotencyKey: string; followUpId: string; channel: ReminderChannel; consentId: string },
): Promise<ReminderDelivery> {
  if (existing) {
    if (existing.status === 'PENDING') return existing;
    // A FAILED or CANCELLED row from an earlier run of the same job: try again.
    return prisma.reminderDelivery.update({
      where: { id: existing.id },
      data: { status: 'PENDING', consentId: data.consentId, deliveryStatus: null },
    });
  }
  try {
    return await prisma.reminderDelivery.create({ data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.reminderDelivery.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (raced) return raced;
    }
    throw err;
  }
}

/** A reminder that will not go out (consent withdrawn, task closed): record that it was cancelled. */
async function cancelDelivery(delivery: ReminderDelivery | null) {
  if (delivery && delivery.status === 'PENDING') {
    await prisma.reminderDelivery.update({
      where: { id: delivery.id },
      data: { status: 'CANCELLED' },
    });
  }
}

/**
 * Find open follow-ups (due soon or overdue) whose patient has granted reminder
 * consent on a channel and that have not been sent a reminder on it yet.
 * "Sent" is judged by the persistent delivery record as well as the outreach
 * log, so a reminder that went out but whose log write failed is not re-queued.
 */
export async function findFollowUpsNeedingReminder(
  channel: ReminderChannel,
  now: Date = new Date(),
): Promise<string[]> {
  const horizon = addDays(todayInTimezone(env.CLINIC_TIMEZONE, now), env.REMINDER_LEAD_DAYS);
  const rows = await prisma.followUp.findMany({
    where: {
      status: 'OPEN',
      dueDate: { lte: toDateOnly(horizon) },
      patient: {
        consents: {
          some: { consentType: 'REMINDER', channel, isGranted: true, withdrawnAt: null },
        },
      },
      outreachLogs: { none: { channel, outcome: 'SENT' } },
      deliveries: { none: { channel, status: 'SENT' } },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
