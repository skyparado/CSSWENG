import { Router } from 'express';
import type { AllergySeverity } from '@prisma/client';
import {
  allergyCreateSchema,
  allergyQuerySchema,
  allergyUpdateSchema,
  allergyVoidSchema,
  idParamSchema,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import { clinicForWrite, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { findAllergyConflicts } from './medicationSafety.js';

export const allergiesRouter = Router();

// Allergies are clinical data: Doctor only (SDD Table 7-1).
allergiesRouter.use(requireAuth, requireRole('DOCTOR'));

/** Alerts for the patient's current medications that conflict with an allergy. */
async function conflictingMedications(patientId: string, allergy: Parameters<typeof findAllergyConflicts>[1][number]) {
  const current = await prisma.medication.findMany({
    where: { patientId, isCurrent: true, status: { not: 'DISCONTINUED' } },
  });
  return current.flatMap((m) =>
    findAllergyConflicts(m.medicationName, [allergy]).map((a) => ({ ...a, relatedId: m.id })),
  );
}

/** GET /api/allergies?patientId= — recorded allergies, most severe first. */
allergiesRouter.get(
  '/',
  validate(allergyQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { patientId: string; includeVoided: boolean };
    const items = await prisma.allergy.findMany({
      where: { patientId: q.patientId, voidedAt: q.includeVoided ? undefined : null },
      orderBy: [{ severity: { sort: 'desc', nulls: 'last' } }, { recordedAt: 'desc' }],
    });
    res.json({ items });
  }),
);

/**
 * POST /api/allergies — record an allergy. The response also lists any of the
 * patient's current medications that conflict with it.
 */
allergiesRouter.post(
  '/',
  validate(allergyCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      patientId: string;
      clinicId?: string;
      allergenName: string;
      reaction?: string;
      severity?: AllergySeverity;
    };
    const clinicId = clinicForWrite(req, body.clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    const allergy = await prisma.allergy.create({
      data: { ...body, clinicId, recordedById: currentUser(req).userId },
    });
    const alerts = await conflictingMedications(body.patientId, allergy);
    res.status(201).json({ allergy, alerts });
  }),
);

/** PATCH /api/allergies/:id — correct the allergen, reaction or severity. */
allergiesRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(allergyUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.allergy.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Allergy not found');
    if (existing.voidedAt) throw conflict('This allergy was voided');

    const allergy = await prisma.allergy.update({ where: { id: existing.id }, data: req.body });
    const alerts = await conflictingMedications(existing.patientId, allergy);
    res.json({ allergy, alerts });
  }),
);

/** POST /api/allergies/:id/void — remove an allergy from view, keeping the record and the reason. */
allergiesRouter.post(
  '/:id/void',
  validate(idParamSchema, 'params'),
  validate(allergyVoidSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.allergy.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Allergy not found');
    if (existing.voidedAt) throw conflict('Allergy already voided');

    const allergy = await prisma.allergy.update({
      where: { id: existing.id },
      data: { voidedAt: new Date(), voidReason: (req.body as { reason: string }).reason },
    });
    res.json(allergy);
  }),
);
