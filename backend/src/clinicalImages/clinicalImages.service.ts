import { randomBytes } from 'node:crypto';
import { prisma } from '../prisma.js';
import { badRequest, notFound } from '../http.js';
import {
  deleteObject,
  presignedGetUrl,
  putObjectEncrypted,
} from './s3Client.js';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  type AllowedImageMimeType,
  type ImageListQuery,
  type ImageUploadMetadata,
} from '@clinic/schemas';
import { writeAudit } from '../audit/audit.service.js';
import { AuditActions } from '../audit/actions.js';

const CLINICAL_IMAGE_RESOURCE = 'CLINICAL_IMAGE';

export type UploadInput = ImageUploadMetadata & {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  uploadedById: string | null;
  userEmail: string | null;
  userRole: string | null;
};

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildStorageKey(patientId: string, imageId: string, fileName: string): string {
  return `patients/${patientId}/${imageId}-${slug(fileName) || 'image'}`;
}

export async function uploadImage(input: UploadInput) {
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw badRequest(`Unsupported image type: ${input.mimeType}`);
  }
  if (input.bytes.byteLength > MAX_IMAGE_SIZE_BYTES) {
    throw badRequest(`Image exceeds ${MAX_IMAGE_SIZE_BYTES} bytes`);
  }

  const patient = await prisma.patient.findUnique({
    where: { id: input.patientId },
    select: { id: true },
  });
  if (!patient) throw notFound('Patient not found');

  if (input.appointmentId) {
    const appt = await prisma.appointment.findUnique({
      where: { id: input.appointmentId },
      select: { id: true, patientId: true },
    });
    if (!appt) throw notFound('Appointment not found');
    if (appt.patientId !== input.patientId) {
      throw badRequest('Appointment does not belong to the given patient');
    }
  }

  const imageId = `clim_${randomBytes(12).toString('base64url')}`;
  const storageKey = buildStorageKey(input.patientId, imageId, input.fileName);

  await putObjectEncrypted(
    storageKey,
    input.bytes,
    input.mimeType as AllowedImageMimeType,
  );

  const row = await prisma.clinicalImage.create({
    data: {
      id: imageId,
      patientId: input.patientId,
      appointmentId: input.appointmentId ?? null,
      uploadedById: input.uploadedById,
      storageKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      caption: input.caption ?? null,
      status: 'ACTIVE',
    },
  });

  await writeAudit({
    userId: input.uploadedById,
    userEmail: input.userEmail,
    userRole: input.userRole,
    action: AuditActions.CLINICAL_IMAGE_UPLOADED,
    resourceType: CLINICAL_IMAGE_RESOURCE,
    resourceId: imageId,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      patientId: input.patientId,
      appointmentId: input.appointmentId ?? null,
      sizeBytes: input.bytes.byteLength,
      mimeType: input.mimeType,
    },
  });

  return row;
}

export async function listImages(query: ImageListQuery) {
  const { patientId, appointmentId, status, page, pageSize } = query;
  const where = {
    ...(patientId ? { patientId } : {}),
    ...(appointmentId ? { appointmentId } : {}),
    status,
  };
  const [items, total] = await Promise.all([
    prisma.clinicalImage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.clinicalImage.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function getImage(id: string) {
  const image = await prisma.clinicalImage.findUnique({ where: { id } });
  if (!image || image.status === 'DELETED') throw notFound('Image not found');
  return image;
}

export async function getImageSignedUrl(id: string): Promise<{ url: string; expiresIn: number }> {
  const image = await getImage(id);
  const url = await presignedGetUrl(image.storageKey, 300);
  return { url, expiresIn: 300 };
}

export async function updateCaption(id: string, caption: string | null, actor: {
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
}) {
  const image = await getImage(id);
  const updated = await prisma.clinicalImage.update({
    where: { id: image.id },
    data: { caption },
  });
  await writeAudit({
    userId: actor.userId,
    userEmail: actor.userEmail,
    userRole: actor.userRole,
    action: AuditActions.CLINICAL_IMAGE_UPDATED,
    resourceType: CLINICAL_IMAGE_RESOURCE,
    resourceId: image.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: { caption },
  });
  return updated;
}

export async function softDeleteImage(id: string, actor: {
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
}) {
  const image = await getImage(id);
  await deleteObject(image.storageKey).catch(() => {
    // eslint-disable-next-line no-console
    console.warn(`S3 delete failed for ${image.storageKey}; continuing with soft-delete`);
  });
  const updated = await prisma.clinicalImage.update({
    where: { id: image.id },
    data: { status: 'DELETED' },
  });
  await writeAudit({
    userId: actor.userId,
    userEmail: actor.userEmail,
    userRole: actor.userRole,
    action: AuditActions.CLINICAL_IMAGE_DELETED,
    resourceType: CLINICAL_IMAGE_RESOURCE,
    resourceId: image.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: { storageKey: image.storageKey },
  });
  return updated;
}

/* ------------------------------- Annotations ------------------------------ */

export async function saveAnnotation(
  imageId: string,
  konvaData: unknown,
  actor: { userId: string | null; userEmail: string | null; userRole: string | null },
) {
  const image = await getImage(imageId);
  const latest = await prisma.imageAnnotation.findFirst({
    where: { clinicalImageId: image.id },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const row = await prisma.imageAnnotation.create({
    data: {
      clinicalImageId: image.id,
      createdById: actor.userId,
      version: nextVersion,
      konvaData: konvaData as any,
    },
  });

  await writeAudit({
    userId: actor.userId,
    userEmail: actor.userEmail,
    userRole: actor.userRole,
    action: AuditActions.IMAGE_ANNOTATION_SAVED,
    resourceType: CLINICAL_IMAGE_RESOURCE,
    resourceId: image.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: { version: nextVersion, annotationId: row.id },
  });

  return row;
}

export async function listAnnotations(imageId: string) {
  const image = await getImage(imageId);
  return prisma.imageAnnotation.findMany({
    where: { clinicalImageId: image.id },
    orderBy: { version: 'desc' },
  });
}

export async function getLatestAnnotation(imageId: string) {
  const image = await getImage(imageId);
  return prisma.imageAnnotation.findFirst({
    where: { clinicalImageId: image.id },
    orderBy: { version: 'desc' },
  });
}