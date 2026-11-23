import { Router, type Request } from 'express';
import type { FollowUp, Prisma } from '@prisma/client';
import type { FollowUpBucket } from '@clinic/schemas';
import {
  followUpCompleteSchema,
  followUpCreateSchema,
  followUpDeclineSchema,
  followUpDueQuerySchema,
  followUpOverdueQuerySchema,
  followUpQuerySchema,
  followUpRemindSchema,
  followUpScheduleSchema,
  followUpUpdateSchema,
  idParamSchema,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncHandler, conflict, HttpError, badRequest, notFound, validate } from '../http.js';
import {
  assertClinicAccess,
  clinicForRead,
  clinicForWrite,
  currentUser,
  requireAuth,
  requireRole,
} from '../auth/guards.js';
import { findActiveReminderConsent, latestReminderConsents } from '../consents/consents.service.js';
import { FAILED_CONTACT_OUTCOMES } from '@clinic/schemas';
import { presentAttempt } from './outreach.service.js';
import { channelAvailability } from '../reminders/gateway.js';
import { enqueueReminder } from '../reminders/queue.js';
import { actorFromRequest, auditPatientChange } from '../audit/record.js';
import { addDays, daysOverdue, todayInTimezone, toDateOnly } from './dates.js';
import {
  assertAppointmentMatches,
  assertEncounterMatches,
  auditFollowUpStatusChange,
  bucketWhere,
  followUpCounts,
  followUpInclude,
  followUpWhere,
  matchesReason,
  reminderConsentFor,
  withPlainPatient,
  type FollowUpFilters,
} from './followups.service.js';

export const followUpsRouter = Router();

followUpsRouter.use(requireAuth);

type ListQuery = FollowUpFilters & { page: number; pageSize: number };

function present<T extends { patient: Parameters<typeof withPlainPatient>[0]['patient']; reason?: string; closureNote?: string | null; recallRule?: string | null; recallIntervalDays?: number | null }>(req: Request, row: T) {
  const result = withPlainPatient(row);
  if (currentUser(req).role === 'DOCTOR') return result;
  const { reason, closureNote, recallRule, recallIntervalDays, ...administrative } = result;
  return administrative;
}

/** Plain patient fields plus whether each patient has active SMS / email reminder consent. */
async function decorate<T extends { patientId: string; patient: Parameters<typeof withPlainPatient>[0]['patient'] }>(
  req: Request, items: T[],
) {
  const consent = await reminderConsentFor(items.map((i) => i.patientId));
  return items.map((i) => ({
    ...present(req, i),
    reminderConsent: consent.get(i.patientId) ?? { SMS: false, EMAIL: false },
  }));
}

/** Run a paginated list query with the shared filters plus list-specific conditions. */
async function paginate(
  req: Request,
  q: ListQuery,
  extra: Prisma.FollowUpWhereInput,
  orderBy: Prisma.FollowUpOrderByWithRelationInput[],
) {
  const where: Prisma.FollowUpWhereInput = {
    ...followUpWhere({ ...q, clinicId: clinicForRead(req, q.clinicId) }),
    ...extra,
  };

  // `reason` is encrypted at rest, so the database cannot search it: when the
  // caller filters by reason, load the other matches (already decrypted by the
  // Prisma extension), filter here, then page the result.
  if (q.reason && currentUser(req).role !== 'DOCTOR') throw new HttpError(403, 'Only Doctors can search clinical reasons');
  if (q.reason) {
    const all = await prisma.followUp.findMany({ where, include: followUpInclude, orderBy });
    const matching = all.filter((f) => matchesReason(f, q.reason));
    return {
      items: await decorate(req, matching.slice((q.page - 1) * q.pageSize, q.page * q.pageSize)),
      total: matching.length,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  const [items, total] = await Promise.all([
    prisma.followUp.findMany({
      where,
      include: followUpInclude,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.followUp.count({ where }),
  ]);
  return { items: await decorate(req, items), total, page: q.page, pageSize: q.pageSize };
}

const byDueThenPriority: Prisma.FollowUpOrderByWithRelationInput[] = [
  { dueDate: 'asc' },
  { priority: 'desc' }, // HIGH sorts last in the enum, so descending puts it first
];

/** GET /api/follow-ups — the dashboard list, filterable by status, clinic, reason and priority. */
followUpsRouter.get(
  '/',
  validate(followUpQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListQuery & { status?: FollowUp['status']; bucket?: FollowUpBucket };
    // A chip (bucket) wins over a raw status; finished tasks list newest first.
    const extra = q.bucket ? bucketWhere(q.bucket, todayInTimezone(env.CLINIC_TIMEZONE)) : { status: q.status };
    const finished = q.bucket === 'done' || q.bucket === 'closed';
    res.json(await paginate(req, q, extra, finished ? [{ dueDate: 'desc' }] : byDueThenPriority));
  }),
);

/** GET /api/follow-ups/summary — the counts on the S11 status chips, for the active clinic. */
followUpsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const clinicId = clinicForRead(req, req.query.clinicId as string | undefined);
    res.json(await followUpCounts(clinicId, todayInTimezone(env.CLINIC_TIMEZONE)));
  }),
);

