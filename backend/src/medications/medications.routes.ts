import { Router } from 'express';
import type { Medication, MedicationSource, MedicationStatus } from '@prisma/client';
import {
  idParamSchema,
  medicationCheckSchema,
  medicationCreateSchema,
  medicationQuerySchema,
  medicationUpdateSchema,
  type SafetyAlert,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import { clinicForWrite, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { toDateOnly } from '../followups/dates.js';
import { checkMedicationSafety } from './medicationSafety.js';

export const medicationsRouter = Router();

// Medications and allergies are clinical data: Doctor only (SDD Table 7-1).
medicationsRouter.use(requireAuth, requireRole('DOCTOR'));

/** Run the allergy and duplicate checks against the patient's recorded data. */
async function safetyAlertsFor(
  patientId: string,
  medicationName: string,
  excludeMedicationId?: string,
): Promise<SafetyAlert[]> {
  const [allergies, currentMedications] = await Promise.all([
    prisma.allergy.findMany({ where: { patientId, voidedAt: null } }),
    prisma.medication.findMany({ where: { patientId, isCurrent: true } }),
  ]);
  return checkMedicationSafety({
    medicationName,
    allergies,
    currentMedications,
    excludeMedicationId,
  });
}

/** Refuse with the alerts unless the Doctor acknowledged them (FR-5.6.7). */
function requireAcknowledgement(alerts: SafetyAlert[], acknowledged: boolean) {
  if (alerts.length > 0 && !acknowledged) {
    throw conflict('Medication safety alerts must be acknowledged', { alerts });
  }
}

/** GET /api/medications?patientId= — the current list (or full dated history). */
medicationsRouter.get(
  '/',
  validate(medicationQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      patientId: string;
      status?: MedicationStatus;
      includeHistory: boolean;
    };
    const items = await prisma.medication.findMany({
      where: {
        patientId: q.patientId,
        status: q.status,
        isCurrent: q.includeHistory ? undefined : true,
      },
      orderBy: [{ recordedAt: 'desc' }],
    });
    res.json({ items });
  }),
);

/** POST /api/medications/check — preview the safety alerts without saving anything. */
medicationsRouter.post(
  '/check',
  validate(medicationCheckSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      patientId: string;
      medicationName: string;
      excludeMedicationId?: string;
    };
    const alerts = await safetyAlertsFor(body.patientId, body.medicationName, body.excludeMedicationId);
    res.json({ alerts });
  }),
);

/** GET /api/medications/:id/history — every version of this medication, oldest first. */
medicationsRouter.get(
  '/:id/history',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const start = await prisma.medication.findUnique({ where: { id: req.params.id } });
    if (!start) throw notFound('Medication not found');

    const all = await prisma.medication.findMany({ where: { patientId: start.patientId } });
    const byId = new Map(all.map((m) => [m.id, m]));
    const bySupersedes = new Map(
      all.filter((m) => m.supersedesMedicationId).map((m) => [m.supersedesMedicationId as string, m]),
    );

    let head: Medication = start;
    while (head.supersedesMedicationId && byId.has(head.supersedesMedicationId)) {
      head = byId.get(head.supersedesMedicationId) as Medication;
    }
    const chain: Medication[] = [];
    for (let m: Medication | undefined = head; m; m = bySupersedes.get(m.id)) chain.push(m);
    res.json({ items: chain });
  }),
);

/** POST /api/medications — record a medication, after the safety check. */
medicationsRouter.post(
  '/',
  validate(medicationCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      patientId: string;
      clinicId?: string;
      medicationName: string;
      strength?: string;
      dose: string;
      frequency: string;
      route: string;
      instructions?: string;
      indication?: string;
      startDate: string;
      endDate?: string;
      status: MedicationStatus;
      discontinuationReason?: string;
      prescribingDoctor: string;
      source: MedicationSource;
      documentId?: string;
      acknowledgeAlerts: boolean;
    };
    const clinicId = clinicForWrite(req, body.clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    // A discontinued entry is history, not something being taken: nothing to warn about.
    if (body.status !== 'DISCONTINUED') {
      const alerts = await safetyAlertsFor(body.patientId, body.medicationName);
      requireAcknowledgement(alerts, body.acknowledgeAlerts);
    }

    const { acknowledgeAlerts: _ack, startDate, endDate, ...rest } = body;
    const medication = await prisma.medication.create({
      data: {
        ...rest,
        clinicId,
        startDate: toDateOnly(startDate),
        endDate: endDate ? toDateOnly(endDate) : undefined,
        recordedById: currentUser(req).userId,
      },
    });
    res.status(201).json(medication);
  }),
);

/**
 * PATCH /api/medications/:id — change a medication. Inserts a new version that
 * supersedes this one; the old row is kept as history (FR-5.6.4).
 */
medicationsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(medicationUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.medication.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Medication not found');
    if (!existing.isCurrent) throw conflict('This version was already superseded; edit the latest one');

    const { acknowledgeAlerts, startDate, endDate, ...patch } = req.body as {
      acknowledgeAlerts: boolean;
      startDate?: string;
      endDate?: string;
      medicationName?: string;
      status?: MedicationStatus;
      discontinuationReason?: string;
    } & Record<string, unknown>;

    const next = { ...existing, ...stripUndefined(patch) } as Medication;

    // Re-check only when the drug changes or the medication becomes active again.
    const reactivated = next.status !== 'DISCONTINUED' && existing.status === 'DISCONTINUED';
    const renamed = next.medicationName !== existing.medicationName;
    if (next.status !== 'DISCONTINUED' && (renamed || reactivated)) {
      const alerts = await safetyAlertsFor(existing.patientId, next.medicationName, existing.id);
      requireAcknowledgement(alerts, acknowledgeAlerts);
    }

    const {
      id: _id,
      recordedAt: _recordedAt,
      supersedesMedicationId: _supersedes,
      isCurrent: _isCurrent,
      ...carried
    } = next;

    const [, created] = await prisma.$transaction([
      prisma.medication.update({ where: { id: existing.id }, data: { isCurrent: false } }),
      prisma.medication.create({
        data: {
          ...carried,
          startDate: startDate ? toDateOnly(startDate) : existing.startDate,
          endDate: endDate ? toDateOnly(endDate) : existing.endDate,
          supersedesMedicationId: existing.id,
          recordedById: currentUser(req).userId,
        },
      }),
    ]);
    res.json(created);
  }),
);

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
