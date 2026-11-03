import { Router } from 'express';
import { z } from 'zod';
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

const clinicListQuerySchema = paginationSchema.extend({
  includeInactive: z.enum(['true', 'false']).optional(),
});

// Every clinic endpoint requires an authenticated user; mutations and
// schedule changes additionally require the Doctor role.
clinicsRouter.use(requireAuth);

/** GET /api/clinics — paginated list of active clinics; `?includeInactive=true` lists all. */
clinicsRouter.get(
  '/',
  validate(clinicListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, includeInactive } = req.query as unknown as {
      page: number;
      pageSize: number;
      includeInactive?: 'true' | 'false';
    };
    const where = includeInactive === 'true' ? {} : { isActive: true };
    const [items, total] = await Promise.all([
      prisma.clinic.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.clinic.count({ where }),
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

/** POST /api/clinics/:id/deactivate — clinics are never deleted; their records must survive. */
clinicsRouter.post(
  '/:id/deactivate',
  requireDoctor,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const clinic = await prisma.clinic.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json(clinic);
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