/** GET /api/follow-ups/due — open tasks due today (or within `withinDays`), for the clinic. */
followUpsRouter.get(
  '/due',
  validate(followUpDueQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListQuery & { withinDays: number };
    const today = todayInTimezone(env.CLINIC_TIMEZONE);
    const result = await paginate(
      req,
      q,
      {
        status: 'OPEN',
        dueDate: { gte: toDateOnly(today), lte: toDateOnly(addDays(today, q.withinDays)) },
      },
      byDueThenPriority,
    );
    res.json(result);
  }),
);

/** GET /api/follow-ups/overdue — open tasks past their due date, oldest first, for the clinic. */
followUpsRouter.get(
  '/overdue',
  validate(followUpOverdueQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListQuery;
    const today = todayInTimezone(env.CLINIC_TIMEZONE);
    const result = await paginate(
      req,
      q,
      { status: 'OPEN', dueDate: { lt: toDateOnly(today) } },
      byDueThenPriority,
    );
    res.json({
      ...result,
      items: result.items.map((f) => ({ ...f, daysOverdue: daysOverdue(f.dueDate, today) })),
    });
  }),
);

/** Load a follow-up the caller may see, or throw 404. */
async function loadFollowUp(req: Request): Promise<FollowUp> {
  const followUp = await prisma.followUp.findUnique({ where: { id: req.params.id } });
  if (!followUp) throw notFound('Follow-up not found');
  assertClinicAccess(req, followUp.clinicId);
  return followUp;
}

