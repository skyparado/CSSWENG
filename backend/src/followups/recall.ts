import { reconcileAppointment } from './followups.service.js';
import { prisma } from '../prisma.js';
import { auditPatientChange, SYSTEM_ACTOR } from '../audit/record.js';
import { addDays, toDateOnly } from './dates.js';

/** Each completed routine check-up can generate one successor, timed from actual completion. */
export async function evaluateRoutineRecalls() {
  // Repair unfinished links left by older app versions, using the same audited transition.
  const stale = await prisma.appointment.findMany({ where: { status: { in: ['CANCELLED', 'NO_SHOW'] },
    followUps: { some: { status: { in: ['SCHEDULED', 'OPEN'] } } } }, select: { id: true } });
  for (const { id } of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.appointment.findUnique({ where: { id } });
      if (current?.status === 'CANCELLED' || current?.status === 'NO_SHOW')
        await reconcileAppointment(tx, id, current.status, undefined, SYSTEM_ACTOR);
    });
  }
  const completed = await prisma.followUp.findMany({
    where: { status: 'COMPLETED', taskType: 'CHECK_UP', completedAt: { not: null }, recallIntervalDays: { not: null }, patient: { voidedAt: null } },
    select: { id: true },
  });
  let generated = 0;
  for (const { id } of completed) {
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "FollowUp" WHERE id = ${id} FOR UPDATE`;
      const parent = await tx.followUp.findUniqueOrThrow({ where: { id }, include: { clinic: { select: { timezone: true } } } });
      if (parent.status !== 'COMPLETED' || !parent.completedAt || !parent.recallIntervalDays) return false;
      if (await tx.followUp.findUnique({ where: { recallOfId: id }, select: { id: true } })) return false;
      const completedOn = new Intl.DateTimeFormat('en-CA', { timeZone: parent.clinic.timezone }).format(parent.completedAt);
      const task = await tx.followUp.create({ data: {
        clinicId: parent.clinicId, patientId: parent.patientId, taskType: 'CHECK_UP',
        reason: parent.reason, priority: parent.priority, recallOfId: id, recallIntervalDays: parent.recallIntervalDays,
        dueDate: toDateOnly(addDays(completedOn, parent.recallIntervalDays)),
      } });
      await auditPatientChange(tx, SYSTEM_ACTOR, 'FOLLOW_UP_CREATED', 'FollowUp', task, { recallOfId: id });
      return true;
    });
    if (created) generated++;
  }
  return generated;
}
