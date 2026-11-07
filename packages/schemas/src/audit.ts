import { z } from 'zod';

/** Query params for GET /api/audit. All filters are optional and combinable. */
export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  userId: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

/** Shape of an audit entry returned by the admin API. */
export const auditEntrySchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  userEmail: z.string().nullable(),
  userRole: z.string().nullable(),
  action: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: z.unknown(),
  createdAt: z.date(),
  previousHash: z.string(),
  entryHash: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** Response of GET /api/audit/verify. */
export const auditVerifyResultSchema = z.object({
  ok: z.boolean(),
  total: z.number().int(),
  breakages: z.array(
    z.object({
      id: z.string(),
      createdAt: z.date(),
      reason: z.enum(['wrong_previous_hash', 'wrong_entry_hash']),
    }),
  ),
});
export type AuditVerifyResult = z.infer<typeof auditVerifyResultSchema>;