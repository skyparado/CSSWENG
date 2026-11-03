import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

/** Task types that stay open until staff record completion (FR-5.5.9). */
const STAYS_OPEN_ON_APPOINTMENT = ['LAB_TEST', 'INJECTION', 'PROCEDURE'] as const;

/**
 * Close the follow-up tasks linked to an appointment that has just been
 * completed (FR-5.5.9). Laboratory, injection and procedure tasks are left open
 * until authorized staff record that the test or procedure was done.
 */
export async function closeFollowUpsForCompletedAppointment(
  appointmentId: string,
  completedById?: string,
): Promise<number> {
  const { count } = await prisma.followUp.updateMany({
    where: {
      appointmentId,
      status: { in: ['OPEN', 'SCHEDULED'] },
      taskType: { notIn: [...STAYS_OPEN_ON_APPOINTMENT] },
    },
    data: { status: 'COMPLETED', completedAt: new Date(), completedById },
  });
  return count;
}

export interface FollowUpFilters {
  clinicId?: string;
  patientId?: string;
  taskType?: Prisma.FollowUpWhereInput['taskType'];
  priority?: Prisma.FollowUpWhereInput['priority'];
  reason?: string;
}

/** Where-clause for the filters shared by the dashboard, due and overdue lists. */
export function followUpWhere(f: FollowUpFilters): Prisma.FollowUpWhereInput {
  return {
    clinicId: f.clinicId,
    patientId: f.patientId,
    taskType: f.taskType,
    priority: f.priority,
    reason: f.reason ? { contains: f.reason, mode: 'insensitive' } : undefined,
  };
}

/** What the lists return for each task: the task plus enough patient info to call. */
export const followUpInclude = {
  patient: { select: { id: true, firstName: true, lastName: true, mobileNumber: true } },
  clinic: { select: { id: true, name: true } },
} satisfies Prisma.FollowUpInclude;
