import { z } from 'zod';

/* ------------------------------- Enums ----------------------------------- */

export const imageStatusEnum = z.enum(['ACTIVE', 'DELETED']);
export type ImageStatus = z.infer<typeof imageStatusEnum>;

/** MIME types the API accepts for clinical images. */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** 10 MB upload cap. Matches the multer limit in the route. */
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

/* ------------------------------- Payloads -------------------------------- */

export const imageUploadMetadataSchema = z.object({
  patientId: z.string().min(1),
  appointmentId: z.string().min(1).optional(),
  caption: z.string().trim().max(500).optional(),
});
export type ImageUploadMetadata = z.infer<typeof imageUploadMetadataSchema>;

export const imageUpdateSchema = z.object({
  caption: z.string().trim().max(500).nullable(),
});
export type ImageUpdate = z.infer<typeof imageUpdateSchema>;

export const imageListQuerySchema = z.object({
  patientId: z.string().min(1).optional(),
  appointmentId: z.string().min(1).optional(),
  status: imageStatusEnum.default('ACTIVE'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ImageListQuery = z.infer<typeof imageListQuerySchema>;

/* ------------------------------- Annotations ------------------------------ */

export const konvaDataSchema = z.record(z.unknown());

export const annotationSaveSchema = z.object({
  konvaData: konvaDataSchema,
});
export type AnnotationSave = z.infer<typeof annotationSaveSchema>;

/* ------------------------------- Responses -------------------------------- */

export const clinicalImageSchema = z.object({
  id: z.string(),
  patientId: z.string(),
  appointmentId: z.string().nullable(),
  uploadedById: z.string().nullable(),
  storageKey: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  caption: z.string().nullable(),
  status: imageStatusEnum,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ClinicalImageDTO = z.infer<typeof clinicalImageSchema>;

export const imageAnnotationSchema = z.object({
  id: z.string(),
  clinicalImageId: z.string(),
  createdById: z.string().nullable(),
  version: z.number().int(),
  konvaData: z.unknown(),
  createdAt: z.date(),
});
export type ImageAnnotationDTO = z.infer<typeof imageAnnotationSchema>;