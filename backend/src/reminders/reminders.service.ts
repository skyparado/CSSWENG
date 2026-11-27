import type { ReminderChannel, ReminderDelivery } from '@prisma/client';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { findActiveReminderConsent } from '../consents/consents.service.js';
import { addDays, todayInTimezone, toDateOnly } from '../followups/dates.js';
import { logOutreachAttempt } from '../followups/outreach.service.js';
import type { Gateways } from './gateway.js';
import { ProviderError } from './providers.js';
import { auditPatientChange, SYSTEM_ACTOR } from '../audit/record.js';
import { decryptOpt } from '../lib/fieldCrypto.js';

export interface ReminderJobData {
  followUpId: string;
  channel: ReminderChannel;
  cycle?: number;
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
      reason: 'FOLLOW_UP_NOT_FOUND' | 'NOT_OPEN' | 'NO_CONSENT' | 'NO_CONTACT' | 'UNCONFIGURED' | 'AWAITING_CONFIRMATION' | 'ALREADY_FAILED';
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
 * The exclusive transition to DISPATCHING commits before provider I/O. A retry
 * may replay a confirmed rejection. Ambiguous sends await provider evidence.
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

  const gateway = job.channel === 'SMS' ? gateways.sms : gateways.email;
  const key = idempotencyKeyFor(job, opts.jobKey);
  const existing = await prisma.reminderDelivery.findUnique({ where: { idempotencyKey: key } });

  // Already sent on an earlier attempt: never send again, only finish the log.
  // This runs before the open/consent checks on purpose, because the message is
  // out and the record of it must exist whatever has changed since.
  if (existing?.status === 'UNCERTAIN' || existing?.status === 'DISPATCHING') return { status: 'skipped', reason: 'AWAITING_CONFIRMATION' };
  if (existing?.status === 'FAILED') return { status: 'skipped', reason: 'ALREADY_FAILED' };
  if (existing?.status === 'SENT') return finishLogging(existing, followUp);

  if (gateway.unconfigured) {
    await cancelDelivery(existing);
    return { status: 'skipped', reason: 'UNCONFIGURED' };
  }
  if (followUp.status !== 'OPEN' || (job.cycle ?? 0) !== (followUp.reminderCycle ?? 0)) {
    await cancelDelivery(existing);
    return { status: 'skipped', reason: 'NOT_OPEN' };
  }

  const consent = await findActiveReminderConsent(followUp.patientId, job.channel);
  if (!consent) {
    await cancelDelivery(existing);
    return { status: 'skipped', reason: 'NO_CONSENT' };
  }

  // Patient contact details are stored encrypted (patients/patient.mapper.ts).
  const to = decryptOpt(job.channel === 'SMS' ? followUp.patient.mobileNumber : followUp.patient.email);
  if (!to) {
    await cancelDelivery(existing);
    return { status: 'skipped', reason: 'NO_CONTACT' };
  }

  const delivery = await claimDelivery(existing, {
    idempotencyKey: key,
    cycle: followUp.reminderCycle ?? 0,
    followUpId: followUp.id,
    channel: job.channel,
    consentId: consent.id,
  });

  if (!delivery) return { status: 'skipped', reason: 'AWAITING_CONFIRMATION' };

  // Consent can be withdrawn while the job waited or between the check above
  // and now. Look once more immediately before anything leaves the building.
  const stillConsented = await findActiveReminderConsent(followUp.patientId, job.channel);
  if (!stillConsented) {
    await cancelDelivery(delivery);
    return { status: 'skipped', reason: 'NO_CONSENT' };
  }

  const claim = await prisma.reminderDelivery.updateMany({
    where: { id: delivery.id, status: { in: ['PENDING', 'CANCELLED'] }, followUp: { status: 'OPEN', reminderCycle: followUp.reminderCycle } },
    data: { status: 'DISPATCHING', consentId: stillConsented.id },
  });
  if (!claim.count) return { status: 'skipped', reason: 'AWAITING_CONFIRMATION' };

  const message = buildReminderMessage({
    clinicName: followUp.clinic.name,
    dueDate: followUp.dueDate,
    clinicPhone: followUp.clinic.phone,
  });

