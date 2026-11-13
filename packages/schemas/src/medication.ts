import { z } from 'zod';
import { idSchema } from './common.js';
import { calendarDateSchema } from './followup.js';

/* -------------------------------- Medications -------------------------------- */

export const medicationStatusSchema = z.enum(['ACTIVE', 'ON_HOLD', 'DISCONTINUED']);
export type MedicationStatus = z.infer<typeof medicationStatusSchema>;

export const medicationSourceSchema = z.enum([
  'PRESCRIBED_HERE',
  'PATIENT_REPORTED',
  'OTHER_DOCTOR',
  'OTC',
]);
export type MedicationSource = z.infer<typeof medicationSourceSchema>;

const medicationFields = {
  medicationName: z.string().min(1).max(150),
  strength: z.string().max(50).optional(),
  dose: z.string().min(1).max(50),
  frequency: z.string().min(1).max(50),
  route: z.string().min(1).max(30),
  instructions: z.string().max(500).optional(),
  indication: z.string().max(200).optional(),
  startDate: calendarDateSchema,
  endDate: calendarDateSchema.optional(),
  status: medicationStatusSchema.default('ACTIVE'),
  discontinuationReason: z.string().max(255).optional(),
  prescribingDoctor: z.string().min(1).max(150),
  source: medicationSourceSchema.default('PRESCRIBED_HERE'),
  documentId: idSchema.optional(),
};

/** FR-5.6.3: a discontinued medication must say why. */
function requireDiscontinuationReason(
  m: { status?: MedicationStatus; discontinuationReason?: string },
  ctx: z.RefinementCtx,
) {
  if (m.status === 'DISCONTINUED' && !m.discontinuationReason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discontinuationReason'],
      message: 'discontinuationReason is required when status is DISCONTINUED',
    });
  }
}

function requireEndAfterStart(
  m: { startDate?: string; endDate?: string },
  ctx: z.RefinementCtx,
) {
  if (m.startDate && m.endDate && m.endDate < m.startDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'endDate must not be before startDate',
    });
  }
}

/**
 * One safety alert the Doctor saw and accepts. Alerts are matched by what they
 * are about (type + the allergy/medication that triggered them); the text the
 * server stores is its own, never the client's.
 */
export const acknowledgedAlertSchema = z.object({
  type: z.enum(['ALLERGY_CONFLICT', 'DUPLICATE_MEDICATION']),
  relatedId: idSchema,
});
export type AcknowledgedAlert = z.infer<typeof acknowledgedAlertSchema>;

/**
 * Doctor adds a medication. If the safety check finds an allergy conflict or a
 * duplicate, the request is refused with the alerts unless the doctor
 * resubmits with `acknowledgeAlerts: true` (FR-5.6.7).
 */
export const medicationCreateSchema = z
  .object({
    patientId: idSchema,
    clinicId: idSchema.optional(),
    ...medicationFields,
    /** Blanket "I accept every alert the server raises for this save". */
    acknowledgeAlerts: z.boolean().default(false),
    /** The specific alerts accepted; when sent, every alert raised must be listed. */
    acknowledgedAlerts: z.array(acknowledgedAlertSchema).max(50).optional(),
    /** Why the Doctor is proceeding despite the alerts (SDD 5.2); optional. */
    acknowledgementReason: z.string().trim().max(255).optional(),
  })
  .superRefine((m, ctx) => {
    requireDiscontinuationReason(m, ctx);
    requireEndAfterStart(m, ctx);
  });
export type MedicationCreate = z.infer<typeof medicationCreateSchema>;

/**
 * Change a medication. History is preserved: the API inserts a new version row
 * that supersedes the old one instead of editing it in place (FR-5.6.4).
 */
export const medicationUpdateSchema = z
  .object({
    medicationName: medicationFields.medicationName.optional(),
    strength: medicationFields.strength,
    dose: medicationFields.dose.optional(),
    frequency: medicationFields.frequency.optional(),
    route: medicationFields.route.optional(),
    instructions: medicationFields.instructions,
    indication: medicationFields.indication,
    startDate: medicationFields.startDate.optional(),
    endDate: medicationFields.endDate,
    status: medicationStatusSchema.optional(),
    discontinuationReason: medicationFields.discontinuationReason,
    prescribingDoctor: medicationFields.prescribingDoctor.optional(),
    source: medicationSourceSchema.optional(),
    acknowledgeAlerts: z.boolean().default(false),
    acknowledgedAlerts: z.array(acknowledgedAlertSchema).max(50).optional(),
    acknowledgementReason: z.string().trim().max(255).optional(),
  })
  .superRefine((m, ctx) => {
    requireDiscontinuationReason(m, ctx);
    requireEndAfterStart(m, ctx);
  });
export type MedicationUpdate = z.infer<typeof medicationUpdateSchema>;

export const medicationQuerySchema = z.object({
  patientId: idSchema,
  status: medicationStatusSchema.optional(),
  /** `true` returns superseded versions too (the dated history). */
  includeHistory: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type MedicationQuery = z.infer<typeof medicationQuerySchema>;

/** Dry-run a medication against the patient's allergies and current list. */
export const medicationCheckSchema = z.object({
  patientId: idSchema,
  medicationName: medicationFields.medicationName,
  /** The row being replaced, so it is not flagged as its own duplicate. */
  excludeMedicationId: idSchema.optional(),
});
export type MedicationCheck = z.infer<typeof medicationCheckSchema>;

/* ---------------------------------- Allergies --------------------------------- */

export const allergySeveritySchema = z.enum(['MILD', 'MODERATE', 'SEVERE']);
export type AllergySeverity = z.infer<typeof allergySeveritySchema>;

export const allergyCreateSchema = z.object({
  patientId: idSchema,
  clinicId: idSchema.optional(),
  allergenName: z.string().min(1).max(100),
  reaction: z.string().max(150).optional(),
  severity: allergySeveritySchema.optional(),
});
export type AllergyCreate = z.infer<typeof allergyCreateSchema>;

export const allergyUpdateSchema = z.object({
  allergenName: z.string().min(1).max(100).optional(),
  reaction: z.string().max(150).optional(),
  severity: allergySeveritySchema.optional(),
});
export type AllergyUpdate = z.infer<typeof allergyUpdateSchema>;

export const allergyQuerySchema = z.object({
  patientId: idSchema,
  includeVoided: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type AllergyQuery = z.infer<typeof allergyQuerySchema>;

/** Allergies are never hard-deleted; a removed entry is voided with a reason. */
export const allergyVoidSchema = z.object({
  reason: z.string().min(1).max(255),
});
export type AllergyVoid = z.infer<typeof allergyVoidSchema>;

/* ------------------------------- Safety alerts -------------------------------- */

export const safetyAlertTypeSchema = z.enum([
  'ALLERGY_CONFLICT',
  'DUPLICATE_MEDICATION',
]);
export type SafetyAlertType = z.infer<typeof safetyAlertTypeSchema>;

export interface SafetyAlert {
  type: SafetyAlertType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  /** The allergy or existing medication that triggered the alert. */
  relatedId: string;
}