async function checkLockedAppointment(tx: import('../audit/audit.service.js').AuditTx, id: string, target: Pick<FollowUp, 'clinicId' | 'patientId'>) {
  await tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${id} FOR UPDATE`;
  assertAppointmentMatches(await tx.appointment.findUnique({ where: { id } }), target);
}

function assertOpenOrScheduled(followUp: FollowUp) {
  if (followUp.status !== 'OPEN' && followUp.status !== 'SCHEDULED') {
    throw conflict(`Follow-up is already ${followUp.status.toLowerCase()}`);
  }
}

/**
 * Apply a status change and its audit entry in one transaction, so a status can
 * never change without the shared audit log recording who did it.
 */
function changeStatus(
  req: Request,
  existing: FollowUp,
  data: Prisma.FollowUpUncheckedUpdateInput,
  via: string,
) {
  return prisma.$transaction(async (tx) => {
    if (typeof data.appointmentId === 'string') await checkLockedAppointment(tx, data.appointmentId, existing);
    const updated = await tx.followUp.update({
      where: { id: existing.id, status: existing.status },
      data,
      include: followUpInclude,
    });
    await auditFollowUpStatusChange(tx, actorFromRequest(req), updated, {
      from: existing.status,
      to: updated.status,
      via,
    });
    return updated;
  });
}

/**
 * GET /api/follow-ups/:id — one task with everything S12 shows: the attempt
 * history (who made each one, delivery status), the patient's reminder consent
 * per channel and how close the task is to being marked unreachable.
 */
followUpsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const followUp = await prisma.followUp.findUnique({
      where: { id: req.params.id },
      include: {
        ...followUpInclude,
        deliveries: { where: { status: { in: ['DISPATCHING', 'UNCERTAIN'] } }, select: { channel: true, updatedAt: true } },
        outreachLogs: {
          orderBy: { attemptNumber: 'asc' },
          include: { contactedBy: { select: { fullName: true } } },
        },
      },
    });
    if (!followUp) throw notFound('Follow-up not found');
    assertClinicAccess(req, followUp.clinicId);

    const consents = await latestReminderConsents(followUp.patientId);
    const failed = followUp.outreachLogs.filter((l) =>
      l.deliveryStatus === 'FAILED' || (FAILED_CONTACT_OUTCOMES as readonly string[]).includes(l.outcome),
    ).length;
    res.json({
      ...present(req, followUp),
      outreachLogs: followUp.outreachLogs.map((log) => presentAttempt(log, currentUser(req).role)),
      channelAvailability: channelAvailability(),
      consents,
      failedAttempts: failed,
      unreachableAfter: env.UNREACHABLE_AFTER_ATTEMPTS,
    });
  }),
);

/** POST /api/follow-ups — Doctor sets a follow-up, check-up, lab test, injection or procedure. */
followUpsRouter.post(
  '/',
  requireRole('DOCTOR'),
  validate(followUpCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      patientId: string;
      clinicId?: string;
      appointmentId?: string;
      encounterId?: string;
      taskType: FollowUp['taskType'];
      reason: string;
      dueDate: string;
      priority: FollowUp['priority'];
      recallRule?: string;
      recallIntervalDays?: number;
    };
    const clinicId = clinicForWrite(req, body.clinicId);

    const [patient, clinic] = await Promise.all([
      // Voided records are mistakes or duplicates; never plan care against them.
      prisma.patient.findFirst({ where: { id: body.patientId, voidedAt: null } }),
      prisma.clinic.findUnique({ where: { id: clinicId } }),
    ]);
    if (!patient) throw notFound('Patient not found');
    if (!clinic) throw notFound('Clinic not found');

    if (body.encounterId) {
      const encounter = await prisma.encounter.findUnique({ where: { id: body.encounterId } });
      assertEncounterMatches(encounter, { patientId: body.patientId, clinicId });
    }

    if (body.recallIntervalDays && body.taskType !== 'CHECK_UP') throw badRequest('Routine recalls require a check-up');
    const followUp = await prisma.$transaction(async (tx) => {
      if (body.appointmentId) await checkLockedAppointment(tx, body.appointmentId, { patientId: body.patientId, clinicId });
      const task = await tx.followUp.create({
        data: {
          patientId: body.patientId,
          clinicId,
          appointmentId: body.appointmentId,
          encounterId: body.encounterId,
          taskType: body.taskType,
          reason: body.reason,
          dueDate: toDateOnly(body.dueDate),
          priority: body.priority,
          recallRule: body.recallRule,
          recallIntervalDays: body.recallIntervalDays,
          status: body.appointmentId ? 'SCHEDULED' : 'OPEN',
          createdById: currentUser(req).userId,
        },
        include: followUpInclude,
      });
      await auditPatientChange(tx, actorFromRequest(req), 'FOLLOW_UP_CREATED', 'FollowUp', task);
      return task;
    });
    res.status(201).json(present(req, followUp));
  }),
);

/** PATCH /api/follow-ups/:id — Doctor edits the plan of a task that is not closed. */
followUpsRouter.patch(
  '/:id',
  requireRole('DOCTOR'),
  validate(idParamSchema, 'params'),
  validate(followUpUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadFollowUp(req);
    assertOpenOrScheduled(existing);
    const patch = req.body as {
      taskType?: FollowUp['taskType'];
      recallIntervalDays?: number | null;
      reason?: string;
      dueDate?: string;
      priority?: FollowUp['priority'];
    };
    if (patch.recallIntervalDays && (patch.taskType ?? existing.taskType) !== 'CHECK_UP') throw badRequest('Routine recalls require a check-up');
    const updated = await prisma.$transaction(async (tx) => {
      const task = await tx.followUp.update({
        where: { id: existing.id, status: existing.status },
        data: {
          taskType: patch.taskType,
          recallIntervalDays: patch.taskType && patch.taskType !== 'CHECK_UP' ? null : patch.recallIntervalDays,
          reason: patch.reason,
          priority: patch.priority,
          dueDate: patch.dueDate ? toDateOnly(patch.dueDate) : undefined,
        },
        include: followUpInclude,
      });
      await auditPatientChange(tx, actorFromRequest(req), 'FOLLOW_UP_UPDATED', 'FollowUp', task, { fields: Object.keys(patch) });
      return task;
    });
    res.json(present(req, updated));
  }),
);

/**
 * POST /api/follow-ups/:id/complete — record that the visit, test or procedure
 * happened. Doctor or Secretary (authorized staff, FR-5.5.9).
 */
followUpsRouter.post(
  '/:id/complete',
  validate(idParamSchema, 'params'),
  validate(followUpCompleteSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadFollowUp(req);
    assertOpenOrScheduled(existing);
    const body = req.body as { appointmentId?: string; closureNote?: string };
    if (body.appointmentId) {
      const appt = await prisma.appointment.findUnique({ where: { id: body.appointmentId } });
      assertAppointmentMatches(appt, existing);
    }
    const updated = await changeStatus(
      req,
      existing,
      {
        status: 'COMPLETED',
        completedAt: new Date(),
        completedById: currentUser(req).userId,
        closureNote: body.closureNote,
        appointmentId: body.appointmentId,
      },
      'COMPLETE',
    );
    res.json(present(req, updated));
  }),
);

/** POST /api/follow-ups/:id/decline — the patient declined; a note is required (FR-5.5.8). */
followUpsRouter.post(
  '/:id/decline',
  validate(idParamSchema, 'params'),
  validate(followUpDeclineSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadFollowUp(req);
    assertOpenOrScheduled(existing);
    const updated = await changeStatus(
      req,
      existing,
      { status: 'DECLINED', closureNote: (req.body as { closureNote: string }).closureNote },
      'DECLINE',
    );
    res.json(present(req, updated));
  }),
);

/** POST /api/follow-ups/:id/schedule — link a booked appointment; the task becomes SCHEDULED. */
followUpsRouter.post(
  '/:id/schedule',
  validate(idParamSchema, 'params'),
  validate(followUpScheduleSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadFollowUp(req);
    assertOpenOrScheduled(existing);
    const { appointmentId } = req.body as { appointmentId: string };

    const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    assertAppointmentMatches(appt, existing);

    const updated = await changeStatus(
      req,
      existing,
      { status: 'SCHEDULED', appointmentId },
      'SCHEDULE',
    );
    res.json(present(req, updated));
  }),
);

/**
 * POST /api/follow-ups/:id/remind — queue an SMS or email reminder now. Refused
 * up front when the patient has not consented; the worker checks again when it runs.
 */
followUpsRouter.post(
  '/:id/remind',
  validate(idParamSchema, 'params'),
  validate(followUpRemindSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadFollowUp(req);
    if (existing.status !== 'OPEN') {
      throw conflict('Reminders are only sent for open follow-ups');
    }
    const { channel } = req.body as { channel: 'SMS' | 'EMAIL' };
    const consent = await findActiveReminderConsent(existing.patientId, channel);
    if (!consent) {
      throw conflict(`Patient has not consented to ${channel} reminders`);
    }
    if (!channelAvailability()[channel]) throw new HttpError(503, `${channel} provider is not configured`);
    const jobId = await enqueueReminder({ followUpId: existing.id, channel }, actorFromRequest(req));
    res.status(202).json({ queued: true, jobId });
  }),
);
