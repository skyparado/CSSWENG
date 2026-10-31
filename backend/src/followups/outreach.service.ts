import type {
  DeliveryStatus,
  OutreachChannel,
  OutreachLog,
  OutreachOutcome,
} from '@prisma/client';
import { FAILED_CONTACT_OUTCOMES } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { env } from '../env.js';

export interface LogAttemptInput {
  followUp: { id: string; patientId: string; clinicId: string };
  channel: OutreachChannel;
  outcome: OutreachOutcome;
  /** Required for SMS and EMAIL: the reminder consent that was checked. */
  consentId?: string;
  /** The staff member who made the call; omit for automated reminders. */
  contactedById?: string;
  patientResponse?: string;
  providerMessageId?: string;
  deliveryStatus?: DeliveryStatus;
  attemptedAt?: Date;
}

/**
 * Append a contact attempt to the outreach log and apply its effect on the
 * follow-up task:
 *  - DECLINED closes the task as declined (FR-5.5.8);
 *  - enough failed attempts (no answer, wrong number, delivery failure) mark an
 *    open task UNREACHABLE (FR-5.5.8).
 */
export async function logOutreachAttempt(input: LogAttemptInput): Promise<OutreachLog> {
  if ((input.channel === 'SMS' || input.channel === 'EMAIL') && !input.consentId) {
    // Database Design 1.5: no SMS/email row without the consent that allowed it.
    throw new Error('SMS and email outreach requires a reminder consent');
  }

  const { followUp } = input;
  const attemptNumber = (await prisma.outreachLog.count({ where: { followUpId: followUp.id } })) + 1;

  const log = await prisma.outreachLog.create({
    data: {
      followUpId: followUp.id,
      patientId: followUp.patientId,
      clinicId: followUp.clinicId,
      consentId: input.consentId,
      channel: input.channel,
      attemptNumber,
      attemptedAt: input.attemptedAt,
      outcome: input.outcome,
      patientResponse: input.patientResponse,
      providerMessageId: input.providerMessageId,
      deliveryStatus: input.deliveryStatus,
      contactedById: input.contactedById,
    },
  });

  if (input.outcome === 'DECLINED') {
    await prisma.followUp.updateMany({
      where: { id: followUp.id, status: { in: ['OPEN', 'SCHEDULED'] } },
      data: { status: 'DECLINED', closureNote: input.patientResponse ?? 'Declined by patient' },
    });
  } else if ((FAILED_CONTACT_OUTCOMES as readonly string[]).includes(input.outcome)) {
    await markUnreachableIfExhausted(followUp.id);
  }

  return log;
}

/** Mark an open task UNREACHABLE once it has used up its failed attempts. */
export async function markUnreachableIfExhausted(
  followUpId: string,
  limit: number = env.UNREACHABLE_AFTER_ATTEMPTS,
): Promise<boolean> {
  const failed = await prisma.outreachLog.count({
    where: { followUpId, outcome: { in: [...FAILED_CONTACT_OUTCOMES] } },
  });
  if (failed < limit) return false;
  const { count } = await prisma.followUp.updateMany({
    where: { id: followUpId, status: 'OPEN' },
    data: { status: 'UNREACHABLE', closureNote: `No contact after ${failed} attempts` },
  });
  return count > 0;
}

/**
 * Record the SMS/email service's delivery report. This is the only field of an
 * outreach row that may change after it is written (Database Design 1.5); call
 * it from the provider webhook adapter once a provider is chosen.
 */
export async function recordDeliveryReport(
  providerMessageId: string,
  deliveryStatus: DeliveryStatus,
): Promise<number> {
  const { count } = await prisma.outreachLog.updateMany({
    where: { providerMessageId },
    data: { deliveryStatus },
  });
  return count;
}
