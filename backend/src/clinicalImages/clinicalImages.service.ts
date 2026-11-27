import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ImageAnnotation } from '@prisma/client';
import { eyeTemplateLabels, type EyeTemplate, type ImageContext, type ImageListQuery, type ImageUploadMetadata } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { badRequest, HttpError, notFound } from '../http.js';
import { encrypt, decrypt } from '../lib/fieldCrypto.js';
import { writeAudit, type AuditTx } from '../audit/audit.service.js';
import { AuditActions } from '../audit/actions.js';
import { deleteObject, putObjectEncrypted } from './s3Client.js';

export type ImageActor = { userId: string; clinicId: string };
type Source = ImageUploadMetadata & { fileName: string; mimeType: string; bytes: Buffer };
type Template = { templateType: EyeTemplate; commitKey: string; konvaData: unknown };

function audit(tx: AuditTx, actor: ImageActor, action: string, id: string | null, metadata: Record<string, unknown>) {
  return writeAudit({ userId: actor.userId, userRole: 'DOCTOR', userEmail: null, action,
    resourceType: 'CLINICAL_IMAGE', resourceId: id, method: null, path: null, statusCode: null,
    ipAddress: null, userAgent: null, metadata: { ...metadata, clinicId: actor.clinicId } }, tx);
}

export function templateBytes(type: EyeTemplate) {
  return readFile(new URL(`../../assets/eye-templates/${type}.svg`, import.meta.url));
}

export async function requireOpenVisit(db: AuditTx, context: ImageContext, actor: ImageActor) {
  const visit = await db.encounter.findFirst({ where: { id: context.visitId, patientId: context.patientId, patient: { voidedAt: null } } });
  if (!visit) throw notFound('Visit not found for this patient');
  if (visit.clinicId !== actor.clinicId) throw new HttpError(403, 'Select the clinic for this visit');
  if (visit.status !== 'OPEN') throw new HttpError(409, 'This visit has been signed');
  return visit;
}

export async function selectTemplate(context: ImageContext, type: EyeTemplate, actor: ImageActor) {
  await prisma.$transaction(async tx => {
    await requireOpenVisit(tx, context, actor);
    await audit(tx, actor, 'IMAGE_TEMPLATE_SELECTED', null, { ...context, templateType: type });
  });
  return templateBytes(type);
}

async function resolveVisit(tx: AuditTx, input: ImageUploadMetadata, actor: ImageActor) {
  // Encounter inserts take this lock too. A concurrent visit and pre-visit upload
  // therefore both see the same committed appointment or walk-in batch.
  const patient = await tx.$queryRaw<{id: string}[]>`SELECT id FROM "Patient" WHERE id = ${input.patientId} AND "voidedAt" IS NULL FOR UPDATE`;
  if (!patient.length) throw notFound('Patient not found');
  if (input.walkInKey && (input.visitId || input.appointmentId)) throw badRequest('Choose one visit context');
  if (input.appointmentId) {
    const appt = await tx.appointment.findFirst({ where: { id: input.appointmentId, patientId: input.patientId, clinicId: actor.clinicId } });
    if (!appt) throw notFound('Appointment not found for this patient and clinic');
  }
  const inferred = input.visitId ? null : input.appointmentId || input.walkInKey
    ? await tx.encounter.findFirst({ where: input.appointmentId ? { appointmentId: input.appointmentId } : { walkInKey: input.walkInKey } })
    : null;
  const visitId = input.visitId ?? inferred?.id ?? null;
  if (!visitId) return { visitId, appointmentId: input.appointmentId ?? null };
  // Share lock keeps note signing and a clinical write in a consistent order.
  await tx.$queryRaw`SELECT id FROM "Encounter" WHERE id = ${visitId} FOR SHARE`;
  const visit = await requireOpenVisit(tx, { patientId: input.patientId, visitId }, actor);
  if (input.appointmentId && visit.appointmentId !== input.appointmentId) throw badRequest('Visit and appointment do not match');
  return { visitId, appointmentId: visit.appointmentId };
}

function annotationDTO(row: ImageAnnotation) {
  // Earlier versions stored a JSON object. New and backfilled versions store
  // an AES-GCM envelope in the same column.
  return { ...row, konvaData: typeof row.konvaData === 'string' ? JSON.parse(decrypt(row.konvaData)) : row.konvaData };
}

async function appendLayer(tx: AuditTx, id: string, data: unknown, actor: ImageActor) {
  const latest = await tx.imageAnnotation.findFirst({ where: { clinicalImageId: id }, orderBy: { version: 'desc' }, select: { version: true } });
  const layer = await tx.imageAnnotation.create({ data: { clinicalImageId: id, createdById: actor.userId,
    version: (latest?.version ?? 0) + 1, konvaData: encrypt(JSON.stringify(data)) } });
  await audit(tx, actor, AuditActions.IMAGE_ANNOTATION_SAVED, id, { version: layer.version, annotationId: layer.id });
  return annotationDTO(layer);
}

