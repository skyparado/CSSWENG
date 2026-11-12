import type { FollowUp, FollowUpStatus, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { decrypt } from '../lib/fieldCrypto.js';
import { badRequest } from '../http.js';
import { AuditActions } from '../audit/actions.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../audit/record.js';
import type { AuditTx } from '../audit/audit.service.js';

/** Task types that stay open until staff record completion (FR-5.5.9). */
const STAYS_OPEN_ON_APPOINTMENT = ['LAB_TEST', 'INJECTION', 'PROCEDURE'] as const;

export const FOLLOW_UP_RESOURCE = 'FollowUp';

/**
 * Record a follow-up status change in the shared audit log. Call it inside the
 * transaction that changes the status so the two commit together. The closure
 * note and reason are free-text clinical data and are deliberately not copied
 * into the (unencrypted) audit metadata.
 */
export function auditFollowUpStatusChange(
  tx: AuditTx,
  actor: AuditActor,
  followUp: Pick<FollowUp, 'id' | 'patientId' | 'clinicId'> & { appointmentId?: string | null },
  change: { from: FollowUpStatus; to: FollowUpStatus; via: string },
) {
  return recordAudit(
    actor,
    {
      action: AuditActions.FOLLOW_UP_STATUS_CHANGED,
      resourceType: FOLLOW_UP_RESOURCE,
      resourceId: followUp.id,
      metadata: {
        from: change.from,
        to: change.to,
        via: change.via,
        patientId: followUp.patientId,
        clinicId: followUp.clinicId,
        appointmentId: followUp.appointmentId ?? null,
      },
    },
    tx,
  );
}

/**
 * A follow-up may only point at an appointment of the same patient at the same
 * clinic, and not at one that was cancelled or missed. Used when creating,
 * scheduling and completing a follow-up.
 */
export function assertAppointmentMatches(
  appt: { patientId: string; clinicId: string; status?: string } | null,
  target: { patientId: string; clinicId: string },
) {
  if (!appt || appt.patientId !== target.patientId || appt.clinicId !== target.clinicId) {
    throw badRequest("appointmentId must be this patient's appointment at the task's clinic");
  }
  if (appt.status === 'CANCELLED' || appt.status === 'NO_SHOW') {
    throw badRequest('That appointment is not active');
  }
}

/**
 * Close the follow-up tasks linked to an appointment that has just been
 * completed (FR-5.5.9). Laboratory, injection and procedure tasks are left open
 * until authorized staff record that the test or procedure was done. Every
 * task closed is audited, in the same transaction as the status change.
 */
export async function closeFollowUpsForCompletedAppointment(
  appointmentId: string,
  completedById?: string,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const due = await tx.followUp.findMany({
      where: {
        appointmentId,
        status: { in: ['OPEN', 'SCHEDULED'] },
        taskType: { notIn: [...STAYS_OPEN_ON_APPOINTMENT] },
      },
      select: { id: true, patientId: true, clinicId: true, appointmentId: true, status: true },
    });
    if (due.length === 0) return 0;

    await tx.followUp.updateMany({
      where: { id: { in: due.map((f) => f.id) }, status: { in: ['OPEN', 'SCHEDULED'] } },
      data: { status: 'COMPLETED', completedAt: new Date(), completedById },
    });
    for (const f of due) {
      await auditFollowUpStatusChange(tx, actor, f, {
        from: f.status,
        to: 'COMPLETED',
        via: 'APPOINTMENT_COMPLETED',
      });
    }
    return due.length;
  });
}

export interface FollowUpFilters {
  clinicId?: string;
  patientId?: string;
  taskType?: Prisma.FollowUpWhereInput['taskType'];
  priority?: Prisma.FollowUpWhereInput['priority'];
  reason?: string;
}

/**
 * Where-clause for the filters shared by the dashboard, due and overdue lists.
 * `reason` is intentionally NOT here: that column is encrypted, so the database
 * cannot search it. Use `matchesReason` on the decrypted rows instead.
 */
export function followUpWhere(f: FollowUpFilters): Prisma.FollowUpWhereInput {
  return {
    clinicId: f.clinicId,
    patientId: f.patientId,
    taskType: f.taskType,
    priority: f.priority,
  };
}

/** Case-insensitive substring match on the (decrypted) task reason. */
export function matchesReason(followUp: { reason: string }, search?: string): boolean {
  if (!search) return true;
  return followUp.reason.toLowerCase().includes(search.toLowerCase());
}

/** What the lists return for each task: the task plus enough patient info to call. */
export const followUpInclude = {
  patient: { select: { id: true, firstName: true, lastName: true, mobileNumber: true } },
  clinic: { select: { id: true, name: true } },
} satisfies Prisma.FollowUpInclude;

type EncryptedPatientSummary = { firstName: string; lastName: string; mobileNumber: string };

/** Patient names and phone are stored encrypted; decrypt them before responding. */
export function withPlainPatient<T extends { patient: EncryptedPatientSummary }>(row: T): T {
  const p = row.patient;
  return {
    ...row,
    patient: {
      ...p,
      firstName: decrypt(p.firstName),
      lastName: decrypt(p.lastName),
      mobileNumber: decrypt(p.mobileNumber),
    },
  };
}
