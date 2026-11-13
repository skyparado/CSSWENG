import type { FollowUp, FollowUpStatus, Prisma } from '@prisma/client';
import type { FollowUpBucket } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { decrypt } from '../lib/fieldCrypto.js';
import { formatPatientNumber } from '../patients/patient.normalize.js';
import { addDays, toDateOnly } from './dates.js';
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

/** A follow-up set from a visit must use this patient's visit at the task's clinic. */
export function assertEncounterMatches(
  encounter: { patientId: string; clinicId: string } | null,
  target: { patientId: string; clinicId: string },
) {
  if (!encounter || encounter.patientId !== target.patientId || encounter.clinicId !== target.clinicId) {
    throw badRequest("encounterId must be this patient's visit at the task's clinic");
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
  patient: { select: { id: true, patientSeq: true, firstName: true, lastName: true, mobileNumber: true } },
  clinic: { select: { id: true, name: true } },
} satisfies Prisma.FollowUpInclude;

type EncryptedPatientSummary = { firstName: string; lastName: string; mobileNumber: string; patientSeq?: number };

/** Patient names and phone are stored encrypted; decrypt them before responding. */
export function withPlainPatient<T extends { patient: EncryptedPatientSummary }>(row: T): T {
  const p = row.patient;
  return {
    ...row,
    patient: {
      ...p,
      ...(typeof p.patientSeq === 'number' ? { patientNumber: formatPatientNumber(p.patientSeq) } : {}),
      firstName: decrypt(p.firstName),
      lastName: decrypt(p.lastName),
      mobileNumber: decrypt(p.mobileNumber),
    },
  };
}

/**
 * The S11 status chips as a database filter. `today` is the clinic-local date
 * (YYYY-MM-DD). Overdue and due are open tasks only: a task already booked is
 * "booked", whatever its date.
 */
export function bucketWhere(bucket: FollowUpBucket, today: string): Prisma.FollowUpWhereInput {
  switch (bucket) {
    case 'overdue':
      return { status: 'OPEN', dueDate: { lt: toDateOnly(today) } };
    case 'due':
      return { status: 'OPEN', dueDate: { gte: toDateOnly(today), lte: toDateOnly(addDays(today, 7)) } };
    case 'booked':
      return { status: 'SCHEDULED' };
    case 'done':
      return { status: 'COMPLETED' };
    case 'closed':
      return { status: { in: ['DECLINED', 'UNREACHABLE'] } };
  }
}

/** Counts for the S11 chips, for one clinic (or all clinics when `clinicId` is undefined). */
export async function followUpCounts(clinicId: string | undefined, today: string) {
  const base = clinicId ? { clinicId } : {};
  const [all, overdue, due, booked, done, closed] = await Promise.all([
    prisma.followUp.count({ where: base }),
    ...(['overdue', 'due', 'booked', 'done', 'closed'] as const).map((b) =>
      prisma.followUp.count({ where: { ...base, ...bucketWhere(b, today) } }),
    ),
  ]);
  return { all, overdue, due, booked, done, closed };
}

export type ReminderConsentFlags = { SMS: boolean; EMAIL: boolean };

/**
 * Whether each patient has ACTIVE reminder consent per channel (the latest
 * decision wins; granted and not withdrawn), for the "SMS on file / No
 * consent" column. One query for the whole page.
 */
export async function reminderConsentFor(patientIds: string[]): Promise<Map<string, ReminderConsentFlags>> {
  const result = new Map<string, ReminderConsentFlags>();
  for (const id of patientIds) result.set(id, { SMS: false, EMAIL: false });
  if (patientIds.length === 0) return result;

  const rows = await prisma.patientConsent.findMany({
    where: { patientId: { in: [...new Set(patientIds)] }, consentType: 'REMINDER' },
    orderBy: { consentedAt: 'desc' },
    select: { patientId: true, channel: true, isGranted: true, withdrawnAt: true },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.channel) continue;
    const key = `${r.patientId}|${r.channel}`;
    if (seen.has(key)) continue; // newest first: the first row per patient and channel is the decision
    seen.add(key);
    const flags = result.get(r.patientId);
    if (flags) flags[r.channel] = r.isGranted && !r.withdrawnAt;
  }
  return result;
}