export async function createImage(input: Source, actor: ImageActor, template?: Template) {
  const id = 'clim_' + randomUUID();
  // Names and captions can contain patient information. Keep both out of object keys.
  const key = `patients/${input.patientId}/${id}/base`;
  let attemptedUpload = false;
  try {
    return await prisma.$transaction(async tx => {
      if (template) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${template.commitKey}, 0))`;
        const previous = await tx.clinicalImage.findUnique({ where: { commitKey: template.commitKey } });
        if (previous) {
          if (previous.patientId !== input.patientId || previous.visitId !== input.visitId ||
              previous.templateType !== template.templateType || previous.uploadedById !== actor.userId ||
              previous.clinicId !== actor.clinicId || previous.status !== 'ACTIVE') throw new HttpError(409, 'Drawing commit belongs to another context');
          return previous;
        }
      }
      const visit = await resolveVisit(tx, input, actor);
      const row = await tx.clinicalImage.create({ data: {
        id, ...visit, patientId: input.patientId, clinicId: actor.clinicId, uploadedById: actor.userId,
        walkInKey: input.walkInKey ?? (!visit.visitId && !visit.appointmentId ? randomUUID() : null),
        templateType: template?.templateType, commitKey: template?.commitKey,
        storageKey: key, fileName: input.fileName, mimeType: input.mimeType,
        sizeBytes: input.bytes.length, caption: input.caption,
      } });
      attemptedUpload = true;
      await putObjectEncrypted(key, input.bytes, input.mimeType);
      await audit(tx, actor, AuditActions.CLINICAL_IMAGE_UPLOADED, id, { patientId: row.patientId, visitId: row.visitId,
        appointmentId: row.appointmentId, templateType: row.templateType, sizeBytes: row.sizeBytes });
      if (template) await appendLayer(tx, id, template.konvaData, actor);
      return row;
    }, { timeout: 60000 });
  } catch (error) {
    // Each attempt has its own object key, including concurrent retries. Confirm
    // rollback before cleanup so an uncertain commit cannot destroy a saved base.
    if (attemptedUpload && !(await prisma.clinicalImage.findUnique({ where: { id }, select: { id: true } }))) await deleteObject(key);
    throw error;
  }
}

export async function commitTemplate(input: Required<ImageContext> & Template, actor: ImageActor) {
  return createImage({ ...input, fileName: input.templateType + '.svg', mimeType: 'image/svg+xml',
    bytes: await templateBytes(input.templateType), caption: eyeTemplateLabels[input.templateType] }, actor, input);
}

export async function listImages(query: ImageListQuery) {
  const { patientId, appointmentId, visitId, status, page, pageSize } = query;
  const where = { patientId, appointmentId, visitId, status, patient: { voidedAt: null } };
  const [items, total] = await Promise.all([
    prisma.clinicalImage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.clinicalImage.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function getImage(id: string, context: ImageContext, includeRemoved = false, db: AuditTx = prisma) {
  const image = await db.clinicalImage.findFirst({ where: { id, patientId: context.patientId, visitId: context.visitId, patient: { voidedAt: null },
    ...(includeRemoved ? {} : { status: 'ACTIVE' as const }) } });
  if (!image) throw notFound('Image not found in this chart');
  return image;
}

export async function changeImage(id: string, context: ImageContext, actor: ImageActor,
  change: { action: 'annotate'; data: unknown } | { action: 'caption'; caption: string | null } | { action: 'remove' }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ClinicalImage" WHERE id = ${id} AND "patientId" = ${context.patientId} FOR UPDATE`;
    const row = await getImage(id, context, false, tx);
    if (row.clinicId && row.clinicId !== actor.clinicId) throw new HttpError(403, 'Select the clinic for this image');
    if (row.visitId) {
      await tx.$queryRaw`SELECT id FROM "Encounter" WHERE id = ${row.visitId} FOR SHARE`;
      await requireOpenVisit(tx, { patientId: row.patientId, visitId: row.visitId }, actor);
    }
    if (change.action === 'annotate') {
      if (row.mimeType === 'application/pdf') throw badRequest('PDFs are view only');
      return appendLayer(tx, id, change.data, actor);
    }
    const updated = await tx.clinicalImage.update({ where: { id },
      data: change.action === 'remove' ? { status: 'DELETED' } : { caption: change.caption } });
    await audit(tx, actor, change.action === 'remove' ? AuditActions.CLINICAL_IMAGE_DELETED : AuditActions.CLINICAL_IMAGE_UPDATED,
      id, { patientId: row.patientId, visitId: row.visitId });
    return updated;
  }, { timeout: 15000 });
}

export async function listAnnotations(id: string, context: ImageContext, latestOnly = false) {
  await getImage(id, context);
  const rows = await prisma.imageAnnotation.findMany({ where: { clinicalImageId: id }, orderBy: { version: 'desc' }, take: latestOnly ? 1 : undefined });
  return rows.map(annotationDTO);
}
