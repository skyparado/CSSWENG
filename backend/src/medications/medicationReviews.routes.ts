import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  medicationReviewCreateSchema,
  medicationReviewQuerySchema,
  type MedicationReviewCreate,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, notFound, validate } from '../http.js';
import { clinicForWrite, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit } from '../audit/record.js';
import { decryptOpt, encryptOpt } from '../lib/fieldCrypto.js';

/**
 * Medication review per visit: the Doctor confirms, at a visit, that the
 * patient's medication list is current. Doctor only, like the rest of S10.
 * Reviews are append-only; each one is audited.
 */
export const medicationReviewsRouter = Router();
medicationReviewsRouter.use(requireAuth, requireRole('DOCTOR'));

const include = { reviewedBy: { select: { fullName: true } } } satisfies Prisma.MedicationReviewInclude;
type Row = Prisma.MedicationReviewGetPayload<{ include: typeof include }>;
const toView = (row: Row) => ({ ...row, note: decryptOpt(row.note) });

/** GET /api/medication-reviews?patientId= — the latest reviews, newest first. */
medicationReviewsRouter.get(
  '/',
  validate(medicationReviewQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { patientId } = req.query as { patientId: string };
    const rows = await prisma.medicationReview.findMany({
      where: { patientId },
      include,
      orderBy: { reviewedAt: 'desc' },
      take: 20,
    });
    res.json({ items: rows.map(toView) });
  }),
);

/** POST /api/medication-reviews — mark the patient's current medication list as reviewed. */
medicationReviewsRouter.post(
  '/',
  validate(medicationReviewCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as MedicationReviewCreate;
    const clinicId = clinicForWrite(req);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient || patient.voidedAt) throw notFound('Patient not found');

    const review = await prisma.$transaction(async (tx) => {
      const activeCount = await tx.medication.count({
        where: { patientId: body.patientId, isCurrent: true, status: { not: 'DISCONTINUED' } },
      });
      const row = await tx.medicationReview.create({
        data: {
          patientId: body.patientId,
          clinicId,
          activeCount,
          note: encryptOpt(body.note || null),
          reviewedById: currentUser(req).userId,
        },
        include,
      });
      await recordAudit(
        actorFromRequest(req),
        {
          action: AuditActions.MEDICATION_LIST_REVIEWED,
          resourceType: 'MedicationReview',
          resourceId: row.id,
          // The note may hold clinical detail, so only note that one was given.
          metadata: { patientId: row.patientId, clinicId, activeCount, noteGiven: Boolean(body.note) },
        },
        tx,
      );
      return row;
    });
    res.status(201).json(toView(review));
  }),
);
