import { Router } from 'express';
import type { OutreachChannel, OutreachOutcome, Prisma } from '@prisma/client';
import { outreachCreateSchema, outreachQuerySchema } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, conflict, notFound, validate } from '../http.js';
import {
  assertClinicAccess,
  clinicForRead,
  currentUser,
  requireAuth,
} from '../auth/guards.js';
import { logOutreachAttempt } from './outreach.service.js';

export const outreachRouter = Router();

// Doctor and Secretary both work the follow-up list and log call attempts.
outreachRouter.use(requireAuth);

/** GET /api/outreach-logs — contact attempts, filterable by task, patient, channel and outcome. */
outreachRouter.get(
  '/',
  validate(outreachQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      followUpId?: string;
      patientId?: string;
      clinicId?: string;
      channel?: OutreachChannel;
      outcome?: OutreachOutcome;
    };
    const where: Prisma.OutreachLogWhereInput = {
      followUpId: q.followUpId,
      patientId: q.patientId,
      clinicId: clinicForRead(req, q.clinicId),
      channel: q.channel,
      outcome: q.outcome,
    };
    const [items, total] = await Promise.all([
      prisma.outreachLog.findMany({
        where,
        orderBy: { attemptedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.outreachLog.count({ where }),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  }),
);

/**
 * POST /api/outreach-logs — log a phone call attempt (FR-5.5.5). SMS and email
 * rows are written only by the reminder worker, after the consent check.
 */
outreachRouter.post(
  '/',
  validate(outreachCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      followUpId: string;
      outcome: OutreachOutcome;
      patientResponse?: string;
      attemptedAt?: Date;
    };
    const followUp = await prisma.followUp.findUnique({ where: { id: body.followUpId } });
    if (!followUp) throw notFound('Follow-up not found');
    assertClinicAccess(req, followUp.clinicId);
    if (followUp.status !== 'OPEN' && followUp.status !== 'SCHEDULED') {
      throw conflict(`Follow-up is already ${followUp.status.toLowerCase()}`);
    }

    const log = await logOutreachAttempt({
      followUp,
      channel: 'CALL',
      outcome: body.outcome,
      patientResponse: body.patientResponse,
      attemptedAt: body.attemptedAt,
      contactedById: currentUser(req).userId,
    });
    res.status(201).json(log);
  }),
);
