import { Router } from 'express';
import type { Appointment, AppointmentAction, Prisma } from '@prisma/client';
import {
  appointmentCancelSchema,
  appointmentCreateSchema,
  appointmentUpdateSchema,
  appointmentQuerySchema,
  idParamSchema,
  walkInCreateSchema,
  type AppointmentCancel,
  type WalkInCreate,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, badRequest, HttpError, notFound, validate } from '../http.js';
import { checkWithinOperatingHours, nearestFreeTimes } from './operatingHours.js';
import { actorFromRequest } from '../audit/record.js';
import { closeFollowUpsForCompletedAppointment } from '../followups/followups.service.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { assertClinicAccess, clinicForRead, clinicForWrite, currentUser } from '../auth/guards.js';

export const appointmentsRouter = Router();

// All appointment endpoints require an authenticated user. Both roles may
// schedule, reschedule and cancel (per Role Permission Matrix in the SDD).
appointmentsRouter.use(requireAuth);

const LIVE: Prisma.AppointmentWhereInput = { status: { notIn: ['CANCELLED', 'NO_SHOW'] } };
const WALK_IN_MS = 30 * 60_000;

/**
 * Refuse a window that is outside the clinic's hours or overlaps another live
 * booking. There is one Doctor, so bookings at *any* clinic count. The error
 * carries the nearest free times (`details.suggestions`, ISO strings).
 */
async function assertBookable(
  clinicId: string,
  startsAt: Date,
  endsAt: Date,
  opts: { excludeId?: string; ignoreHours?: boolean } = {},
): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, include: { schedules: true } });
  if (!clinic) throw notFound('Clinic not found');

  const hours = opts.ignoreHours
    ? ({ ok: true } as const)
    : checkWithinOperatingHours(startsAt, endsAt, clinic.schedules, clinic.timezone);
  const overlap = await prisma.appointment.findFirst({
    where: {
      ...LIVE,
      id: opts.excludeId ? { not: opts.excludeId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    include: { clinic: { select: { name: true } } },
  });
  if (hours.ok && !overlap) return;

  const duration = endsAt.getTime() - startsAt.getTime();
  const horizon = new Date(startsAt.getTime() + 15 * 86_400_000);
  const busy = await prisma.appointment.findMany({
    where: { ...LIVE, id: opts.excludeId ? { not: opts.excludeId } : undefined, startsAt: { lt: horizon }, endsAt: { gt: startsAt } },
    select: { startsAt: true, endsAt: true },
  });
  const suggestions = nearestFreeTimes(
    new Date(Math.max(startsAt.getTime(), Date.now())),
    duration,
    clinic.schedules,
    clinic.timezone,
    busy.map((b): [number, number] => [b.startsAt.getTime(), b.endsAt.getTime()]),
  ).map((d) => d.toISOString());

  if (!hours.ok) throw badRequest(hours.reason, { suggestions });
  const where = overlap!.clinicId === clinicId ? 'an existing booking' : `the Doctor's booking at ${overlap!.clinic.name}`;
  throw new HttpError(409, `Appointment overlaps ${where}`, { suggestions });
}

/** Append-only history entry describing the appointment after a change. */
function eventFor(appt: Appointment, action: AppointmentAction, actorId: string, reason?: string) {
  return prisma.appointmentEvent.create({
    data: {
      appointmentId: appt.id,
      action,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      status: appt.status,
      reason,
      actorId,
    },
  });
}

/** Load an appointment the caller may see, or 404. */
async function loadAppointment(req: Parameters<typeof currentUser>[0]) {
  const appt = await prisma.appointment.findUnique({ where: { id: req.params.id } });
  if (!appt) throw notFound('Appointment not found');
  assertClinicAccess(req, appt.clinicId);
  return appt;
}

/** GET /api/appointments — filterable list. The Secretary only sees the active clinic. */
appointmentsRouter.get(
  '/',
  validate(appointmentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      clinicId?: string;
      patientId?: string;
      status?: Prisma.AppointmentWhereInput['status'];
      from?: Date;
      to?: Date;
    };
    const where: Prisma.AppointmentWhereInput = {
      clinicId: clinicForRead(req, q.clinicId),
      patientId: q.patientId,
      status: q.status,
    };
    if (q.from || q.to) where.startsAt = { gte: q.from, lte: q.to };
    const items = await prisma.appointment.findMany({
      where,
      include: { patient: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { startsAt: 'asc' },
    });
    res.json({ items });
  }),
);

/** GET /api/appointments/:id. */
appointmentsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await loadAppointment(req));
  }),
);

/** GET /api/appointments/:id/history — booking, reschedules, cancellation, oldest first. */
appointmentsRouter.get(
  '/:id/history',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await loadAppointment(req);
    const items = await prisma.appointmentEvent.findMany({
      where: { appointmentId: req.params.id },
      include: { actor: { select: { fullName: true } } },
      orderBy: { at: 'asc' },
    });
    res.json({ items });
  }),
);

