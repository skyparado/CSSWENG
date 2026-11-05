import type { FollowUpTaskType, ReminderChannel } from '@prisma/client';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { findActiveReminderConsent } from '../consents/consents.service.js';
import { addDays, todayInTimezone, toDateOnly } from '../followups/dates.js';
import { logOutreachAttempt } from '../followups/outreach.service.js';
import type { Gateways } from './gateway.js';
import { decryptOpt } from '../lib/fieldCrypto.js';

export interface ReminderJobData {
  followUpId: string;
  channel: ReminderChannel;
}

export type ReminderResult =
  | { status: 'sent'; outreachId: string }
  | {
      status: 'skipped';
      reason: 'FOLLOW_UP_NOT_FOUND' | 'NOT_OPEN' | 'NO_CONSENT' | 'NO_CONTACT';
    };

const TASK_LABELS: Record<FollowUpTaskType, string> = {
  FOLLOW_UP: 'follow-up visit',
  CHECK_UP: 'check-up',
  LAB_TEST: 'laboratory test',
  INJECTION: 'injection',
  PROCEDURE: 'procedure',
};

/**
 * Reminder text. It names the clinic and the kind of visit but never the
 * clinical reason, since SMS and email are not a secure channel (RA 10173).
 */
export function buildReminderMessage(input: {
  clinicName: string;
  taskType: FollowUpTaskType;
  dueDate: Date;
  clinicPhone?: string | null;
}): { subject: string; body: string } {
  const due = input.dueDate.toISOString().slice(0, 10);
  const contact = input.clinicPhone ? ` Call ${input.clinicPhone} to book.` : ' Please contact the clinic to book.';
  return {
    subject: `Reminder from ${input.clinicName}`,
    body: `${input.clinicName}: you are due for a ${TASK_LABELS[input.taskType]} on ${due}.${contact}`,
  };
}

/**
 * Send one reminder. Runs inside the BullMQ worker.
 *
 * Sends only when the follow-up is still open and the patient holds active
 * reminder consent for the channel. A skipped reminder writes no outreach row
 * (an SMS/email row cannot exist without consent). Gateway errors are rethrown
 * so BullMQ retries; on the final attempt a FAILED outreach row is written
 * first so the failure counts toward marking the patient unreachable.
 */
export async function processReminder(
  job: ReminderJobData,
  gateways: Gateways,
  opts: { isFinalAttempt: boolean },
): Promise<ReminderResult> {
  const followUp = await prisma.followUp.findUnique({
    where: { id: job.followUpId },
    include: { patient: true, clinic: true },
  });
  if (!followUp) return { status: 'skipped', reason: 'FOLLOW_UP_NOT_FOUND' };
  if (followUp.status !== 'OPEN') return { status: 'skipped', reason: 'NOT_OPEN' };

  const consent = await findActiveReminderConsent(followUp.patientId, job.channel);
  if (!consent) return { status: 'skipped', reason: 'NO_CONSENT' };

  // Patient contact details are stored encrypted (patients/patient.mapper.ts).
  const to = decryptOpt(job.channel === 'SMS' ? followUp.patient.mobileNumber : followUp.patient.email);
  if (!to) return { status: 'skipped', reason: 'NO_CONTACT' };

  const message = buildReminderMessage({
    clinicName: followUp.clinic.name,
    taskType: followUp.taskType,
    dueDate: followUp.dueDate,
    clinicPhone: followUp.clinic.phone,
  });

  const base = { followUp, channel: job.channel, consentId: consent.id } as const;
  try {
    const sent =
      job.channel === 'SMS'
        ? await gateways.sms.send({ to, body: message.body })
        : await gateways.email.send({ to, subject: message.subject, body: message.body });

    const log = await logOutreachAttempt({
      ...base,
      outcome: 'SENT',
      providerMessageId: sent.providerMessageId,
      deliveryStatus: sent.deliveryStatus,
    });
    return { status: 'sent', outreachId: log.id };
  } catch (err) {
    if (opts.isFinalAttempt) {
      await logOutreachAttempt({ ...base, outcome: 'FAILED', deliveryStatus: 'FAILED' });
    }
    throw err;
  }
}

/**
 * Find open follow-ups (due soon or overdue) whose patient has granted reminder
 * consent on a channel and that have not been sent a reminder on it yet.
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
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
