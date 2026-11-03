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

    const updated = await prisma.patientConsent.update({
      where: { id: consent.id },
      data: { withdrawnAt: new Date(), withdrawnById: currentUser(req).userId },
    });
    res.json(updated);
  }),
);
