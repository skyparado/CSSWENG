import { Router } from 'express';
import {
  consentCreateSchema,
  consentQuerySchema,
  consentWithdrawSchema,
  idParamSchema,
} from '@clinic/schemas';
import type { ConsentType, ReminderChannel, ConsentCaptureMethod } from '@prisma/client';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import { currentUser, requireAuth } from '../auth/guards.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit } from '../audit/record.js';

export const consentsRouter = Router();

// Consent is captured at registration or intake, so both staff roles may record it.
consentsRouter.use(requireAuth);

/** GET /api/consents?patientId= — a patient's consent history, newest first. */
consentsRouter.get(
  '/',
  validate(consentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { patientId: string; consentType?: ConsentType };
    const items = await prisma.patientConsent.findMany({
      where: { patientId: q.patientId, consentType: q.consentType },
      orderBy: { consentedAt: 'desc' },
    });
    res.json({ items });
  }),
);

/** POST /api/consents — record a grant or refusal. */
consentsRouter.post(
  '/',
  validate(consentCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      patientId: string;
      consentType: ConsentType;
      channel?: ReminderChannel;
      isGranted: boolean;
      captureMethod: ConsentCaptureMethod;
      consentVersion?: string;
    };
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    const consent = await prisma.patientConsent.create({
      data: { ...body, recordedById: currentUser(req).userId },
    });
    res.status(201).json(consent);
  }),
);

/** POST /api/consents/:id/withdraw — withdraw a consent; no reminders are sent after this. */
consentsRouter.post(
  '/:id/withdraw',
  validate(idParamSchema, 'params'),
  validate(consentWithdrawSchema),
  asyncHandler(async (req, res) => {
    const consent = await prisma.patientConsent.findUnique({ where: { id: req.params.id } });
    if (!consent) throw notFound('Consent not found');
    if (consent.withdrawnAt) throw conflict('Consent already withdrawn');

    // Withdraw and audit in one transaction. The `withdrawnAt: null` guard makes
    // two simultaneous withdrawals resolve to one success and one 409.
    const updated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.patientConsent.updateMany({
        where: { id: consent.id, withdrawnAt: null },
        data: { withdrawnAt: new Date(), withdrawnById: currentUser(req).userId },
      });
      if (count === 0) throw conflict('Consent already withdrawn');

      await recordAudit(
        actorFromRequest(req),
        {
          action: AuditActions.CONSENT_WITHDRAWN,
          resourceType: 'PatientConsent',
          resourceId: consent.id,
          metadata: {
            patientId: consent.patientId,
            consentType: consent.consentType,
            channel: consent.channel,
            // The free-text reason may hold personal detail, so only note that one was given.
            reasonGiven: Boolean((req.body as { reason?: string }).reason),
          },
        },
        tx,
      );
      return tx.patientConsent.findUniqueOrThrow({ where: { id: consent.id } });
    });
    res.json(updated);
  }),
);
