import { Router, type Request } from 'express';
import { Prisma, type Medication, type MedicationSource, type MedicationStatus } from '@prisma/client';
import {
  idParamSchema,
  medicationCheckSchema,
  medicationCreateSchema,
  medicationQuerySchema,
  medicationUpdateSchema,
  type AcknowledgedAlert,
  type SafetyAlert,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import { clinicForWrite, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { toDateOnly } from '../followups/dates.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit } from '../audit/record.js';
import type { AuditTx } from '../audit/audit.service.js';
import { checkMedicationSafety } from './medicationSafety.js';
import { getDrugReference } from './drugReference.js';

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

/** What is saved on a medication row when the Doctor accepted safety alerts. */
interface StoredAcknowledgement {
  acknowledgedAt: string;
  acknowledgedById: string;
  referenceVersion: number;
  alerts: SafetyAlert[];
}

/**
 * Refuse with the alerts unless the Doctor acknowledged them (FR-5.6.7).
 *
 * The alerts that get saved are the ones the SERVER just computed, never text
 * from the client. Two ways to acknowledge:
 *  - `acknowledgedAlerts`: the specific alerts, which must cover every alert
 *    raised now (so an allergy added since the Doctor looked is not waved through);
 *  - `acknowledgeAlerts: true`: accept whatever the server raises for this save.
 *
 * Returns null when there was nothing to acknowledge.
 */
function acknowledge(
  alerts: SafetyAlert[],
  body: { acknowledgeAlerts: boolean; acknowledgedAlerts?: AcknowledgedAlert[] },
  doctorId: string,
): StoredAcknowledgement | null {
  if (alerts.length === 0) return null;

  const listed = body.acknowledgedAlerts;
  const accepted = listed
    ? alerts.every((a) => listed.some((l) => l.type === a.type && l.relatedId === a.relatedId))
    : body.acknowledgeAlerts;
  if (!accepted) {
    throw conflict('Medication safety alerts must be acknowledged', { alerts });
  }
  return {
    acknowledgedAt: new Date().toISOString(),
    acknowledgedById: doctorId,
    referenceVersion: getDrugReference().version,
    alerts,
  };
}

/** Audit the acknowledgement (doctor, alert details, timestamp) inside the saving transaction. */
function auditAcknowledgement(
  req: Request,
  tx: AuditTx,
  medication: Pick<Medication, 'id' | 'patientId' | 'clinicId' | 'medicationName'>,
  ack: StoredAcknowledgement,
  change: 'CREATED' | 'UPDATED',
) {
  return recordAudit(
    actorFromRequest(req),
    {
      action: AuditActions.MEDICATION_SAFETY_ALERTS_ACKNOWLEDGED,
      resourceType: 'Medication',
      resourceId: medication.id,
      metadata: {
        doctorId: ack.acknowledgedById,
        acknowledgedAt: ack.acknowledgedAt,
        patientId: medication.patientId,
        clinicId: medication.clinicId,
        medicationName: medication.medicationName,
        change,
        referenceVersion: ack.referenceVersion,
        alerts: ack.alerts as unknown as Prisma.InputJsonValue,
      },
    },
    tx,
  );
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
      acknowledgedAlerts?: AcknowledgedAlert[];
    };
    const clinicId = clinicForWrite(req, body.clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    // A discontinued entry is history, not something being taken: nothing to warn about.
    let ack: StoredAcknowledgement | null = null;
    if (body.status !== 'DISCONTINUED') {
      const alerts = await safetyAlertsFor(body.patientId, body.medicationName);
      ack = acknowledge(alerts, body, currentUser(req).userId);
    }

    const {
      acknowledgeAlerts: _ack,
      acknowledgedAlerts: _acks,
      startDate,
      endDate,
      ...rest
    } = body;
    const medication = await prisma.$transaction(async (tx) => {
      const created = await tx.medication.create({
        data: {
          ...rest,
          clinicId,
          startDate: toDateOnly(startDate),
          endDate: endDate ? toDateOnly(endDate) : undefined,
          recordedById: currentUser(req).userId,
          lookupVersion: getDrugReference().version,
          safetyAcknowledgements: ack ? (ack as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
      if (ack) await auditAcknowledgement(req, tx, created, ack, 'CREATED');
      return created;
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

    const { acknowledgeAlerts, acknowledgedAlerts, startDate, endDate, ...patch } = req.body as {
      acknowledgeAlerts: boolean;
      acknowledgedAlerts?: AcknowledgedAlert[];
      startDate?: string;
      endDate?: string;
      medicationName?: string;
      status?: MedicationStatus;
      discontinuationReason?: string;
    } & Record<string, unknown>;

    const next = { ...existing, ...stripUndefined(patch) } as Medication;

    // Re-check when the drug changes, or when the medication starts being taken
    // again: DISCONTINUED -> ACTIVE/ON_HOLD, or ON_HOLD -> ACTIVE. An allergy or
    // a duplicate may have been recorded while it was off the list.
    const renamed = next.medicationName !== existing.medicationName;
    const resumed =
      (existing.status === 'DISCONTINUED' && next.status !== 'DISCONTINUED') ||
      (existing.status === 'ON_HOLD' && next.status === 'ACTIVE');
    const rechecked = next.status !== 'DISCONTINUED' && (renamed || resumed);
    let ack: StoredAcknowledgement | null = null;
    if (rechecked) {
      const alerts = await safetyAlertsFor(existing.patientId, next.medicationName, existing.id);
      ack = acknowledge(alerts, { acknowledgeAlerts, acknowledgedAlerts }, currentUser(req).userId);
    }

    const {
      id: _id,
      recordedAt: _recordedAt,
      supersedesMedicationId: _supersedes,
      isCurrent: _isCurrent,
      ...carried
    } = next;

    const created = await prisma.$transaction(async (tx) => {
      await tx.medication.update({ where: { id: existing.id }, data: { isCurrent: false } });
      const version = await tx.medication.create({
        data: {
          ...carried,
          startDate: startDate ? toDateOnly(startDate) : existing.startDate,
          endDate: endDate ? toDateOnly(endDate) : existing.endDate,
          supersedesMedicationId: existing.id,
          recordedById: currentUser(req).userId,
          // An acknowledgement belongs to the save that made it; it is not inherited.
          safetyAcknowledgements: ack ? (ack as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          lookupVersion: rechecked ? getDrugReference().version : existing.lookupVersion,
        },
      });
      if (ack) await auditAcknowledgement(req, tx, version, ack, 'UPDATED');
      return version;
    });
    res.json(created);
  }),
);

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
