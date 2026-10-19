import { Router } from 'express';
import { prisma } from '../prisma.js';
import { asyncHandler } from '../http.js';

export const healthRouter = Router();

/** GET /health — liveness. Cheap, no dependencies; for the uptime monitor. */
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/** GET /health/ready — readiness. Verifies the database is reachable. */
healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    const ready = Object.values(checks).every((c) => c === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
  }),
);
