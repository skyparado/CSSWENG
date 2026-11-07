import { z } from 'zod';

/* ------------------------------- Enums ----------------------------------- */

export const tabletIntakeStatusEnum = z.enum([
  'ACTIVE',
  'SUBMITTED',
  'CANCELLED',
  'EXPIRED',
]);
export type TabletIntakeStatus = z.infer<typeof tabletIntakeStatusEnum>;

/** How long a fresh session stays usable before it auto-expires. */
export const INTAKE_SESSION_TTL_MINUTES = 30;

/* ------------------------------- Payloads -------------------------------- */

/** Secretary creates a session for a specific clinic. */
export const intakeSessionCreateSchema = z.object({
  clinicId: z.string().min(1),
});
export type IntakeSessionCreate = z.infer<typeof intakeSessionCreateSchema>;

/**
 * The intake form the patient fills on the tablet. Minimal required fields
 * (name) with wider optional fields; the full form is retained in rawPayload
 * for later migration into dedicated Patient columns.
 */
export const intakeFormSubmitSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.coerce.date().optional(),
  sex: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional(),
  mobileNumber: z.string().trim().min(1).max(32).optional(),
  email: z.string().email().max(254).optional(),
  address: z.string().trim().max(500).optional(),
  medicalHistory: z.string().trim().max(5000).optional(),
  allergies: z.string().trim().max(2000).optional(),
  medications: z.string().trim().max(2000).optional(),
  // Consent flags the patient ticks on the tablet. Required to be true to submit.
  consents: z.object({
    treatment: z.literal(true),
    dataPrivacy: z.literal(true),
    photoConsent: z.boolean().optional(),
  }),
});
export type IntakeFormSubmit = z.infer<typeof intakeFormSubmitSchema>;

/* ------------------------------- Responses -------------------------------- */

/**
 * Shape returned to the tablet on GET /sessions/:token. Deliberately omits the
 * token itself (the tablet already has it) and any secretary identifiers.
 */
export const tabletIntakeSessionPublicSchema = z.object({
  id: z.string(),
  status: tabletIntakeStatusEnum,
  clinic: z.object({
    id: z.string(),
    name: z.string(),
  }),
  expiresAt: z.date(),
  createdAt: z.date(),
  submittedAt: z.date().nullable(),
});
export type TabletIntakeSessionPublic = z.infer<typeof tabletIntakeSessionPublicSchema>;

/**
 * Shape returned to the secretary on POST /sessions. Carries the token the
 * secretary will enter / scan onto the tablet, plus the expiry so the UI can
 * show a countdown.
 */
export const tabletIntakeSessionAdminSchema = z.object({
  id: z.string(),
  token: z.string(),
  clinicId: z.string(),
  status: tabletIntakeStatusEnum,
  expiresAt: z.date(),
  createdAt: z.date(),
});
export type TabletIntakeSessionAdmin = z.infer<typeof tabletIntakeSessionAdminSchema>;