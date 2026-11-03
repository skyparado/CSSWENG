import { z } from 'zod';
import { idSchema } from './common.js';

export const documentTypeSchema = z.enum([
  'PRESCRIPTION',
  'MEDICAL_CERTIFICATE',
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const documentRequestStatusSchema = z.enum([
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

/**
 * A request to generate a document. The `payload` shape depends on `type`
 * and is validated per-type server-side before rendering.
 */
export const documentRequestCreateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('PRESCRIPTION'),
    clinicId: idSchema,
    patientId: idSchema,
    payload: prescriptionPayloadSchema,
  }),
  z.object({
    type: z.literal('MEDICAL_CERTIFICATE'),
    clinicId: idSchema,
    patientId: idSchema,
    payload: medicalCertificatePayloadSchema,
  }),
]);
export type DocumentRequestCreate = z.infer<typeof documentRequestCreateSchema>;