  let sent;
  try {
    sent =
      job.channel === 'SMS'
        ? await gateways.sms.send({ to, body: message.body, idempotencyKey: key, deliveryId: delivery.id })
        : await gateways.email.send({
            to,
            subject: message.subject,
            body: message.body,
            idempotencyKey: key,
          });
  } catch (err) {
    const rejection = err instanceof ProviderError && err.conclusivelyRejected;
    if (!rejection) {
      await prisma.$transaction(async (tx) => {
        const changed = await tx.reminderDelivery.updateMany({ where: { id: delivery.id, status: 'DISPATCHING' }, data: { status: 'UNCERTAIN' } });
        if (changed.count) await auditPatientChange(tx, SYSTEM_ACTOR, 'REMINDER_UNCERTAIN', 'ReminderDelivery', { ...followUp, id: delivery.id }, { channel: job.channel });
      });
      return { status: 'skipped', reason: 'AWAITING_CONFIRMATION' };
    }
    const final = opts.isFinalAttempt || err.permanent;
    await prisma.$transaction(async (tx) => {
      await tx.reminderDelivery.update({ where: { id: delivery.id }, data: { status: final ? 'FAILED' : 'PENDING', deliveryStatus: final ? 'FAILED' : null } });
      if (final) await logOutreachAttempt({ followUp, channel: job.channel, consentId: stillConsented.id, outcome: 'FAILED', deliveryStatus: 'FAILED' }, tx);
    });
    throw err;
  }

  // The provider accepted it. Record that FIRST and on its own, so that if the
  // outreach log below fails the retry knows not to send again.
  const sentRow = await prisma.reminderDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'SENT',
      providerMessageId: sent.providerMessageId,
      ...(sent.deliveryStatus ? { deliveryStatus: sent.deliveryStatus } : {}),
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
    attemptedAt: delivery.sentAt ?? undefined,
    outcome: 'SENT',
    providerMessageId: delivery.providerMessageId ?? undefined,
    deliveryStatus: delivery.deliveryStatus ?? undefined,
  });
  return { status: 'sent', outreachId: log.id };
}

/** Reuse a retry's delivery row, or create it. Two workers racing on one key end up with one row. */
async function claimDelivery(
  existing: ReminderDelivery | null,
  data: { idempotencyKey: string; cycle: number; followUpId: string; channel: ReminderChannel; consentId: string },
): Promise<ReminderDelivery | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FollowUp" WHERE id = ${data.followUpId} FOR UPDATE`;
    const other = await tx.reminderDelivery.findFirst({ where: { followUpId: data.followUpId, channel: data.channel, cycle: data.cycle,
      idempotencyKey: { not: data.idempotencyKey }, status: { in: ['PENDING', 'SENT', 'DISPATCHING', 'UNCERTAIN'] },
      OR: [{ deliveryStatus: null }, { deliveryStatus: 'DELIVERED' }] } });
    if (other) return null;
    return existing ?? await tx.reminderDelivery.findUnique({ where: { idempotencyKey: data.idempotencyKey } }) ?? tx.reminderDelivery.create({ data });
  });
}

/** A reminder that will not go out (consent withdrawn, task closed): record that it was cancelled. */
async function cancelDelivery(delivery: ReminderDelivery | null) {
  if (delivery && delivery.status === 'PENDING') {
    await prisma.reminderDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING' },
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
        voidedAt: null,
        consents: {
          some: { consentType: 'REMINDER', channel, isGranted: true, withdrawnAt: null },
        },
      },
    },
    select: { id: true, patientId: true, reminderCycle: true,
      deliveries: { where: { channel, status: { in: ['SENT', 'DISPATCHING', 'UNCERTAIN'] }, OR: [{ deliveryStatus: null }, { deliveryStatus: 'DELIVERED' }] }, select: { cycle: true, providerMessageId: true } },
      outreachLogs: { where: { channel, outcome: 'SENT', OR: [{ deliveryStatus: null }, { deliveryStatus: 'DELIVERED' }] }, select: { providerMessageId: true } } },
  });
  const eligible: string[] = [];
  for (const task of rows) {
    if (task.deliveries.some((d) => d.cycle === task.reminderCycle && !d.providerMessageId?.startsWith('stub-'))) continue;
    if (!task.reminderCycle && task.outreachLogs.some((l) => !l.providerMessageId?.startsWith('stub-'))) continue;
    if (await findActiveReminderConsent(task.patientId, channel)) eligible.push(task.id);
  }
  return eligible;
}
