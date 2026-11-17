import { z } from 'zod';
import { idSchema } from './common.js';

/* --------------------------- Patient rights requests -------------------------- */
// SDD 7.4 "Rights of the patient" (RA 10173, Section 16): a patient may ask for
// access to, a copy of, or a correction of their record. Staff record the
// request; the Doctor reviews it and completes or denies it.

export const rightsRequestTypeSchema = z.enum(['ACCESS', 'COPY', 'CORRECTION']);
export type RightsRequestType = z.infer<typeof rightsRequestTypeSchema>;

export const rightsRequestChannelSchema = z.enum(['IN_PERSON', 'PHONE', 'EMAIL', 'WRITTEN']);
export type RightsRequestChannel = z.infer<typeof rightsRequestChannelSchema>;

export const rightsRequestStatusSchema = z.enum(['PENDING', 'COMPLETED', 'DENIED']);
export type RightsRequestStatus = z.infer<typeof rightsRequestStatusSchema>;

/** POST /api/rights-requests: record what the patient asked for. */
export const rightsRequestCreateSchema = z.object({
  patientId: idSchema,
  /** The Doctor may file it under another clinic; the Secretary always uses the active one. */
  clinicId: idSchema.optional(),
  requestType: rightsRequestTypeSchema,
  receivedVia: rightsRequestChannelSchema,
  details: z.string().trim().max(2000).optional(),
});
export type RightsRequestCreate = z.infer<typeof rightsRequestCreateSchema>;

/** POST /api/rights-requests/:id/decision: the Doctor completes or denies a pending request. */
export const rightsRequestDecisionSchema = z.object({
  status: z.enum(['COMPLETED', 'DENIED']),
  /** What was given or corrected, or why the request was denied. Required either way. */
  decisionNote: z.string().trim().min(1, 'a note is required').max(2000),
});
export type RightsRequestDecision = z.infer<typeof rightsRequestDecisionSchema>;

/** GET /api/rights-requests */
export const rightsRequestQuerySchema = z.object({
  clinicId: idSchema.optional(),
  patientId: idSchema.optional(),
  status: rightsRequestStatusSchema.optional(),
});
export type RightsRequestQuery = z.infer<typeof rightsRequestQuerySchema>;
