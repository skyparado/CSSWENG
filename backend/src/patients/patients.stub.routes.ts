import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { asyncHandler, validate } from '../http.js';
import { requireAuth } from '../auth/middleware.js';

/**
 * shortcut: name search over the placeholder Patient model so booking and the
 * document editor can pick a patient; delete this file when Dev 2's
 * patient.routes.ts (same path, same `{ items }` shape) is merged.
 */
export const patientsStubRouter = Router();

patientsStubRouter.use(requireAuth);

patientsStubRouter.get(
  '/',
  validate(z.object({ q: z.string().trim().max(150).default('') }), 'query'),
  asyncHandler(async (req, res) => {
    const { q } = req.query as unknown as { q: string };
    const contains = { contains: q, mode: 'insensitive' as const };
    const items = await prisma.patient.findMany({
      where: q ? { OR: [{ firstName: contains }, { lastName: contains }] } : undefined,
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { lastName: 'asc' },
      take: 20,
    });
    res.json({ items });
  }),
);
