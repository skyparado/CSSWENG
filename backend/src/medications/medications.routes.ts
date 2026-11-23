import { Router, type Request } from 'express';
import { Prisma, type Medication, type MedicationStatus } from '@prisma/client';
import {
  idParamSchema,
  medicationCheckSchema,
  medicationCreateSchema,
  medicationQuerySchema,
  medicationUpdateSchema,
  type AcknowledgedAlert,
  type SafetyAlert,
  type MedicationCreate,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import { clinicForWrite, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { toDateOnly } from '../followups/dates.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit, auditPatientChange } from '../audit/record.js';
import type { AuditTx } from '../audit/audit.service.js';
import { checkMedicationSafety } from './medicationSafety.js';
import { type DrugReference } from './drugReference.js';
import { activeReference, decideItem, lockPatient, reviewRouter } from './review.js';

export const medicationsRouter = Router();

// Medications and allergies are clinical data: Doctor only (SDD Table 7-1).
medicationsRouter.use(requireAuth, requireRole('DOCTOR'), reviewRouter);

/** Run the allergy and duplicate checks against the patient's recorded data. */
async function safetyAlertsFor(
  patientId: string,
  medicationName: string,
  excludeMedicationId?: string,
  db: AuditTx = prisma,
  reference?: DrugReference,
): Promise<SafetyAlert[]> {
  const [allergies, currentMedications] = await Promise.all([
    db.allergy.findMany({ where: { patientId, voidedAt: null } }),
    db.medication.findMany({ where: { patientId, isCurrent: true } }),
  ]);
  return checkMedicationSafety({
    medicationName,
    allergies,
    currentMedications,
    reference: reference ?? await activeReference(db),
    excludeMedicationId,
  });
}

/** What is saved on a medication row when the Doctor accepted safety alerts. */
interface StoredAcknowledgement {
  acknowledgedAt: string;
  acknowledgedById: string;
  referenceVersion: number;
  /** Why the Doctor proceeded despite the alerts, if they said. */
  reason?: string;
  alerts: SafetyAlert[];
}

/**
 * Refuse with the alerts unless the Doctor acknowledged them (FR-5.6.7).
 *
 * The alerts that get saved are the ones the SERVER just computed, never text
 * from the client. The list must cover each current alert. A blanket flag
 * cannot acknowledge an alert that appeared since the Doctor saw the preview.
 *
 * Returns null when there was nothing to acknowledge.
 */
function acknowledge(
  alerts: SafetyAlert[],
  body: { acknowledgeAlerts: boolean; acknowledgedAlerts?: AcknowledgedAlert[]; acknowledgementReason?: string },
  doctorId: string,
  referenceVersion: number,
): StoredAcknowledgement | null {
  if (alerts.length === 0) return null;

  const listed = body.acknowledgedAlerts;
  const accepted = listed
    ? alerts.every((a) => listed.some((l) => l.type === a.type && l.relatedId === a.relatedId))
    : false;
  if (!accepted) {
    throw conflict('Medication safety alerts must be acknowledged', { alerts });
  }
  return {
    acknowledgedAt: new Date().toISOString(),
    acknowledgedById: doctorId,
    referenceVersion,
    ...(body.acknowledgementReason ? { reason: body.acknowledgementReason } : {}),
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
        change,
        referenceVersion: ack.referenceVersion,
        // The wording stays in the medication row; the audit log only notes that one was given.
        reasonGiven: Boolean(ack.reason),
        alerts: ack.alerts.map(({ type, relatedId }) => ({ type, relatedId })),
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
      include: { recordedBy: { select: { fullName: true } } },
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

    const all = await prisma.medication.findMany({ where: { patientId: start.patientId }, include: { recordedBy: { select: { fullName: true } } } });
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
    const body = req.body as MedicationCreate;
    const clinicId = clinicForWrite(req, body.clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    const {
      reportedItem,
      acknowledgeAlerts: _ack,
      acknowledgedAlerts: _acks,
      acknowledgementReason: _reason,
      startDate,
      endDate,
      ...rest
    } = body;
    const medication = await prisma.$transaction(async (tx) => {
      await lockPatient(tx, body.patientId);
      const reference = await activeReference(tx);
      const alerts = body.status === 'DISCONTINUED' && !reportedItem ? [] : await safetyAlertsFor(body.patientId, body.medicationName, undefined, tx, reference);
      const ack = acknowledge(alerts, body, currentUser(req).userId, reference.version);
      const created = await tx.medication.create({
        data: {
          ...rest,
          source: reportedItem ? 'PATIENT_REPORTED' : rest.source,
          clinicId,
          startDate: toDateOnly(startDate),
          endDate: endDate ? toDateOnly(endDate) : undefined,
          recordedById: currentUser(req).userId,
          lookupVersion: reference.version,
          safetyAcknowledgements: ack ? (ack as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
      if (ack) await auditAcknowledgement(req, tx, created, ack, 'CREATED');
      await auditPatientChange(tx, actorFromRequest(req), 'MEDICATION_CREATED', 'Medication', created);
      if (reportedItem) await decideItem(tx, actorFromRequest(req), reportedItem, body.patientId, created);
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

    const { acknowledgeAlerts, acknowledgedAlerts, acknowledgementReason, startDate, endDate, ...patch } = req.body as {
      acknowledgeAlerts: boolean;
      acknowledgedAlerts?: AcknowledgedAlert[];
      acknowledgementReason?: string;
      startDate?: string;
      endDate?: string;
      medicationName?: string;
      status?: MedicationStatus;
      discontinuationReason?: string;
    } & Record<string, unknown>;

    const next = { ...existing, ...stripUndefined(patch) } as Medication;

    medicationCreateSchema.parse({
      ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null)),
      startDate: startDate ?? existing.startDate.toISOString().slice(0, 10),
      endDate: endDate ?? existing.endDate?.toISOString().slice(0, 10),
    });

    // Re-check when the drug changes, or when the medication starts being taken
    // again: DISCONTINUED -> ACTIVE/ON_HOLD, or ON_HOLD -> ACTIVE. An allergy or
    // a duplicate may have been recorded while it was off the list.
    const renamed = next.medicationName !== existing.medicationName;
    const resumed =
      (existing.status === 'DISCONTINUED' && next.status !== 'DISCONTINUED') ||
      (existing.status === 'ON_HOLD' && next.status === 'ACTIVE');
    const rechecked = next.status !== 'DISCONTINUED' && (renamed || resumed);
    const {
      id: _id,
      recordedAt: _recordedAt,
      supersedesMedicationId: _supersedes,
      isCurrent: _isCurrent,
      ...carried
    } = next;

    const created = await prisma.$transaction(async (tx) => {
      await lockPatient(tx, existing.patientId);
      const reference = await activeReference(tx);
      let ack: StoredAcknowledgement | null = null;
      if (rechecked) {
        const alerts = await safetyAlertsFor(existing.patientId, next.medicationName, existing.id, tx, reference);
        ack = acknowledge(
          alerts,
          { acknowledgeAlerts, acknowledgedAlerts, acknowledgementReason },
          currentUser(req).userId,
          reference.version,
        );
      }
      await tx.medication.update({ where: { id: existing.id, isCurrent: true }, data: { isCurrent: false } });
      const version = await tx.medication.create({
        data: {
          ...carried,
          startDate: startDate ? toDateOnly(startDate) : existing.startDate,
          endDate: endDate ? toDateOnly(endDate) : existing.endDate,
          supersedesMedicationId: existing.id,
          recordedById: currentUser(req).userId,
          // An acknowledgement belongs to the save that made it; it is not inherited.
          safetyAcknowledgements: ack ? (ack as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          lookupVersion: rechecked ? reference.version : existing.lookupVersion,
        },
      });
      if (ack) await auditAcknowledgement(req, tx, version, ack, 'UPDATED');
      await auditPatientChange(tx, actorFromRequest(req), 'MEDICATION_UPDATED', 'Medication', version,
        { previousVersionId: existing.id, fields: Object.keys(req.body).filter((k) => !k.startsWith('acknowledge')) });
      return version;
    });
    res.json(created);
  }),
);

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