/** POST /api/appointments — book inside clinic hours, without overlapping the Doctor's other bookings. */
appointmentsRouter.post(
  '/',
  validate(appointmentCreateSchema),
  asyncHandler(async (req, res) => {
    const data = req.body as {
      clinicId: string;
      patientId: string;
      startsAt: Date;
      endsAt: Date;
      reason?: string;
      visitType?: string;
      status: Prisma.AppointmentCreateInput['status'];
    };
    const clinicId = clinicForWrite(req, data.clinicId);
    await assertBookable(clinicId, data.startsAt, data.endsAt);

    const appt = await prisma.appointment.create({ data: { ...data, clinicId } });
    await eventFor(appt, 'BOOKED', currentUser(req).userId);
    res.status(201).json(appt);
  }),
);

/** POST /api/appointments/walk-in — book now, even outside hours; the Doctor's approval is recorded. */
appointmentsRouter.post(
  '/walk-in',
  validate(walkInCreateSchema),
  asyncHandler(async (req, res) => {
    const data = req.body as WalkInCreate;
    const user = currentUser(req);
    const clinicId = clinicForWrite(req, data.clinicId);
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + WALK_IN_MS);
    await assertBookable(clinicId, startsAt, endsAt, { ignoreHours: true });

    const doctor = user.role === 'DOCTOR';
    const appt = await prisma.appointment.create({
      data: {
        clinicId,
        patientId: data.patientId,
        startsAt,
        endsAt,
        reason: data.reason,
        visitType: 'Walk-in',
        walkIn: true,
        walkInApprovedById: doctor ? user.userId : null,
        walkInApprovedAt: doctor ? startsAt : null,
      },
    });
    await eventFor(appt, 'BOOKED', user.userId);
    if (doctor) await eventFor(appt, 'WALK_IN_APPROVED', user.userId);
    res.status(201).json(appt);
  }),
);

/** POST /api/appointments/:id/approve-walk-in — the Doctor approves a walk-in. */
appointmentsRouter.post(
  '/:id/approve-walk-in',
  requireDoctor,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const existing = await loadAppointment(req);
    if (!existing.walkIn) throw badRequest('Not a walk-in');
    if (existing.walkInApprovedAt) throw badRequest('Walk-in is already approved');
    const userId = currentUser(req).userId;
    const appt = await prisma.appointment.update({
      where: { id: existing.id },
      data: { walkInApprovedById: userId, walkInApprovedAt: new Date() },
    });
    await eventFor(appt, 'WALK_IN_APPROVED', userId);
    res.json(appt);
  }),
);

/** PATCH /api/appointments/:id — reschedule / restatus with re-validation. */
appointmentsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(appointmentUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadAppointment(req);
    const patch = req.body as {
      startsAt?: Date;
      endsAt?: Date;
      reason?: string;
      status?: Prisma.AppointmentUpdateInput['status'];
    };
    if (patch.status === 'CANCELLED') throw badRequest('Cancel with DELETE and a reason');
    const startsAt = patch.startsAt ?? existing.startsAt;
    const endsAt = patch.endsAt ?? existing.endsAt;
    const moved = startsAt.getTime() !== existing.startsAt.getTime() || endsAt.getTime() !== existing.endsAt.getTime();

    // Re-validate only when the time window actually changes.
    if (moved) await assertBookable(existing.clinicId, startsAt, endsAt, { excludeId: existing.id });

    const appt = await prisma.appointment.update({
      where: { id: existing.id },
      data: { startsAt: patch.startsAt, endsAt: patch.endsAt, reason: patch.reason, status: patch.status },
    });
    const userId = currentUser(req).userId;
    if (moved) await eventFor(appt, 'RESCHEDULED', userId);
    if (patch.status && patch.status !== existing.status) await eventFor(appt, 'STATUS_CHANGED', userId);
    // A completed visit closes the follow-up tasks linked to it (FR-5.5.9).
    if (patch.status === 'COMPLETED') {
      await closeFollowUpsForCompletedAppointment(appt.id, userId, actorFromRequest(req));
    }
    res.json(appt);
  }),
);

/** DELETE /api/appointments/:id — cancel with a reason; appointments are never hard-deleted. */
appointmentsRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(appointmentCancelSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadAppointment(req);
    if (existing.status === 'CANCELLED') throw badRequest('Appointment is already cancelled');
    const { reason } = req.body as AppointmentCancel;
    const appt = await prisma.appointment.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED', cancelReason: reason },
    });
    await eventFor(appt, 'CANCELLED', currentUser(req).userId, reason);
    res.json(appt);
  }),
);
