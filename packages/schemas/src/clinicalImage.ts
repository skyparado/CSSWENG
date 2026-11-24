import { z } from 'zod';

/* ------------------------------- Enums ----------------------------------- */

export const imageStatusEnum = z.enum(['ACTIVE', 'DELETED']);
export type ImageStatus = z.infer<typeof imageStatusEnum>;

/**
 * MIME types the API accepts for clinical images (QA 7).
 *
 * JPEG and PNG are what a fundus camera and a phone produce; PDF is here
 * because outside reports arrive that way. Nothing else: webp and gif were
 * accepted before and have no place in a clinical record, and gif in
 * particular is lossy in ways that matter for an image a diagnosis rests on.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** 20 MB upload cap (QA 7). Matches the multer limit in the route. */
export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/* ------------------------------- Payloads -------------------------------- */

export const eyeTemplateTypes = ['anterior-od', 'anterior-os', 'posterior-od', 'posterior-os'] as const;
export const eyeTemplateSchema = z.enum(eyeTemplateTypes);
export type EyeTemplate = z.infer<typeof eyeTemplateSchema>;
export const eyeTemplateLabels: Record<EyeTemplate, string> = {
  'anterior-od': 'Anterior segment · Right eye (OD)',
  'anterior-os': 'Anterior segment · Left eye (OS)',
  'posterior-od': 'Fundus · Right eye (OD)',
  'posterior-os': 'Fundus · Left eye (OS)',
};

export const imageContextSchema = z.object({
  patientId: z.string().min(1),
  visitId: z.string().min(1).optional(),
});
export type ImageContext = z.infer<typeof imageContextSchema>;
export const imageUploadMetadataSchema = imageContextSchema.extend({
  appointmentId: z.string().min(1).optional(),
  walkInKey: z.string().uuid().optional(),
  caption: z.string().trim().max(200).optional(),
});
export type ImageUploadMetadata = z.infer<typeof imageUploadMetadataSchema>;

export const imageUpdateSchema = z.object({
  caption: z.string().trim().max(200).nullable(),
});
export type ImageUpdate = z.infer<typeof imageUpdateSchema>;

export const imageListQuerySchema = imageContextSchema.extend({
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

const coordinates = z.array(z.number().finite()).min(4).refine(p => p.length % 2 === 0);
const style = { color: z.string().regex(/^#[0-9a-f]{3,8}$/i), width: z.number().positive().max(256) };
export const drawingSchema = z.object({
  schema: z.literal(1), width: z.number().int().positive(), height: z.number().int().positive(),
  shapes: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pen'), points: coordinates, ...style }),
    z.object({ kind: z.literal('arrow'), points: z.array(z.number().finite()).length(4), ...style }),
    z.object({ kind: z.literal('text'), x: z.number().finite(), y: z.number().finite(), text: z.string().min(1).max(60),
      color: style.color, fontSize: z.number().positive().max(512) }),
  ])),
});
export const templateCommitSchema = imageContextSchema.extend({
  visitId: z.string().min(1), templateType: eyeTemplateSchema,
  commitKey: z.string().uuid(), konvaData: drawingSchema,
});

/* ------------------------------- Responses -------------------------------- */

export const clinicalImageSchema = z.object({
  id: z.string(),
  patientId: z.string(),
  appointmentId: z.string().nullable(),
  visitId: z.string().nullable(),
  templateType: eyeTemplateSchema.nullable(),
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
