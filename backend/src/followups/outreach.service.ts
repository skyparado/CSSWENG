import type {
  DeliveryStatus,
  OutreachChannel,
  OutreachLog,
  OutreachOutcome,
} from '@prisma/client';
import { FAILED_CONTACT_OUTCOMES } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { SYSTEM_ACTOR, type AuditActor } from '../audit/record.js';
import type { AuditTx } from '../audit/audit.service.js';
import { auditFollowUpStatusChange } from './followups.service.js';

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
  /** Who to credit in the audit log for any follow-up status change. Defaults to the system. */
  actor?: AuditActor;
}

/**
 * Append a contact attempt to the outreach log and apply its effect on the
 * follow-up task:
 *  - DECLINED closes the task as declined (FR-5.5.8);
 *  - enough failed attempts (no answer, wrong number, delivery failure) mark an
 *    open task UNREACHABLE (FR-5.5.8).
 *
 * All of it happens in ONE transaction: the outreach row, the status change and
 * its audit entry commit together or not at all. The transaction first locks
 * the follow-up row (`FOR UPDATE`), so two attempts logged at the same moment
 * run one after the other and cannot be handed the same attempt number. The
 * `(followUpId, attemptNumber)` unique index is the backstop.
 */
export async function logOutreachAttempt(input: LogAttemptInput): Promise<OutreachLog> {
  if ((input.channel === 'SMS' || input.channel === 'EMAIL') && !input.consentId) {
    // Database Design 1.5: no SMS/email row without the consent that allowed it.
    throw new Error('SMS and email outreach requires a reminder consent');
  }

  const { followUp } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "FollowUp" WHERE "id" = ${followUp.id} FOR UPDATE`;

    const last = await tx.outreachLog.aggregate({
      where: { followUpId: followUp.id },
      _max: { attemptNumber: true },
    });
    const attemptNumber = (last._max.attemptNumber ?? 0) + 1;

    const log = await tx.outreachLog.create({
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
      const current = await tx.followUp.findUnique({
        where: { id: followUp.id },
        select: { status: true },
      });
      if (current && (current.status === 'OPEN' || current.status === 'SCHEDULED')) {
        await tx.followUp.update({
          where: { id: followUp.id },
          data: { status: 'DECLINED', closureNote: input.patientResponse ?? 'Declined by patient' },
        });
        await auditFollowUpStatusChange(tx, actor, followUp, {
          from: current.status,
          to: 'DECLINED',
          via: 'OUTREACH_DECLINED',
        });
      }
    } else if ((FAILED_CONTACT_OUTCOMES as readonly string[]).includes(input.outcome)) {
      await markUnreachableIfExhausted(followUp.id, env.UNREACHABLE_AFTER_ATTEMPTS, {
        tx,
        actor,
        followUp,
      });
    }

    return log;
  });
}

/** Mark an open task UNREACHABLE once it has used up its failed attempts. */
export async function markUnreachableIfExhausted(
  followUpId: string,
  limit: number = env.UNREACHABLE_AFTER_ATTEMPTS,
  ctx: {
    tx?: AuditTx;
    actor?: AuditActor;
    followUp?: { id: string; patientId: string; clinicId: string };
  } = {},
): Promise<boolean> {
  const run = async (db: AuditTx) => {
    const failed = await db.outreachLog.count({
      where: { followUpId, outcome: { in: [...FAILED_CONTACT_OUTCOMES] } },
    });
    if (failed < limit) return false;
    const { count } = await db.followUp.updateMany({
      where: { id: followUpId, status: 'OPEN' },
      data: { status: 'UNREACHABLE', closureNote: `No contact after ${failed} attempts` },
    });
    if (count === 0) return false;

    const followUp =
      ctx.followUp ??
      (await db.followUp.findUniqueOrThrow({
        where: { id: followUpId },
        select: { id: true, patientId: true, clinicId: true },
      }));
    await auditFollowUpStatusChange(db, ctx.actor ?? SYSTEM_ACTOR, followUp, {
      from: 'OPEN',
      to: 'UNREACHABLE',
      via: 'OUTREACH_EXHAUSTED',
    });
    return true;
  };
  return ctx.tx ? run(ctx.tx) : prisma.$transaction(run);
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
