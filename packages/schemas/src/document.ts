import { z } from 'zod';
import { idSchema } from './common.js';

export const documentTypeSchema = z.enum([
  'PRESCRIPTION',
  'MEDICAL_CERTIFICATE',
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const documentRequestStatusSchema = z.enum([
  'REQUESTED',
  'PENDING',
  'GENERATING',
  'READY',
  'FAILED',
]);
export type DocumentRequestStatus = z.infer<typeof documentRequestStatusSchema>;

/* ----------------------------- Template payloads ----------------------------- */

/** Fields rendered into the prescription PDF template. */
export const prescriptionPayloadSchema = z.object({
  patientName: z.string().min(1).max(200),
  patientAge: z.number().int().min(0).max(130).optional(),
  clinicName: z.string().min(1).max(200),
  clinicAddress: z.string().max(300).optional(),
  prescriberName: z.string().min(1).max(200),
  prescriberLicense: z.string().max(100).optional(),
  issuedOn: z.coerce.date(),
  items: z
    .array(
      z.object({
        drug: z.string().min(1).max(200),
        dosage: z.string().max(100),
        frequency: z.string().max(100),
        duration: z.string().max(100),
        notes: z.string().max(300).optional(),
      }),
    )
    .min(1, 'at least one prescription item is required'),
});
export type PrescriptionPayload = z.infer<typeof prescriptionPayloadSchema>;

/** Fields rendered into the medical-certificate PDF template. */
export const medicalCertificatePayloadSchema = z.object({
  patientName: z.string().min(1).max(200),
  clinicName: z.string().min(1).max(200),
  clinicAddress: z.string().max(300).optional(),
  prescriberName: z.string().min(1).max(200),
  prescriberLicense: z.string().max(100).optional(),
  issuedOn: z.coerce.date(),
  diagnosis: z.string().min(1).max(1000),
  recommendation: z.string().max(1000).optional(),
  restFromDate: z.coerce.date().optional(),
  restToDate: z.coerce.date().optional(),
});
export type MedicalCertificatePayload = z.infer<
  typeof medicalCertificatePayloadSchema
>;

/** Body of POST /api/documents/:id/send. An email address is required for EMAIL. */
export const documentSendSchema = z
  .object({
    via: z.enum(['EMAIL', 'PRINT']),
    email: z.string().email().optional(),
  })
  .refine((v) => v.via !== 'EMAIL' || v.email, {
    message: 'email is required when sending by EMAIL',
    path: ['email'],
  });
export type DocumentSend = z.infer<typeof documentSendSchema>;

/* ----------------------------- Document request ------------------------------ */

/** A safety alert the Doctor acknowledged before issuing a prescription. */
export const safetyAcknowledgementSchema = z.object({
  drug: z.string().max(200),
  message: z.string().max(500),
  reason: z.string().max(500).optional(),
});

/** Optional links shared by both document types. */
const requestLinks = {
  clinicId: idSchema,
  patientId: idSchema,
  /** Fulfil a REQUESTED request logged by staff instead of creating a new one. */
  requestId: idSchema.optional(),
  /** Issue a new version of this signed document. */
  previousVersionId: idSchema.optional(),
  safetyAcknowledgements: z.array(safetyAcknowledgementSchema).max(50).optional(),
};

/**
 * A request to generate a document. The `payload` shape depends on `type`
 * and is validated per-type server-side before rendering.
 */
export const documentRequestCreateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PRESCRIPTION'), ...requestLinks, payload: prescriptionPayloadSchema }),
  z.object({ type: z.literal('MEDICAL_CERTIFICATE'), ...requestLinks, payload: medicalCertificatePayloadSchema }),
]);
export type DocumentRequestCreate = z.infer<typeof documentRequestCreateSchema>;

export const documentRequestChannelSchema = z.enum(['PHONE', 'IN_PERSON', 'EMAIL']);

/** S15 "New Request": staff log what a patient asked for; the Doctor prepares it later. */
export const documentRequestIntakeSchema = z.object({
  clinicId: idSchema,
  patientId: idSchema,
  type: documentTypeSchema,
  requestedVia: documentRequestChannelSchema,
  notes: z.string().max(1000).optional(),
});
export type DocumentRequestIntake = z.infer<typeof documentRequestIntakeSchema>;

/** Signing asks the Doctor to re-enter their password. */
export const documentSignSchema = z.object({ password: z.string().min(1).max(256) });

/** S15 list: one tab, one page. */
export const documentQueueQuerySchema = z.object({
  clinicId: idSchema,
  tab: z.enum(['all', 'queue', 'ready', 'delivered']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});
export type DocumentQueueQuery = z.infer<typeof documentQueueQuerySchema>;
