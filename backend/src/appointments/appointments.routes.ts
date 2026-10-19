import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  appointmentCreateSchema,
  appointmentUpdateSchema,
  appointmentQuerySchema,
  idParamSchema,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, badRequest, conflict, notFound, validate } from '../http.js';
import { checkWithinOperatingHours } from './operatingHours.js';

export const appointmentsRouter = Router();

/** Reject if the requested window overlaps an existing (non-cancelled) appointment at the clinic. */
async function assertNoOverlap(
  clinicId: string,
  startsAt: Date,
  endsAt: Date,
  excludeId?: string,
): Promise<void> {
  const overlap = await prisma.appointment.findFirst({
    where: {
      clinicId,
      id: excludeId ? { not: excludeId } : undefined,
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
  });
  if (overlap) throw conflict('Appointment overlaps an existing booking');
}

/** Validate the window against the clinic's operating hours. */
async function assertWithinHours(clinicId: string, startsAt: Date, endsAt: Date): Promise<void> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: { schedules: true },
  });
  if (!clinic) throw notFound('Clinic not found');

  const result = checkWithinOperatingHours(
    startsAt,
    endsAt,
    clinic.schedules.map((s) => ({
      dayOfWeek: s.dayOfWeek,
      openTime: s.openTime,
      closeTime: s.closeTime,
    })),
    clinic.timezone,
  );
  if (!result.ok) throw badRequest(result.reason);
}

/** GET /api/appointments — filterable list. */
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
      clinicId: q.clinicId,
      patientId: q.patientId,
      status: q.status,
    };
    if (q.from || q.to) {
      where.startsAt = {};
      if (q.from) (where.startsAt as Prisma.DateTimeFilter).gte = q.from;
      if (q.to) (where.startsAt as Prisma.DateTimeFilter).lte = q.to;
    }
    const items = await prisma.appointment.findMany({
      where,
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
    const appt = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appt) throw notFound('Appointment not found');
    res.json(appt);
  }),
);

/** POST /api/appointments — create with operating-hours + overlap checks. */
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
      status: Prisma.AppointmentCreateInput['status'];
    };
    await assertWithinHours(data.clinicId, data.startsAt, data.endsAt);
    await assertNoOverlap(data.clinicId, data.startsAt, data.endsAt);

    const appt = await prisma.appointment.create({
      data: {
        clinicId: data.clinicId,
        patientId: data.patientId,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        reason: data.reason,
        status: data.status,
      },
    });
    res.status(201).json(appt);
  }),
);

/** PATCH /api/appointments/:id — reschedule / restatus with re-validation. */
appointmentsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(appointmentUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Appointment not found');

    const patch = req.body as {
      startsAt?: Date;
      endsAt?: Date;
      reason?: string;
      status?: Prisma.AppointmentUpdateInput['status'];
    };
    const startsAt = patch.startsAt ?? existing.startsAt;
    const endsAt = patch.endsAt ?? existing.endsAt;

    // Re-validate only when the time window actually changes.
    if (patch.startsAt || patch.endsAt) {
      await assertWithinHours(existing.clinicId, startsAt, endsAt);
      await assertNoOverlap(existing.clinicId, startsAt, endsAt, existing.id);
    }

    const appt = await prisma.appointment.update({
      where: { id: req.params.id },
      data: {
        startsAt: patch.startsAt,
        endsAt: patch.endsAt,
        reason: patch.reason,
        status: patch.status,
      },
    });
    res.json(appt);
  }),
);

/** DELETE /api/appointments/:id. */
appointmentsRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.appointment.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);
