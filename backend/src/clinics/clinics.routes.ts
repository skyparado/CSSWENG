import { Router } from 'express';
import {
  clinicCreateSchema,
  clinicUpdateSchema,
  clinicScheduleReplaceSchema,
  idParamSchema,
  paginationSchema,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, notFound, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';

export const clinicsRouter = Router();

// Every clinic endpoint requires an authenticated user; mutations and
// schedule changes additionally require the Doctor role.
clinicsRouter.use(requireAuth);

/** GET /api/clinics — paginated list. */
clinicsRouter.get(
  '/',
  validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as {
      page: number;
      pageSize: number;
    };
    const [items, total] = await Promise.all([
      prisma.clinic.findMany({
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.clinic.count(),
    ]);
    res.json({ items, total, page, pageSize });
  }),
);

/** GET /api/clinics/:id — one clinic with its weekly schedule. */
clinicsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.params.id },
      include: { schedules: { orderBy: [{ dayOfWeek: 'asc' }, { openTime: 'asc' }] } },
    });
    if (!clinic) throw notFound('Clinic not found');
    res.json(clinic);
  }),
);

/** POST /api/clinics — create. */
clinicsRouter.post(
  '/',
  requireDoctor,
  validate(clinicCreateSchema),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.create({ data: req.body });
    res.status(201).json(clinic);
  }),
);

/** PATCH /api/clinics/:id — update. */
clinicsRouter.patch(
  '/:id',
  requireDoctor,
  validate(idParamSchema, 'params'),
  validate(clinicUpdateSchema),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(clinic);
  }),
);

/** DELETE /api/clinics/:id. */
clinicsRouter.delete(
  '/:id',
  requireDoctor,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.clinic.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

/* ------------------------------- Schedules --------------------------------- */

/** GET /api/clinics/:id/schedule. */
clinicsRouter.get(
  '/:id/schedule',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.id } });
    if (!clinic) throw notFound('Clinic not found');
    const schedules = await prisma.clinicSchedule.findMany({
      where: { clinicId: req.params.id },
      orderBy: [{ dayOfWeek: 'asc' }, { openTime: 'asc' }],
    });
    res.json({ clinicId: req.params.id, schedules });
  }),
);

/** PUT /api/clinics/:id/schedule — replace the full weekly schedule. */
clinicsRouter.put(
  '/:id/schedule',
  requireDoctor,
  validate(idParamSchema, 'params'),
  validate(clinicScheduleReplaceSchema),
  asyncHandler(async (req, res) => {
    const clinicId = req.params.id;
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) throw notFound('Clinic not found');

    const { schedules } = req.body as { schedules: Array<{ dayOfWeek: number; openTime: string; closeTime: string }> };

    const result = await prisma.$transaction(async (tx) => {
      await tx.clinicSchedule.deleteMany({ where: { clinicId } });
      if (schedules.length > 0) {
        await tx.clinicSchedule.createMany({
          data: schedules.map((s) => ({ ...s, clinicId })),
        });
      }
      return tx.clinicSchedule.findMany({
        where: { clinicId },
        orderBy: [{ dayOfWeek: 'asc' }, { openTime: 'asc' }],
      });
    });

    res.json({ clinicId, schedules: result });
  }),
);
