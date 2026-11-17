import { Router, type Request } from 'express';
import type { PatientRightsRequest, Prisma } from '@prisma/client';
import {
  idParamSchema,
  rightsRequestCreateSchema,
  rightsRequestDecisionSchema,
  rightsRequestQuerySchema,
  type RightsRequestCreate,
  type RightsRequestDecision,
  type RightsRequestQuery,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import {
  assertClinicAccess,
  clinicForRead,
  clinicForWrite,
  currentUser,
  requireAuth,
  requireRole,
} from '../auth/guards.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit } from '../audit/record.js';
import { decrypt, decryptOpt, encryptOpt } from '../lib/fieldCrypto.js';
import { formatPatientNumber } from '../patients/patient.normalize.js';

/**
 * Patient rights requests (SDD 7.4, RA 10173 Section 16). A patient may ask for
 * access to, a copy of, or a correction of their record. Either staff role
 * records the request; only the Doctor completes or denies it. Every request
 * and its outcome is written to the audit trail, without the free text.
 */
export const rightsRouter = Router();
rightsRouter.use(requireAuth);

const include = {
  patient: { select: { id: true, patientSeq: true, firstName: true, lastName: true } },
  recordedBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
} satisfies Prisma.PatientRightsRequestInclude;

type Row = Prisma.PatientRightsRequestGetPayload<{ include: typeof include }>;

/** The row as the API returns it: names and free text decrypted, patient number formatted. */
export function toView(row: Row) {
  return {
    ...row,
    details: decryptOpt(row.details),
    decisionNote: decryptOpt(row.decisionNote),
    patient: {
      id: row.patient.id,
      patientNumber: formatPatientNumber(row.patient.patientSeq),
      firstName: decrypt(row.patient.firstName),
      lastName: decrypt(row.patient.lastName),
    },
  };
}

async function loadRequest(req: Request): Promise<PatientRightsRequest> {
  const found = await prisma.patientRightsRequest.findUnique({ where: { id: req.params.id } });
  if (!found) throw notFound('Rights request not found');
  assertClinicAccess(req, found.clinicId);
  return found;
}

/** GET /api/rights-requests?status=&patientId= — newest first. The Secretary sees her active clinic only. */
rightsRouter.get(
  '/',
  validate(rightsRequestQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as RightsRequestQuery;
    const rows = await prisma.patientRightsRequest.findMany({
      where: { clinicId: clinicForRead(req, q.clinicId), patientId: q.patientId, status: q.status },
      include,
      orderBy: { receivedAt: 'desc' },
      take: 200,
    });
    res.json({ items: rows.map(toView) });
  }),
);

/** POST /api/rights-requests — record a request for access, a copy or a correction. */
rightsRouter.post(
  '/',
  validate(rightsRequestCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as RightsRequestCreate;
    const clinicId = clinicForWrite(req, body.clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient || patient.voidedAt) throw notFound('Patient not found');

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.patientRightsRequest.create({
        data: {
          patientId: body.patientId,
          clinicId,
          requestType: body.requestType,
          receivedVia: body.receivedVia,
          details: encryptOpt(body.details || null),
          recordedById: currentUser(req).userId,
        },
        include,
      });
      await recordAudit(
        actorFromRequest(req),
        {
          action: AuditActions.RIGHTS_REQUEST_RECORDED,
          resourceType: 'PatientRightsRequest',
          resourceId: row.id,
          // The details may hold personal or clinical detail, so only note that some were given.
          metadata: {
            patientId: row.patientId,
            clinicId,
            requestType: row.requestType,
            receivedVia: row.receivedVia,
            detailsGiven: Boolean(body.details),
          },
        },
        tx,
      );
      return row;
    });
    res.status(201).json(toView(created));
  }),
);

/** POST /api/rights-requests/:id/decision — the Doctor completes or denies a pending request. */
rightsRouter.post(
  '/:id/decision',
  requireRole('DOCTOR'),
  validate(idParamSchema, 'params'),
  validate(rightsRequestDecisionSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadRequest(req);
    if (existing.status !== 'PENDING') throw conflict('This request has already been decided');
    const { status, decisionNote } = req.body as RightsRequestDecision;
    const doctorId = currentUser(req).userId;

    const updated = await prisma.$transaction(async (tx) => {
      // The status guard makes two simultaneous decisions resolve to one success and one 409.
      const { count } = await tx.patientRightsRequest.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status, decisionNote: encryptOpt(decisionNote), decidedById: doctorId, decidedAt: new Date() },
      });
      if (count === 0) throw conflict('This request has already been decided');
      await recordAudit(
        actorFromRequest(req),
        {
          action:
            status === 'COMPLETED' ? AuditActions.RIGHTS_REQUEST_COMPLETED : AuditActions.RIGHTS_REQUEST_DENIED,
          resourceType: 'PatientRightsRequest',
          resourceId: existing.id,
          metadata: { patientId: existing.patientId, requestType: existing.requestType, status },
        },
        tx,
      );
      return tx.patientRightsRequest.findUniqueOrThrow({ where: { id: existing.id }, include });
    });
    res.json(toView(updated));
  }),
);
