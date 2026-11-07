import { Router } from 'express';
import { auditListQuerySchema } from '@clinic/schemas';
import { asyncHandler, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { listAudit, verifyChain } from './audit.service.js';

export const auditRouter = Router();

/*
 * Audit administration is Doctor-only (per SDD 7.3 Audit Trail): only the
 * Doctor can read or verify the trail.
 */
auditRouter.use(requireAuth, requireDoctor);

/** GET /api/audit — paginated, filterable list of audit entries. */
auditRouter.get(
  '/',
  validate(auditListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as import('@clinic/schemas').AuditListQuery;
    const result = await listAudit(query);
    res.json(result);
  }),
);

/** GET /api/audit/verify — walk the chain, report any tamper evidence. */
auditRouter.get(
  '/verify',
  asyncHandler(async (_req, res) => {
    const result = await verifyChain();
    res.json(result);
  }),
);