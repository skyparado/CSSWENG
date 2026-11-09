import { Router, type Request } from 'express';
import type { FollowUp, Prisma } from '@prisma/client';
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
import { asyncHandler, badRequest, conflict, notFound, validate } from '../http.js';
import {
  assertClinicAccess,
  clinicForRead,
  clinicForWrite,
  currentUser,
  requireAuth,
  requireRole,
} from '../auth/guards.js';
import { findActiveReminderConsent } from '../consents/consents.service.js';
import { enqueueReminder } from '../reminders/queue.js';
import { addDays, daysOverdue, todayInTimezone, toDateOnly } from './dates.js';
import { followUpInclude, followUpWhere, withPlainPatient, type FollowUpFilters } from './followups.service.js';

export const followUpsRouter = Router();

followUpsRouter.use(requireAuth);

type ListQuery = FollowUpFilters & { page: number; pageSize: number };

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
  return { items: items.map(withPlainPatient), total, page: q.page, pageSize: q.pageSize };
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
    const q = req.query as unknown as ListQuery & { status?: FollowUp['status'] };
    res.json(await paginate(req, q, { status: q.status }, byDueThenPriority));
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

function assertOpenOrScheduled(followUp: FollowUp) {
  if (followUp.status !== 'OPEN' && followUp.status !== 'SCHEDULED') {
    throw conflict(`Follow-up is already ${followUp.status.toLowerCase()}`);
  }
}

/** GET /api/follow-ups/:id — one task with its outreach history. */
followUpsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const followUp = await prisma.followUp.findUnique({
      where: { id: req.params.id },
      include: {
        ...followUpInclude,
        outreachLogs: { orderBy: { attemptNumber: 'asc' } },
      },
    });
    if (!followUp) throw notFound('Follow-up not found');
    assertClinicAccess(req, followUp.clinicId);
    res.json(withPlainPatient(followUp));
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
      taskType: FollowUp['taskType'];
      reason: string;
      dueDate: string;
      priority: FollowUp['priority'];
      recallRule?: string;
    };
    const clinicId = clinicForWrite(req, body.clinicId);

    const [patient, clinic] = await Promise.all([
      // Voided records are mistakes or duplicates; never plan care against them.
      prisma.patient.findFirst({ where: { id: body.patientId, voidedAt: null } }),
      prisma.clinic.findUnique({ where: { id: clinicId } }),
    ]);
    if (!patient) throw notFound('Patient not found');
    if (!clinic) throw notFound('Clinic not found');

    if (body.appointmentId) {
      const appt = await prisma.appointment.findUnique({ where: { id: body.appointmentId } });
      if (!appt || appt.patientId !== body.patientId) {
        throw badRequest('appointmentId does not belong to this patient');
      }
    }

    const followUp = await prisma.followUp.create({
      data: {
        patientId: body.patientId,
        clinicId,
        appointmentId: body.appointmentId,
        taskType: body.taskType,
        reason: body.reason,
        dueDate: toDateOnly(body.dueDate),
        priority: body.priority,
        recallRule: body.recallRule,
        status: body.appointmentId ? 'SCHEDULED' : 'OPEN',
        createdById: currentUser(req).userId,
      },
      include: followUpInclude,
    });
    res.status(201).json(withPlainPatient(followUp));
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
      reason?: string;
      dueDate?: string;
      priority?: FollowUp['priority'];
    };
    const updated = await prisma.followUp.update({
      where: { id: existing.id },
      data: {
        taskType: patch.taskType,
        reason: patch.reason,
        priority: patch.priority,
        dueDate: patch.dueDate ? toDateOnly(patch.dueDate) : undefined,
      },
      include: followUpInclude,
    });
    res.json(withPlainPatient(updated));
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
    const updated = await prisma.followUp.update({
      where: { id: existing.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        completedById: currentUser(req).userId,
        closureNote: body.closureNote,
        appointmentId: body.appointmentId,
      },
      include: followUpInclude,
    });
    res.json(withPlainPatient(updated));
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
    const updated = await prisma.followUp.update({
      where: { id: existing.id },
      data: { status: 'DECLINED', closureNote: (req.body as { closureNote: string }).closureNote },
      include: followUpInclude,
    });
    res.json(withPlainPatient(updated));
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
    if (!appt || appt.patientId !== existing.patientId || appt.clinicId !== existing.clinicId) {
      throw badRequest("appointmentId must be this patient's appointment at the task's clinic");
    }
    if (appt.status === 'CANCELLED' || appt.status === 'NO_SHOW') {
      throw badRequest('That appointment is not active');
    }

    const updated = await prisma.followUp.update({
      where: { id: existing.id },
      data: { status: 'SCHEDULED', appointmentId },
      include: followUpInclude,
    });
    res.json(withPlainPatient(updated));
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
    const jobId = await enqueueReminder({ followUpId: existing.id, channel });
    res.status(202).json({ queued: true, jobId });
  }),
);
