import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { idSchema } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { actorFromRequest, auditPatientChange, recordAudit, type AuditActor } from '../audit/record.js';
import type { AuditTx } from '../audit/audit.service.js';
import { currentUser } from '../auth/guards.js';
import { asyncHandler, badRequest, conflict, notFound, validate } from '../http.js';
import { drugReferenceSchema, getDrugReference, parseDrugReference } from './drugReference.js';

export async function activeReference(db: AuditTx = prisma) {
  const latest = await db.medicationReference.findFirst({ orderBy: { version: 'desc' } });
  return latest ? parseDrugReference(latest.data) : getDrugReference();
}

export function lockPatient(tx: AuditTx, id: string) {
  return tx.$queryRaw`SELECT "id" FROM "Patient" WHERE "id" = ${id} FOR UPDATE`;
}

// The original tablet instructed patients to separate medicines with commas.
function medicineItems(raw: Prisma.JsonValue) {
  const text = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.medications : null;
  return typeof text === 'string' ? text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) : [];
}

export async function decideItem(tx: AuditTx, actor: AuditActor, item: { submissionId: string; itemIndex: number },
  patientId: string, medication?: { id: string; clinicId: string }) {
  const submission = await tx.tabletIntakeSubmission.findUnique({ where: { id: item.submissionId },
    select: { patientId: true, rawPayload: true, session: { select: { clinicId: true } } } });
  if (!submission || submission.patientId !== patientId || !medicineItems(submission.rawPayload)[item.itemIndex]) {
    throw notFound('Reported medicine not found');
  }
  if (medication && medication.clinicId !== submission.session.clinicId) throw badRequest('Use the clinic where the medicine was reported');
  await tx.reportedMedicineDecision.create({ data: { ...item, decidedById: actor.userId!, medicationId: medication?.id } });
  await auditPatientChange(tx, actor, 'REPORTED_MEDICINE_DECIDED', 'TabletIntakeSubmission',
    { id: item.submissionId, patientId, clinicId: submission.session.clinicId },
    { itemIndex: item.itemIndex, decision: medication ? 'ADDED' : 'DISMISSED', medicationId: medication?.id ?? null });
}

// Mounted inside the Doctor-only medications router.
export const reviewRouter = Router();
reviewRouter.get('/reported', validate(z.object({ patientId: idSchema }), 'query'), asyncHandler(async (req, res) => {
  const rows = await prisma.tabletIntakeSubmission.findMany({ where: { patientId: String(req.query.patientId) },
    orderBy: { createdAt: 'desc' }, select: { id: true, rawPayload: true, createdAt: true,
      medicineDecisions: { select: { itemIndex: true } }, session: { select: { clinicId: true } } } });
  res.json({ items: rows.flatMap((s) => medicineItems(s.rawPayload).flatMap((name, itemIndex) =>
    s.medicineDecisions.some((d) => d.itemIndex === itemIndex) ? [] :
      [{ submissionId: s.id, clinicId: s.session.clinicId, itemIndex, name, reportedAt: s.createdAt }])) });
}));
reviewRouter.post('/reported/dismiss', validate(z.object({ patientId: idSchema, submissionId: idSchema, itemIndex: z.number().int().nonnegative() })),
  asyncHandler(async (req, res) => {
    const { patientId, ...item } = req.body;
    await prisma.$transaction((tx) => decideItem(tx, actorFromRequest(req), item, patientId));
    res.status(204).end();
  }));
reviewRouter.get('/reference', asyncHandler(async (_req, res) => { res.json(await activeReference()); }));
const publish = drugReferenceSchema.pick({ drugs: true, classes: true }).extend({ expectedVersion: z.number().int().positive() });
reviewRouter.post('/reference', validate(publish), asyncHandler(async (req, res) => {
  const data = await prisma.$transaction(async (tx) => {
    const existing = await activeReference(tx);
    if (existing.version !== req.body.expectedVersion) throw conflict('The lookup changed. Reload before approving.');
    const version = existing.version + 1;
    const approval = { approvedAt: new Date().toISOString(), approvedBy: currentUser(req).userId };
    let reference;
    try { reference = parseDrugReference({ version, approval, drugs: req.body.drugs, classes: req.body.classes }); }
    catch { throw badRequest('Every referenced class must exist in the submitted lookup'); }
    await tx.medicationReference.create({ data: { version, data: reference, approvedById: approval.approvedBy } });
    await recordAudit(actorFromRequest(req), { action: 'MEDICATION_REFERENCE_APPROVED', resourceType: 'MedicationReference',
      resourceId: String(version), metadata: { previousVersion: existing.version, version } }, tx);
    return reference;
  });
  res.status(201).json(data);
}));
